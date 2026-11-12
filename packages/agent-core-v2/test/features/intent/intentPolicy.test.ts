import { describe, expect, it } from 'vitest';
import { IntentTool } from '#/features/intent/intentTools';
import type { IIntentService } from '#/features/intent/intentService';
import { estimateIntentRequestTokens, intentBudgetLevel, reserveIntentRequest, settleIntentUsage } from '#/features/intent/intentBudget';
import { compileToolArgsValidator, validateToolArgs } from '#/tool/args-validator';

import {
  applyIntentUpdate, fingerprint, intentAllowsEffects, intentNeedsReview, intentProjection,
} from '#/features/intent/intentPolicy';
import {
  AnalysisRunSchema, createIntentTask, emptyIntentState, IntentStateSchema,
  type IntentItem, type IntentState, type IntentUpdate, type IntentUsage,
} from '#/features/intent/intentState';

function state(): IntentState {
  const current = createIntentTask('task-1', {
    id: 'user-1', kind: 'user_input',
    text: 'Build a report. Keep exports unchanged. Results must be verified.',
  });
  current.sourceRefs.push(
    { id: 'tool-1', kind: 'tool_result', text: 'All tests passed.' },
    { id: 'child-1', kind: 'subagent_finding', text: 'The current export is supported.' },
  );
  return { ...emptyIntentState(), current };
}

function item(overrides: Partial<IntentItem> = {}): IntentItem {
  return {
    id: 'goal', kind: 'goal', text: 'Build a report.', certainty: 'explicit',
    scope: 'current task', sources: [{ sourceId: 'user-1', quote: 'Build a report.' }],
    status: 'active', ...overrides,
  };
}

function update(current: IntentState, overrides: Partial<IntentUpdate> = {}): IntentUpdate {
  return {
    operationId: 'operation-1', intentId: current.current!.intentId,
    generation: 'view-1', expectedRevision: current.current!.revision, ...overrides,
  };
}

function readyState(): IntentState {
  const current = state();
  current.current!.items = [
    item(),
    item({ id: 'acceptance', kind: 'acceptance', text: 'Results must be verified.',
      sources: [{ sourceId: 'user-1', quote: 'Results must be verified.' }], verification: 'unverified' }),
  ];
  current.current!.handledInputs = ['user-1'];
  current.current!.executionPreparation = { modules: [], nextActions: ['Implement the report'], validation: ['Run tests'] };
  current.current!.analysis = AnalysisRunSchema.parse({
    id: 'analysis-1', requestId: 'deep-1', status: 'analyzing', boundRevision: 0,
    budget: {}, ledger: [], pendingQuestions: [],
  });
  return current;
}

describe('Intent state and update policy', () => {
  it('normalizes object order and optional values when fingerprinting', () => {
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
    expect(fingerprint(undefined)).not.toBe(fingerprint(null));
  });

  it('defaults persisted active time without accepting an unknown schema version', () => {
    expect(readyState().current!.analysis!.activeMs).toBe(0);
    expect(() => IntentStateSchema.parse({ ...state(), schemaVersion: 2 })).toThrow();
  });

  it.each(['tool-1', 'child-1'])('does not treat %s as user confirmation', (sourceId) => {
    const current = state();
    const source = current.current!.sourceRefs.find((entry) => entry.id === sourceId)!;
    expect(() => applyIntentUpdate(current, update(current, {
      items: [item({ sources: [{ sourceId, quote: source.text }] })],
    }), 'view-1', 'task-2')).toThrow('invalid_source');
  });

  it.each([
    { sourceId: 'missing', quote: 'Build a report.' },
    { sourceId: 'user-1', quote: 'Delete the exports.' },
    { sourceId: 'user-1', quote: ' ' },
  ])('rejects missing or mismatched source quotations', (source) => {
    const current = state();
    expect(() => applyIntentUpdate(current, update(current, {
      items: [item({ sources: [source] })],
    }), 'view-1', 'task-2')).toThrow('invalid_source');
  });

  it('preserves an explicit requirement against in-place edits', () => {
    const current = state();
    current.current!.items = [item()];
    expect(() => applyIntentUpdate(current, update(current, {
      items: [item({ text: 'Build a different product.' })],
    }), 'view-1', 'task-2')).toThrow('Preserve explicit');
    expect(current.current!.items).toEqual([item()]);
  });

  it('accepts execution evidence without changing an explicit acceptance requirement', () => {
    const current = readyState();
    const acceptance = current.current!.items[1]!;
    const result = applyIntentUpdate(current, update(current, {
      items: [{ ...acceptance, verification: 'passed',
        evidence: [{ sourceId: 'tool-1', quote: 'All tests passed.' }] }],
    }), 'view-1', 'task-2');
    expect(result.state.current!.items[1]).toMatchObject({
      certainty: 'explicit', verification: 'passed', text: acceptance.text,
    });
  });

  it.each([undefined, [{ sourceId: 'user-1', quote: 'Results must be verified.' }]])(
    'rejects an acceptance result without execution evidence', (evidence) => {
      const current = readyState();
      expect(() => applyIntentUpdate(current, update(current, {
        items: [{ ...current.current!.items[1]!, verification: 'passed', evidence }],
      }), 'view-1', 'task-2')).toThrow('invalid_source');
    },
  );

  it('preserves the replaced requirement and its source', () => {
    const current = state();
    current.current!.items = [item()];
    current.current!.sourceRefs.push({ id: 'user-2', kind: 'user_input', text: 'Build a chart instead.' });
    const result = applyIntentUpdate(current, update(current, {
      items: [item({ id: 'new-goal', text: 'Build a chart instead.', supersedes: 'goal',
        sources: [{ sourceId: 'user-2', quote: 'Build a chart instead.' }] })],
    }), 'view-1', 'task-2');
    expect(result.state.current!.items).toEqual([
      { ...item(), status: 'superseded' },
      expect.objectContaining({ id: 'new-goal', supersedes: 'goal', status: 'active' }),
    ]);
  });

  it('acknowledges a no-change review without increasing the business revision', () => {
    const current = state();
    const result = applyIntentUpdate(current, update(current, {
      handledInputs: ['user-1'], reviewReason: 'The request is already represented.',
    }), 'view-1', 'task-2');
    expect(result.result.revision).toBe(0);
    expect(result.state.current!.handledInputs).toEqual(['user-1']);
    expect(result.state.current!.reviews).toHaveLength(1);
    expect(intentNeedsReview(result.state.current)).toBe(false);
  });

  it('does not acknowledge unobserved inputs or reviews without a reason', () => {
    const current = state();
    expect(() => applyIntentUpdate(current, update(current, {
      handledInputs: ['missing'], reviewReason: 'No change.',
    }), 'view-1', 'task-2')).toThrow('invalid_source');
    expect(() => applyIntentUpdate(current, update(current, {
      handledInputs: ['user-1'],
    }), 'view-1', 'task-2')).toThrow('Explain the requirement change');
  });

  it('returns the original operation result after newer operations without applying it again', () => {
    const current = state();
    const firstInput = update(current, { items: [item()] });
    const first = applyIntentUpdate(current, firstInput, 'view-1', 'task-2');
    const second = applyIntentUpdate(first.state, update(first.state, {
      operationId: 'operation-2', lifecycle: 'ended',
    }), 'view-1', 'task-2');
    const retry = applyIntentUpdate(second.state, firstInput, 'view-1', 'task-2');
    expect(retry.state).toBe(second.state);
    expect(retry.result).toBe(first.result);
    expect(retry.state.current!.lifecycle).toBe('ended');
    expect(retry.state.operations).toHaveLength(2);
  });

  it('rejects conflicting operation IDs and new operations with stale revisions', () => {
    const current = state();
    const initial = update(current, { items: [item()] });
    const first = applyIntentUpdate(current, initial, 'view-1', 'task-2');
    expect(() => applyIntentUpdate(first.state, { ...initial, lifecycle: 'ended' },
      'view-1', 'task-2')).toThrow('operation_conflict');
    expect(() => applyIntentUpdate(first.state, { ...initial, operationId: 'operation-2' },
      'view-1', 'task-2')).toThrow('stale_version');
  });

  it('rejects an old generation before looking up a matching operation ID', () => {
    const current = state();
    const initial = update(current, { items: [item()] });
    const first = applyIntentUpdate(current, initial, 'view-1', 'task-2');
    expect(() => applyIntentUpdate(first.state, initial, 'view-2', 'task-2')).toThrow('stale_version');
    expect(() => applyIntentUpdate(first.state, { ...initial, intentId: 'old-task' },
      'view-1', 'task-2')).toThrow('stale_version');
  });

  it('marks analysis ready independently of task completion and acceptance verification', () => {
    const current = readyState();
    const result = applyIntentUpdate(current, update(current, {
      completeAnalysisRunId: 'analysis-1',
    }), 'view-1', 'task-2');
    expect(result.state.current).toMatchObject({
      lifecycle: 'active', analysis: { status: 'ready', boundRevision: 1 },
    });
    expect(result.state.current!.items[1]!.verification).toBe('unverified');
    expect(intentAllowsEffects(result.state.current)).toBe(true);
  });

  it.each(['unknown', 'input', 'question', 'preparation', 'goal', 'acceptance', 'run'])(
    'keeps analysis blocked when completion lacks %s readiness', (missing) => {
      const current = readyState();
      const task = current.current!;
      if (missing === 'unknown') task.items.push(item({
        id: 'unknown', kind: 'unknown', certainty: 'unknown', blocking: true,
      }));
      if (missing === 'input') task.handledInputs = [];
      if (missing === 'question') task.analysis!.pendingQuestions = ['question-1'];
      if (missing === 'preparation') task.executionPreparation = undefined;
      if (missing === 'goal') task.items = task.items.filter((entry) => entry.kind !== 'goal');
      if (missing === 'acceptance') task.items = task.items.filter((entry) => entry.kind !== 'acceptance');
      if (missing === 'run') task.analysis!.status = 'interrupted';
      const before = structuredClone(current);
      expect(() => applyIntentUpdate(current, update(current, {
        completeAnalysisRunId: 'analysis-1',
      }), 'view-1', 'task-2')).toThrow('invalid_transition');
      expect(current).toEqual(before);
    },
  );

  it('blocks unresolved active unknowns in default tracking and allows resolved or superseded ones', () => {
    const current = state().current!;
    current.handledInputs = ['user-1'];
    current.items = [item({ id: 'unknown', kind: 'unknown', certainty: 'unknown', blocking: true })];
    expect(intentAllowsEffects(current)).toBe(false);
    current.items[0]!.resolution = 'Keep the current behavior until clarified.';
    expect(intentAllowsEffects(current)).toBe(true);
    current.items[0]!.resolution = undefined;
    current.items[0]!.status = 'superseded';
    expect(intentAllowsEffects(current)).toBe(true);
  });

  it('only invalidates findings and decisions associated with a changed requirement', () => {
    const current = state();
    current.current!.items = [item({ id: 'constraint', kind: 'constraint', certainty: 'assumption' })];
    for (const requirementId of ['constraint', 'other']) {
      current.current!.findings.push({
        id: requirementId, text: 'Observed behavior', requirementIds: [requirementId],
        sources: [{ sourceId: 'tool-1', quote: 'All tests passed.' }], files: [], status: 'valid',
      });
      current.current!.decisions.push({
        id: requirementId, text: 'Use the existing API', reason: 'Preserve behavior', scope: 'report',
        requirementIds: [requirementId], sources: [{ sourceId: 'user-1', quote: 'Build a report.' }],
        status: 'active',
      });
    }
    const result = applyIntentUpdate(current, update(current, {
      items: [{ ...current.current!.items[0]!, text: 'Updated interpretation' }],
    }), 'view-1', 'task-2');
    expect(result.state.current!.findings.map((entry) => entry.status)).toEqual(['review', 'valid']);
    expect(result.state.current!.decisions.map((entry) => entry.status)).toEqual(['review', 'active']);
  });

  it('archives the current task without carrying analysis into the next task', () => {
    const current = readyState();
    current.current!.sourceRefs.push({ id: 'user-2', kind: 'user_input', text: 'Start a new task.' });
    current.current!.observedInputs.push('user-2');
    const result = applyIntentUpdate(current, update(current, {
      newTaskSourceId: 'user-2',
    }), 'view-1', 'task-2');
    expect(result.state.current).toMatchObject({ intentId: 'task-2', revision: 0, observedInputs: ['user-2'] });
    expect(result.state.current!.analysis).toBeUndefined();
    expect(result.state.archives[0]).toMatchObject({ intentId: 'task-1', lifecycle: 'archived' });
  });

  it('projects certainty, pending input and reusable findings without full source documents', () => {
    const current = state();
    current.current!.items = [
      item(), item({ id: 'old', text: 'Superseded text', status: 'superseded' }),
      item({ id: 'assumed', certainty: 'assumption', text: 'Tentative interpretation' }),
    ];
    current.current!.findings = [{
      id: 'finding', text: 'Reuse the existing API', requirementIds: ['goal'],
      sources: [{ sourceId: 'child-1', quote: 'The current export is supported.' }],
      files: [], status: 'review',
    }];
    const projection = intentProjection(current, 'view-1');
    expect(projection).toContain('generation view-1');
    expect(projection).toContain('Pending user inputs: user-1');
    expect(projection).toContain('goal [assumed, assumption]');
    expect(projection).toContain('Finding [finding, review]');
    expect(projection).not.toContain('Superseded text');
    expect(projection).not.toContain('The current export is supported.');
  });
});

describe('Intent replacement and evidence integrity', () => {
  it('does not let an assumption replace an explicit user requirement', () => {
    const current = state();
    current.current!.items = [item()];
    expect(() => applyIntentUpdate(current, update(current, {
      items: [item({ id: 'replacement', certainty: 'assumption', supersedes: 'goal' })],
    }), 'view-1', 'task-2')).toThrow('An assumption cannot replace');
  });

  it('cannot reactivate a replaced requirement through the same batch upsert', () => {
    const current = state();
    current.current!.items = [item()];
    const result = applyIntentUpdate(current, update(current, {
      items: [item(), item({ id: 'replacement', supersedes: 'goal' })],
    }), 'view-1', 'task-2');
    expect(result.state.current!.items[0]!.status).toBe('superseded');
    expect(result.state.current!.items[1]!.status).toBe('active');
    expect(() => applyIntentUpdate(result.state, update(result.state, {
      operationId: 'reactivate', items: [item()],
    }), 'view-1', 'task-2')).toThrow('must not be reactivated');
  });

  it('rejects multiple replacements instead of silently selecting an order', () => {
    const current = state();
    current.current!.items = [item()];
    expect(() => applyIntentUpdate(current, update(current, {
      items: [
        item({ id: 'replacement-1', supersedes: 'goal' }),
        item({ id: 'replacement-2', supersedes: 'goal' }),
      ],
    }), 'view-1', 'task-2')).toThrow('two replacements');
  });

  it('only counts a handled user input once', () => {
    const current = state();
    const result = applyIntentUpdate(current, update(current, {
      handledInputs: ['user-1', 'user-1'], reviewReason: 'No requirement change.',
    }), 'view-1', 'task-2');
    expect(result.state.current!.handledInputs).toEqual(['user-1']);
    expect(result.state.current!.reviews[0]!.inputIds).toEqual(['user-1']);
  });

  it('rejects decision and finding links to missing requirements', () => {
    const current = state();
    const sources = [{ sourceId: 'tool-1', quote: 'All tests passed.' }];
    expect(() => applyIntentUpdate(current, update(current, {
      decisions: [{ id: 'choice', text: 'Use current behavior', reason: 'Observed behavior',
        scope: 'current task', sources, requirementIds: ['missing'], status: 'active' }],
    }), 'view-1', 'task-2')).toThrow('unknown requirement');
    expect(() => applyIntentUpdate(current, update(current, {
      findings: [{ id: 'finding', text: 'Observed behavior', sources,
        requirementIds: ['missing'], files: [], status: 'valid' }],
    }), 'view-1', 'task-2')).toThrow('unknown requirement');
  });

  it('rejects self-reported file fingerprints and accepts an exact authorized read', () => {
    const current = state();
    const file = { path: '/workspace/report.ts', environmentId: 'local',
      cwd: '/workspace', fingerprint: 'recorded-sha256', environmentGeneration: 'environment-1' };
    const finding = { id: 'finding', text: 'Existing behavior', requirementIds: [],
      sources: [{ sourceId: 'tool-1', quote: 'All tests passed.' }],
      files: [file], status: 'valid' as const };
    expect(() => applyIntentUpdate(current, update(current, { findings: [finding] }),
      'view-1', 'task-2')).toThrow('authorized read');
    current.current!.sourceRefs.find((source) => source.id === 'tool-1')!.files = [file];
    const result = applyIntentUpdate(current, update(current, { findings: [finding] }), 'view-1', 'task-2');
    expect(result.state.current!.findings[0]!.files).toEqual([file]);
    expect(() => applyIntentUpdate(current, update(current, {
      findings: [{ ...finding, files: [{ ...file, environmentGeneration: 'environment-2' }] }],
    }), 'view-1', 'task-2')).toThrow('authorized read');
  });

  it('does not silently discard updates during a task switch', () => {
    const current = state();
    expect(() => applyIntentUpdate(current, update(current, {
      newTaskSourceId: 'user-1', items: [item()],
    }), 'view-1', 'task-2')).toThrow('separate operation');
  });

  it.each(['goal', 'constraint', 'assumption', 'unknown'] as const)(
    'rejects verification fields on %s items in both the tool schema and update policy', (kind) => {
      const current = state();
      const tool = intentTool(current);
      const validator = compileToolArgsValidator(tool.parameters);
      const requirement = item({ kind, certainty: kind === 'unknown' ? 'unknown' : 'explicit' });
      const valid = { update: update(current, { items: [requirement] }) };
      expect(validateToolArgs(validator, valid)).toBeNull();
      expect(() => tool.resolveExecution(valid)).not.toThrow();
      expect(applyIntentUpdate(current, valid.update, 'view-1', 'task-2').state.current!.items).toEqual([requirement]);
      for (const fields of [{ verification: 'unverified' as const }, { evidence: [] }]) {
        const invalid = { update: update(current, { items: [{ ...requirement, ...fields }] }) };
        expect(validateToolArgs(validator, invalid)).not.toBeNull();
        expect(() => tool.resolveExecution(invalid)).toThrow();
        expect(() => applyIntentUpdate(current, invalid.update, 'view-1', 'task-2')).toThrow('Unrecognized key');
        expect(current.current!.items).toEqual([]);
      }
    },
  );

  it.each(['items', 'decisions'] as const)('declares and enforces at least one source for %s', (section) => {
    const current = state();
    current.current!.items = [item()];
    const tool = intentTool(current);
    const validator = compileToolArgsValidator(tool.parameters);
    const record = section === 'items'
      ? item({ id: 'unsourced', kind: 'unknown', certainty: 'unknown', text: 'Compatibility is undecided.', sources: [] })
      : { id: 'unsourced', text: 'Keep defaults.', reason: 'Lower risk.', scope: 'config', sources: [],
        requirementIds: ['goal'], status: 'active' as const };
    const invalid = { update: update(current, { [section]: [record] }) };
    expect(validateToolArgs(validator, invalid)).not.toBeNull();
    expect(() => tool.resolveExecution(invalid)).toThrow();
    expect(() => applyIntentUpdate(current, invalid.update, 'view-1', 'task-2')).toThrow();
  });

  it('names the record whose evidence is missing', () => {
    const current = readyState();
    expect(() => applyIntentUpdate(current, update(current, {
      items: [{ ...current.current!.items[1]!, verification: 'passed' }],
    }), 'view-1', 'task-2')).toThrow('Provide at least one source reference (evidence of item acceptance)');
  });

  it.each([undefined, 'unverified', 'passed', 'failed', 'unavailable'] as const)(
    'accepts acceptance verification %s through the tool schema and update policy', (verification) => {
      const current = state();
      const tool = intentTool(current);
      const criterion = item({ kind: 'acceptance', verification,
        evidence: [{ sourceId: 'tool-1', quote: 'All tests passed.' }] });
      const input = { update: update(current, { items: [criterion] }) };
      expect(validateToolArgs(compileToolArgsValidator(tool.parameters), input)).toBeNull();
      expect(() => tool.resolveExecution(input)).not.toThrow();
      const applied = applyIntentUpdate(current, input.update, 'view-1', 'task-2');
      expect(applied.state.current!.items).toEqual([criterion]);
      expect(IntentStateSchema.parse(applied.state)).toEqual(applied.state);
    },
  );
});

describe('Intent replacement validity', () => {
  it('does not remove an explicit requirement using an already superseded replacement', () => {
    const current = state();
    current.current!.items = [item()];
    expect(() => applyIntentUpdate(current, update(current, {
      items: [item({ id: 'replacement', supersedes: 'goal', status: 'superseded' })],
    }), 'view-1', 'task-2')).toThrow('must be active');
    expect(current.current!.items[0]!.status).toBe('active');
  });
});

function usage(charged: number): IntentUsage {
  return { requestId: 'request-1', agentId: 'main', operation: 'turn', attempt: 1,
    charged, estimated: true, activeMs: 0 };
}

function request() {
  return { model: { spec: { provider: 'example', name: 'example-model' }, maxOutputTokens: 100 },
    content: { messages: [], usedTokens: 100 } };
}

describe('Intent request budgets', () => {
  it('estimates maintenance requests and preserves missing usage as an estimate', () => {
    const charged = estimateIntentRequestTokens(request());
    expect(charged).toBeGreaterThan(0);
    const settled = settleIntentUsage(usage(charged), undefined, 20);
    expect(settled).toMatchObject({ charged, estimated: true, activeMs: 20 });
    expect(settled.input).toBeUndefined();
    expect(settled.output).toBeUndefined();
    expect(settled.cacheRead).toBeUndefined();
    expect(settled.cacheWrite).toBeUndefined();
  });

  it('accounts for reported input, output and cache components once', () => {
    expect(settleIntentUsage(usage(1000), {
      inputOther: 100, output: 10, inputCacheRead: 200, inputCacheCreation: 40,
    }, 50)).toMatchObject({
      charged: 350, estimated: false, input: 100, output: 10, cacheRead: 200, cacheWrite: 40,
    });
    expect(settleIntentUsage(usage(1000), {
      inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
    }, 0)).toMatchObject({ charged: 0, estimated: false });
  });

  it('does not turn missing or malformed cache accounting into a reported zero', () => {
    for (const inputCacheRead of [undefined, Number.NaN, -1]) {
      const settled = settleIntentUsage(usage(1000), {
        inputOther: 100, output: 10, inputCacheRead, inputCacheCreation: 40,
      }, 50);
      expect(settled.charged).toBe(1000);
      expect(settled.estimated).toBe(true);
      expect(settled.cacheRead).toBeUndefined();
    }
    expect(settleIntentUsage(usage(100), {
      inputOther: 400, output: 10, inputCacheCreation: 40,
    }, 50).charged).toBe(450);
  });

  it('reserves for input and output while retaining a fallback for uncapped output', () => {
    const prepared = request();
    prepared.content.usedTokens = 10000;
    expect(estimateIntentRequestTokens(prepared)).toBe(10100);
    expect(estimateIntentRequestTokens({
      ...prepared, model: { ...prepared.model, maxOutputTokens: 'none' },
    }, 500)).toBe(10500);
    expect(estimateIntentRequestTokens({
      ...prepared, profile: { systemPrompt: 'x'.repeat(100000) },
    })).toBe(10100);
    expect(estimateIntentRequestTokens({ ...prepared, content: { messages: [], usedTokens: 0 } })).toBe(100);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'falls back to message and prompt estimates when usedTokens is %s', (usedTokens) => {
      expect(estimateIntentRequestTokens({
        ...request(), profile: { systemPrompt: 'abcd中文' },
        content: { usedTokens, messages: [{ role: 'user', content: [{ type: 'text', text: 'efgh中文' }] }] },
      })).toBe(107);
    },
  );

  it('includes profile tools and dynamically loaded tool definitions in fallback estimates', () => {
    const tools = [{ name: 'Read', description: 'Read a file.', parameters: { type: 'object' } }];
    const prepared = { ...request(), content: { messages: [], usedTokens: undefined } };
    const profileEstimate = estimateIntentRequestTokens({ ...prepared, profile: { tools } });
    expect(profileEstimate).toBeGreaterThan(100);
    expect(estimateIntentRequestTokens({ ...prepared, content: {
      messages: [{ role: 'system', content: [], tools }],
    } })).toBe(profileEstimate + 2);
  });

  it('uses a media token estimate instead of counting encoded image characters', () => {
    for (const length of [4, 100000]) {
      expect(estimateIntentRequestTokens({ ...request(), content: {
        messages: [{ role: 'user', content: [{ type: 'image_url',
          imageUrl: { url: 'data:image/png;base64,' + 'A'.repeat(length) } }] }],
      } })).toBe(2101);
    }
  });

  it.each(['requests', 'time'])('converges when the %s budget reaches 80%', (dimension) => {
    const run = readyState().current!.analysis!;
    run.budget = { maxRequests: 10, maxActiveMs: 1000, outputReserve: 100 };
    if (dimension === 'requests') run.ledger = Array.from({ length: 8 }, (_, i) => ({
      ...usage(1), requestId: 'request-' + i,
    }));
    if (dimension === 'time') run.activeMs = 800;
    expect(intentBudgetLevel(run)).toBe('converge');
    const current = readyState();
    current.current!.analysis = run;
    const projection = intentProjection(current, 'view-1');
    expect(projection).toContain('Analysis budget:');
    expect(projection).toContain('at least 80% used');
    run.status = 'ready';
    expect(intentProjection(current, 'view-1')).not.toContain('at least 80% used');
  });

  it.each(['requests', 'time'])('refuses admission when the %s budget is exhausted', (dimension) => {
    const run = readyState().current!.analysis!;
    run.budget = { maxRequests: 10, maxActiveMs: 1000, outputReserve: 100 };
    if (dimension === 'requests') run.ledger = Array.from({ length: 10 }, (_, i) => ({
      ...usage(1), requestId: 'request-' + i,
    }));
    if (dimension === 'time') run.activeMs = 1000;
    expect(intentBudgetLevel(run)).toBe('exhausted');
    expect(() => reserveIntentRequest(run, request())).toThrow('budget_exhausted');
  });

  it('keeps token reservations for observation without rejecting requests that exceed the remaining budget', () => {
    const run = readyState().current!.analysis!;
    run.ledger = [usage(49000), { ...usage(50173), requestId: 'request-2' }];
    run.activeMs = 32000;
    const prepared = request();
    prepared.content.usedTokens = 100728;
    expect(reserveIntentRequest(run, prepared)).toBe(100828);
    expect(intentBudgetLevel(run)).toBe('normal');
    expect(run.ledger).toHaveLength(2);
  });

  it('estimates large requests without a token admission limit', () => {
    const run = readyState().current!.analysis!;
    run.ledger = [usage(300000)];
    const prepared = request();
    prepared.content.usedTokens = 100728;
    expect(reserveIntentRequest(run, prepared)).toBe(100828);
    expect(intentBudgetLevel(run)).toBe('normal');
    expect(run.ledger).toHaveLength(1);
  });

  it.each([true, false])('does not stop or request convergence for observed tokens (estimated: %s)', (estimated) => {
    const current = readyState();
    const run = current.current!.analysis!;
    for (const charged of [160000, 200000, 1000000]) {
      run.ledger = [{ ...usage(charged), estimated }];
      expect(reserveIntentRequest(run, request())).toBeGreaterThan(0);
      expect(intentBudgetLevel(run)).toBe('normal');
      const projection = intentProjection(current, 'view-1');
      expect(projection).toContain(`Token usage: ${charged} (tracking only)`);
      expect(projection.includes('(includes estimates)')).toBe(estimated);
      expect(projection).not.toContain('at least 80% used');
      expect(projection).not.toContain('budget is exhausted');
    }
  });
});

describe('Intent acceptance evidence invalidation', () => {
  it('does not invalidate reusable findings when only a verification result changes', () => {
    const current = readyState();
    current.current!.findings = [{
      id: 'finding', text: 'The report is supported', requirementIds: ['acceptance'],
      sources: [{ sourceId: 'tool-1', quote: 'All tests passed.' }], files: [], status: 'valid',
    }];
    const result = applyIntentUpdate(current, update(current, {
      items: [{ ...current.current!.items[1]!, verification: 'passed',
        evidence: [{ sourceId: 'tool-1', quote: 'All tests passed.' }] }],
    }), 'view-1', 'task-2');
    expect(result.state.current!.findings[0]!.status).toBe('valid');
    expect(result.state.current!.items[1]!.verification).toBe('passed');
  });

  it('invalidates an acceptance result that depended on a changed requirement finding', () => {
    const current = readyState();
    const task = current.current!;
    task.items.push(item({ id: 'constraint', kind: 'constraint', certainty: 'assumption' }));
    task.items[1]!.verification = 'passed';
    task.items[1]!.evidence = [{ sourceId: 'tool-1', quote: 'All tests passed.' }];
    task.findings = [{
      id: 'finding', text: 'The report is supported', requirementIds: ['constraint'],
      sources: [{ sourceId: 'tool-1', quote: 'All tests passed.' }], files: [], status: 'valid',
    }];
    const result = applyIntentUpdate(current, update(current, {
      items: [{ ...task.items[2]!, text: 'Changed implementation constraint' }],
    }), 'view-1', 'task-2');
    expect(result.state.current!.findings[0]!.status).toBe('review');
    expect(result.state.current!.items[1]!.verification).toBe('unverified');
  });
});

function intentTool(current: IntentState): IntentTool {
  const service: IIntentService = {
    _serviceBrand: undefined,
    read: () => ({ state: current, generation: 'view-1' }),
    update: async (input) => ({ operationId: input.operationId }),
    command: async () => {},
    investigate: async () => '',
    bindInvestigation: () => {},
  };
  return new IntentTool(service);
}

async function executeIntent(tool: IntentTool, input: Parameters<IntentTool['resolveExecution']>[0] = {}) {
  const execution = tool.resolveExecution(input);
  if (execution.isError === true) throw new Error('Expected runnable Intent tool');
  return execution.execute({ turnId: 1, toolCallId: 'intent-read', signal: new AbortController().signal });
}

describe('Intent bounded tool reads', () => {
  it('defaults to a bounded current-task overview without archived sources or bookkeeping', async () => {
    const current = state();
    current.current!.sourceRefs = Array.from({ length: 25 }, (_, i) => ({
      id: 'source-' + i, kind: 'tool_result', text: 'Text ' + i + ' ' + 'x'.repeat(1000),
    }));
    current.archives = [createIntentTask('archived-task', {
      id: 'archived-source', kind: 'user_input', text: 'ARCHIVED_SOURCE_SECRET',
    })];
    current.operations = [{
      operationId: 'OPERATION_SECRET', intentId: 'task-1', generation: 'view-1',
      fingerprint: 'fingerprint-secret', revision: 0,
    }];
    current.maintenanceLedger = [{ ...usage(100), requestId: 'LEDGER_SECRET' }];
    const result = await executeIntent(intentTool(current));
    expect(result.isError).toBeFalsy();
    const output = result.output as string;
    const parsed = JSON.parse(output) as {
      sources: { sourceId: string; preview: string }[];
      totals: { sources: number };
    };
    expect(parsed).toMatchObject({ intentId: 'task-1', generation: 'view-1', revision: 0, totals: { sources: 25 } });
    expect(parsed.sources).toHaveLength(20);
    expect(parsed.sources[0]!.sourceId).toBe('source-5');
    expect(parsed.sources.every((source) => source.preview.length <= 500)).toBe(true);
    expect(output.length).toBeLessThan(30000);
    expect(output).not.toContain('ARCHIVED_SOURCE_SECRET');
    expect(output).not.toContain('OPERATION_SECRET');
    expect(output).not.toContain('LEDGER_SECRET');
    expect(output).not.toContain('"archives"');
    expect(output).not.toContain('"operations"');
    expect(output).not.toContain('"maintenanceLedger"');
  });

  it('pages current items and source previews without dropping the next offset', async () => {
    const current = state();
    current.current!.items = Array.from({ length: 23 }, (_, i) => item({ id: 'item-' + i }));
    const tool = intentTool(current);
    const first = await executeIntent(tool, { section: 'items', limit: 20 });
    expect(JSON.parse(first.output as string)).toMatchObject({
      section: 'items', offset: 0, nextOffset: 20, entries: expect.any(Array), totals: { items: 23 },
    });
    expect((JSON.parse(first.output as string) as { entries: unknown[] }).entries).toHaveLength(20);
    const second = await executeIntent(tool, { section: 'items', offset: 20, limit: 20 });
    const page = JSON.parse(second.output as string) as { entries: { id: string }[]; nextOffset: number | null };
    expect(page.nextOffset).toBeNull();
    expect(page.entries.map((entry) => entry.id)).toEqual(['item-20', 'item-21', 'item-22']);
    const sources = await executeIntent(tool, { section: 'sources', offset: 0, limit: 2 });
    expect(JSON.parse(sources.output as string)).toMatchObject({
      section: 'sources', nextOffset: 2, entries: [
        expect.objectContaining({ sourceId: 'user-1', preview: expect.any(String) }),
        expect.objectContaining({ sourceId: 'tool-1', preview: expect.any(String) }),
      ],
    });
  });

  it('reassembles source text across fixed-size pages for exact quotation validation', async () => {
    const current = state();
    const source = current.current!.sourceRefs[0]!;
    source.text = 'x'.repeat(7995) + 'Keep exports stable.' + 'y'.repeat(8500);
    const tool = intentTool(current);
    const chunks: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const result = await executeIntent(tool, { sourceId: source.id, offset });
      const page = JSON.parse(result.output as string) as { text: string; nextOffset: number | null };
      expect(page.text.length).toBeLessThanOrEqual(8000);
      chunks.push(page.text);
      offset = page.nextOffset;
    }
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe(source.text);
    const quoted = 'Keep exports stable.';
    expect(chunks.join('')).toContain(quoted);
    const applied = applyIntentUpdate(current, update(current, {
      items: [item({ kind: 'constraint', text: quoted, sources: [{ sourceId: source.id, quote: quoted }] })],
    }), 'view-1', 'task-2');
    expect(applied.state.current!.items[0]!.certainty).toBe('explicit');
  });

  it('does not expose an archived source through sourceId lookup', async () => {
    const current = state();
    current.archives = [createIntentTask('archived-task', {
      id: 'archived-source', kind: 'user_input', text: 'ARCHIVED_SOURCE_SECRET',
    })];
    const result = await executeIntent(intentTool(current), { sourceId: 'archived-source' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('invalid_source');
    expect(result.output).not.toContain('ARCHIVED_SOURCE_SECRET');
  });

  it('validates pagination bounds and preserves the existing update path', async () => {
    const current = state();
    const tool = intentTool(current);
    expect(() => tool.resolveExecution({ section: 'items', limit: 21 })).toThrow();
    expect(() => tool.resolveExecution({ section: 'items', limit: 0 })).toThrow();
    expect(() => tool.resolveExecution({ sourceId: 'user-1', offset: -1 })).toThrow();
    const result = await executeIntent(tool, { update: update(current) });
    expect(JSON.parse(result.output as string)).toEqual({ operationId: 'operation-1' });
  });

  it('returns an empty overview and completed empty pages without an active task', async () => {
    const tool = intentTool(emptyIntentState());
    const overview = await executeIntent(tool);
    expect(JSON.parse(overview.output as string)).toMatchObject({
      generation: 'view-1', summary: 'No current task.',
      totals: { items: 0, decisions: 0, findings: 0, sources: 0 }, sources: [],
    });
    const page = await executeIntent(tool, { section: 'findings' });
    expect(JSON.parse(page.output as string)).toMatchObject({ entries: [], nextOffset: null });
  });
});
