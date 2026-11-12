import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { createControlledPromise } from '@antfu/utils';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IConfigService } from '#/app/config/config';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IEventBus } from '#/app/event/eventBus';
import { CommandOutput } from '#/agent/command/commandEvents';
import { IFlagService } from '#/app/flag/flag';
import { IIntentService } from '#/features/intent/intentService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentCommandService } from '#/agent/command/agentCommand';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { createTestAgent, appService, permissionModeServices, type TestAgentContext } from '../../harness';
import { stubFlag } from '../../app/flag/stubs';
import { executeLegacyTool } from '../../agent/toolExecutor/execute';

const contexts: TestAgentContext[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup(enabled = true) {
  const context = createTestAgent(appService(IFlagService, stubFlag((id) => id === 'intent_engine' && enabled)),
    appService(IAppendLogStore, new SyncDescriptor(AppendLogStore)), permissionModeServices('yolo'));
  contexts.push(context);
  await context.restorePersisted();
  return { context, intent: context.get(IIntentService), loop: context.get(IAgentLoopService) };
}

async function prompt(context: TestAgentContext, loop: IAgentLoopService, text: string) {
  context.mockNextResponse({ type: 'text', text: 'Understood.' });
  await loop.submit({ input: [{ type: 'text', text }] });
  await loop.settled();
}

describe('Intent runtime', () => {
  it('keeps the disabled path free of state and commands', async () => {
    const { context, loop, intent } = await setup(false);
    await prompt(context, loop, 'Discuss the options only.');
    expect(intent.read().state.current).toBeUndefined();
    expect(context.get(IAgentCommandService).list().some((command) => command.name === 'deep')).toBe(false);
    expect(context.llmCalls).toHaveLength(1);
  });

  it('observes real user input without a separate model request', async () => {
    const { context, loop, intent } = await setup();
    await prompt(context, loop, 'Discuss the options only.');
    const task = intent.read().state.current!;
    expect(task.sourceRefs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user_input', text: 'Discuss the options only.' })]));
    expect(task.items).toEqual([]);
    expect(context.llmCalls).toHaveLength(1);
    expect(task.observedInputs).toHaveLength(1);
  });

  it('starts deep without creating another task and does not turn an answer into ready', async () => {
    const { context, loop, intent } = await setup();
    await prompt(context, loop, 'Discuss the options only.');
    const id = intent.read().state.current!.intentId;
    context.mockNextResponse({ type: 'text', text: 'A key constraint still needs clarification.' });
    await intent.command('');
    await loop.settled();
    expect(intent.read().state.current?.intentId).toBe(id);
    expect(intent.read().state.current?.analysis?.status).toBe('analyzing');
    await intent.command('--cancel');
    expect(intent.read().state.current?.analysis).toMatchObject({ status: 'interrupted', reason: 'cancelled' });
  });

  it('requires a task and refuses unknown command options', async () => {
    const { intent } = await setup();
    await expect(intent.command('')).rejects.toThrow('no_task');
    await expect(intent.command('--on')).rejects.toThrow('Usage');
  });

  it('does not publish an unconfirmed requirement update after storage failure', async () => {
    const { context, loop, intent } = await setup();
    await prompt(context, loop, 'Keep the API stable.');
    const before = intent.read();
    const task = before.state.current!;
    vi.spyOn(context.get(IEventDispatcher), 'flush').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(intent.update({ operationId: 'review', intentId: task.intentId,
      generation: before.generation, expectedRevision: task.revision,
      handledInputs: task.observedInputs, reviewReason: 'Preserve the API.' })).rejects.toThrow('persistence_failed');
    expect(intent.read().state).toEqual(before.state);
    expect(intent.read().error).toContain('disk unavailable');
  });

  it('rejects arbitrary tool effects while review is pending', async () => {
    const { context, loop } = await setup();
    await prompt(context, loop, 'Keep the API stable.');
    const execute = vi.fn(async () => ({ output: 'changed' }));
    context.get(IAgentToolRegistryService).register({ name: 'ExampleMutation', description: 'mutate',
      parameters: { type: 'object', properties: {} }, resolveExecution: () => ({ approvalRule: 'ExampleMutation', execute }) });
    const result = await executeLegacyTool(context.get(IAgentToolExecutorService), [
      { id: 'mutation', name: 'ExampleMutation', type: 'function', arguments: '{}' },
    ], { turnId: 1 });
    expect(result[0]?.result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['kind', { kind: undefined }, "must have required property 'kind'"],
    ['certainty', { certainty: undefined }, "must have required property 'certainty'"],
    ['scope', { scope: undefined }, "must have required property 'scope'"],
    ['kind value', { kind: 'requirement' }, '/update/items/0/kind must be equal to one of the allowed values'],
  ])('preserves Intent validation errors for invalid %s and accepts a corrected update', async (_field, invalidItem, error) => {
    const { context, loop, intent } = await setup();
    await prompt(context, loop, 'Keep the API stable.');
    const before = intent.read();
    const task = before.state.current!;
    const item = { id: 'goal', kind: 'goal', text: 'Keep the API stable.', certainty: 'explicit', scope: 'task',
      sources: [{ sourceId: task.sourceRefs[0]!.id, quote: task.sourceRefs[0]!.text }], status: 'active' };
    const update = { operationId: 'review', intentId: task.intentId, generation: before.generation,
      expectedRevision: task.revision, handledInputs: task.observedInputs, reviewReason: 'Preserve the API.', items: [item] };
    const executor = context.get(IAgentToolExecutorService);
    const invalid = executor.executor.execute({ id: 'invalid-intent', type: 'function', name: 'Intent',
      arguments: JSON.stringify({ update: { ...update, items: [{ ...item, ...invalidItem }] } }) }, { turnId: 1 });
    const failure = await invalid.wait();
    executor.release(invalid.taskId);
    expect(invalid.snapshot().prepared).toBeUndefined();
    expect(failure.outcome).toMatchObject({ type: 'failed', error: { phase: 'validate', reason: expect.stringContaining(error) } });
    expect(failure.content).toEqual([{ type: 'text', text: expect.stringContaining(error) }]);
    expect(intent.read()).toEqual(before);

    const corrected = executor.executor.execute({ id: 'corrected-intent', type: 'function', name: 'Intent',
      arguments: JSON.stringify({ update }) }, { turnId: 1 });
    const success = await corrected.wait();
    executor.release(corrected.taskId);
    expect(success.outcome.type).toBe('success');
    expect(intent.read().state.current).toMatchObject({ revision: task.revision + 1, items: [item], handledInputs: task.observedInputs });
  });

  it.each([
    ['parse', 'Intent', '{"update":', 'Invalid args for tool "Intent"'],
    ['resolve', 'ExampleUnresolvable', '{}', 'Cannot prepare the tool'],
  ])('preserves %s failures before tool preparation with Intent enabled', async (phase, name, args, error) => {
    const { context, loop } = await setup();
    await prompt(context, loop, 'Keep the API stable.');
    context.get(IAgentToolRegistryService).register({ name: 'ExampleUnresolvable', description: 'fail to prepare',
      parameters: { type: 'object', properties: {} }, resolveExecution: () => { throw new Error('Cannot prepare the tool'); } });
    const executor = context.get(IAgentToolExecutorService);
    const handler = executor.executor.execute({ id: 'unprepared', type: 'function', name, arguments: args }, { turnId: 1 });
    const result = await handler.wait();
    executor.release(handler.taskId);
    expect(handler.snapshot().prepared).toBeUndefined();
    expect(result.outcome).toMatchObject({ type: 'failed', error: { phase, reason: expect.stringContaining(error) } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(error) }]);
  });

  it('publishes status without a model call, including an empty session', async () => {
    const { context, intent } = await setup();
    const output: string[] = [];
    context.get(IEventBus).subscribe(CommandOutput, (event) => output.push(event.text));
    await intent.command('--status');
    expect(output).toEqual(['No current task.']);
    expect(context.llmCalls).toHaveLength(0);
  });

  it('does not cancel ordinary work when no analysis is active', async () => {
    const { loop, intent } = await setup();
    const cancel = vi.spyOn(loop, 'cancel');
    await intent.command('--cancel');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('restores interrupted analysis with a fresh generation and the same budget ledger', async () => {
    const { context, loop, intent } = await setup();
    context.mockNextResponse({ type: 'text', text: 'Investigation incomplete.' });
    await intent.command('Keep the API stable.');
    await loop.settled();
    const before = intent.read();
    await context.get(IEventDispatcher).restore();
    const restored = intent.read();
    expect(restored.generation).not.toBe(before.generation);
    expect(restored.state.current?.analysis).toMatchObject({ status: 'interrupted', reason: 'recovery' });
    expect(restored.state.current?.analysis?.ledger).toEqual(before.state.current?.analysis?.ledger);
    const task = before.state.current!;
    await expect(intent.update({ operationId: 'late', intentId: task.intentId, generation: before.generation,
      expectedRevision: task.revision })).rejects.toThrow('stale_version');
  });

  it('enforces request budgets for text-only analysis and keeps them on continue', async () => {
    const { context, loop, intent } = await setup();
    await context.get(IConfigService).set('intent', { maxRequests: 1, maxTokens: 1000000 });
    context.mockNextResponse({ type: 'text', text: 'Still investigating.' });
    await intent.command('Keep the API stable.');
    await loop.settled();
    expect(context.llmCalls).toHaveLength(1);
    const queued = loop.submit({ message: { role: 'user', content: [{ type: 'text', text: 'Continue analysis.' }] },
      meta: { origin: { kind: 'system_trigger' } } });
    await loop.promptHandle(queued.id)!.completion;
    expect(context.llmCalls).toHaveLength(1);
    expect(intent.read().state.current?.analysis).toMatchObject({ status: 'interrupted', reason: 'budget_exhausted' });
    await intent.command('--continue');
    await loop.settled();
    expect(context.llmCalls).toHaveLength(1);
    expect(intent.read().state.current?.analysis?.ledger).toHaveLength(1);
  });

  it('keeps old task inputs archived when an explicit new task starts', async () => {
    const { context, loop, intent } = await setup();
    await prompt(context, loop, 'Discuss the existing API.');
    await prompt(context, loop, 'New task: investigate startup.');
    const view = intent.read();
    const old = view.state.current!;
    const source = old.sourceRefs.find((entry) => entry.text === 'New task: investigate startup.')!;
    await intent.update({ operationId: 'switch', intentId: old.intentId, generation: view.generation,
      expectedRevision: old.revision, newTaskSourceId: source.id });
    await prompt(context, loop, 'Preserve all CLI arguments.');
    const state = intent.read().state;
    expect(state.archives).toHaveLength(1);
    expect(state.current?.intentId).not.toBe(old.intentId);
    expect(state.current?.sourceRefs.some((entry) => entry.text === 'Discuss the existing API.')).toBe(false);
  });

  it('blocks effects in the completion batch and allows a later batch', async () => {
    const { context, loop, intent } = await setup();
    const execute = vi.fn(async () => ({ output: 'changed' }));
    context.get(IAgentToolRegistryService).register({ name: 'ExampleMutation', description: 'mutate',
      parameters: { type: 'object', properties: {} },
      resolveExecution: () => ({ approvalRule: 'ExampleMutation', accesses: [], execute }) });
    context.configure({ tools: ['Intent', 'ExampleMutation'] });
    context.mockNextResponse({ type: 'text', text: 'Investigating.' });
    await intent.command('Implement a stable API.');
    await loop.settled();
    const view = intent.read();
    const task = view.state.current!;
    const sources = [{ sourceId: task.sourceRefs[0]!.id, quote: task.sourceRefs[0]!.text }];
    const update = { operationId: 'complete', intentId: task.intentId, generation: view.generation,
      expectedRevision: task.revision, handledInputs: task.observedInputs, reviewReason: 'The scope is clear.',
      items: [
        { id: 'goal', kind: 'goal', text: 'Implement the API', certainty: 'explicit', scope: 'task', sources, status: 'active' },
        { id: 'acceptance', kind: 'acceptance', text: 'API remains stable', certainty: 'explicit', scope: 'task', sources, status: 'active', verification: 'unverified' },
      ], executionPreparation: { modules: ['API'], nextActions: ['Implement the API'], validation: ['Run tests'] },
      completeAnalysisRunId: task.analysis!.id };
    context.mockNextResponse(
      { type: 'function', id: 'complete-call', name: 'Intent', arguments: JSON.stringify({ update }) },
      { type: 'function', id: 'same-batch', name: 'ExampleMutation', arguments: '{}' },
    );
    context.mockNextResponse({ type: 'text', text: 'Analysis complete.' });
    const first = loop.submit({ message: { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      meta: { origin: { kind: 'system_trigger' } } });
    await loop.promptHandle(first.id)!.completion;
    expect(intent.read().state.current?.analysis?.status).toBe('ready');
    expect(execute).not.toHaveBeenCalled();
    context.mockNextResponse({ type: 'function', id: 'later-batch', name: 'ExampleMutation', arguments: '{}' });
    context.mockNextResponse({ type: 'text', text: 'Done.' });
    const second = loop.submit({ message: { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
      meta: { origin: { kind: 'system_trigger' } } });
    await loop.promptHandle(second.id)!.completion;
    expect(execute).toHaveBeenCalledOnce();
    expect(intent.read().state.current?.items.find((item) => item.id === 'acceptance')?.verification).toBe('unverified');
  });

  it('records only an actual clarification answer as explicit-capable evidence', async () => {
    const { context, loop, intent } = await setup();
    context.configure({ tools: ['AskUserQuestion'] });
    context.mockNextResponse({ type: 'function', id: 'question', name: 'AskUserQuestion',
      arguments: JSON.stringify({ questions: [{ question: 'May the API change?', header: 'API',
        options: [{ label: 'Keep it stable', description: '' }, { label: 'Change it', description: '' }],
        multi_select: false }] }) });
    context.mockNextResponse({ type: 'text', text: 'The API will remain stable.' });
    const question = context.snapshots.take('requestQuestion');
    await intent.command('Investigate the API.');
    const { respond } = await question;
    expect(intent.read().state.current?.analysis?.status).toBe('waiting_for_answer');
    respond({ answers: { 'May the API change?': 'Keep it stable' } });
    await loop.settled();
    const answer = intent.read().state.current?.sourceRefs.find((source) => source.kind === 'user_answer');
    expect(answer?.text).toBe('Keep it stable');
    expect(answer?.text).not.toContain('May the API change?');
    expect(intent.read().state.current?.analysis?.status).toBe('analyzing');
  });

  it('keeps dismissed questions interrupted without inventing an answer or spending another request', async () => {
    const { context, loop, intent } = await setup();
    context.configure({ tools: ['AskUserQuestion'] });
    context.mockNextResponse({ type: 'function', id: 'dismissed-question', name: 'AskUserQuestion',
      arguments: JSON.stringify({ questions: [{ question: 'Which behavior?', header: 'Scope',
        options: [{ label: 'Existing', description: '' }, { label: 'New', description: '' }],
        multi_select: false }] }) });
    await intent.command('Investigate the API.');
    await context.untilQuestion(null);
    await loop.settled();
    expect(intent.read().state.current?.sourceRefs.some((source) => source.kind === 'user_answer')).toBe(false);
    expect(intent.read().state.current?.analysis).toMatchObject({ status: 'interrupted', reason: 'answer_required' });
    expect(context.llmCalls).toHaveLength(1);
  });

  it('runs read-only investigations against the parent request budget', async () => {
    const { context, loop, intent } = await setup();
    await context.get(IConfigService).set('intent', { maxRequests: 2, maxTokens: 1000000 });
    context.mockNextResponse({ type: 'text', text: 'Investigating the API.' });
    await intent.command('Keep the API stable.');
    await loop.settled();
    const subagents = context.get(ISessionSubagentService);
    const run = subagents.run.bind(subagents);
    const mutation = vi.fn(async () => ({ output: 'changed' }));
    vi.spyOn(subagents, 'run').mockImplementation(async (agent, request, options) => {
      const child = context.get(IAgentLifecycleService).handleOf(agent.agentId)!;
      child.accessor.get(IAgentToolRegistryService).register({ name: 'ExampleMutation', description: 'mutate',
        parameters: { type: 'object', properties: {} },
        resolveExecution: () => ({ approvalRule: 'ExampleMutation', accesses: [], execute: mutation }) });
      const result = await executeLegacyTool(child.accessor.get(IAgentToolExecutorService), [
        { id: 'child-mutation', name: 'ExampleMutation', type: 'function', arguments: '{}' },
      ], { turnId: 1 });
      expect(result[0]?.result.isError).toBe(true);
      return run(agent, request, options);
    });
    context.mockNextResponse({ type: 'text', text: 'The API boundary is in the public module.' });
    await expect(intent.investigate('Locate the API boundary.', new AbortController().signal))
      .resolves.toBe('The API boundary is in the public module.');
    expect(mutation).not.toHaveBeenCalled();
    expect(context.llmCalls).toHaveLength(2);
    const ledger = intent.read().state.current?.analysis?.ledger ?? [];
    expect(ledger).toHaveLength(2);
    expect(new Set(ledger.map((entry) => entry.agentId)).size).toBe(2);
    expect(context.llmCalls[1]?.history.some((message) => message.content.some((part) =>
      part.type === 'text' && part.text.includes(intent.read().state.current!.intentId)))).toBe(true);
    await expect(intent.investigate('Inspect another module.', new AbortController().signal)).rejects.toBeDefined();
    expect(context.llmCalls).toHaveLength(2);
    expect(intent.read().state.current?.analysis).toMatchObject({ status: 'interrupted', reason: 'budget_exhausted' });
    expect(intent.read().state.current?.analysis?.ledger).toHaveLength(2);
  });

  it('does not apply a completed investigation delivered after cancellation', async () => {
    const { context, loop, intent } = await setup();
    context.mockNextResponse({ type: 'text', text: 'Investigating the API.' });
    await intent.command('Keep the API stable.');
    await loop.settled();
    const subagents = context.get(ISessionSubagentService);
    const run = subagents.run.bind(subagents);
    const completed = createControlledPromise<void>();
    const delivery = createControlledPromise<void>();
    vi.spyOn(subagents, 'run').mockImplementation(async (agent, request, options) => {
      const child = await run(agent, request, options);
      return { ...child, completion: child.completion.then(async (result) => {
        completed.resolve();
        await delivery;
        return result;
      }) };
    });
    context.mockNextResponse({ type: 'text', text: 'Late finding about the API boundary.' });
    const investigation = intent.investigate('Locate the API boundary.', new AbortController().signal);
    await completed;
    await intent.command('--cancel');
    delivery.resolve();
    await expect(investigation).resolves.toContain('Stale investigation; review only');
    context.mockNextResponse({ type: 'text', text: 'Continuing analysis.' });
    await intent.command('--continue');
    await loop.settled();
    const task = intent.read().state.current!;
    expect(task.sourceRefs.some((source) => source.kind === 'subagent_finding')).toBe(false);
    expect(task.findings).toEqual([]);
    expect(task.items).toEqual([]);
    expect(task.analysis?.ledger).toHaveLength(3);
  });

  it('records real Read evidence and invalidates passed acceptance after a write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'intent-evidence-'));
    directories.push(cwd);
    const path = join(cwd, 'api.ts');
    const original = 'export const answer = 42;';
    await writeFile(path, original);
    const context = createTestAgent({ cwd },
      appService(IFlagService, stubFlag((id) => id === 'intent_engine')),
      appService(IAppendLogStore, new SyncDescriptor(AppendLogStore)),
      appService(IHostEnvironment, { _serviceBrand: undefined, osKind: process.platform === 'win32' ? 'Windows' : 'Linux',
        osArch: process.arch, osVersion: 'test', shellName: 'sh', shellPath: '/bin/sh',
        pathClass: process.platform === 'win32' ? 'win32' : 'posix', homeDir: cwd, ready: Promise.resolve() }),
      permissionModeServices('yolo'));
    contexts.push(context);
    await context.restorePersisted();
    context.configure({ tools: ['Read', 'Write'] });
    const intent = context.get(IIntentService);
    const loop = context.get(IAgentLoopService);
    context.mockNextResponse({ type: 'function', id: 'read-original', name: 'Read', arguments: JSON.stringify({ path }) });
    context.mockNextResponse({ type: 'text', text: 'The exported answer is 42.' });
    await loop.submit({ input: [{ type: 'text', text: 'Keep the exported answer at 42.' }] });
    await loop.settled();
    const view = intent.read();
    const task = view.state.current!;
    const read = task.sourceRefs.find((source) => source.id === 'tool:read-original')!;
    expect(read.text).toContain(original);
    expect(read.files).toEqual([expect.objectContaining({ path, environmentId: 'local',
      environmentGeneration: expect.any(String), fingerprint: createHash('sha256').update(original).digest('hex') })]);
    const sources = [{ sourceId: task.sourceRefs[0]!.id, quote: task.sourceRefs[0]!.text }];
    const evidence = [{ sourceId: read.id, quote: original }];
    await intent.update({ operationId: 'record-verification', intentId: task.intentId, generation: view.generation,
      expectedRevision: task.revision, handledInputs: task.observedInputs, reviewReason: 'Preserve the exported value.',
      items: [{ id: 'answer', kind: 'acceptance', text: 'The exported answer is 42.', certainty: 'explicit',
        scope: 'task', sources, status: 'active', verification: 'passed', evidence }],
      findings: [{ id: 'export', text: 'The public module exports 42.', requirementIds: ['answer'],
        sources: evidence, files: read.files!, status: 'valid' }] });
    expect(intent.read().state.current?.items[0]?.verification).toBe('passed');
    const changed = 'export const answer = 43;';
    const result = await executeLegacyTool(context.get(IAgentToolExecutorService), [
      { id: 'write-change', name: 'Write', type: 'function', arguments: JSON.stringify({ path, content: changed }) },
    ], { turnId: 2 });
    expect(result[0]?.result.isError).not.toBe(true);
    expect(await readFile(path, 'utf8')).toBe(changed);
    const invalidated = intent.read().state.current!;
    expect(invalidated.findings[0]?.status).toBe('review');
    expect(invalidated.items[0]?.verification).toBe('unverified');
    expect(invalidated.findings[0]?.files).toEqual(read.files);
    context.mockNextResponse({ type: 'function', id: 'read-changed', name: 'Read', arguments: JSON.stringify({ path }) });
    context.mockNextResponse({ type: 'text', text: 'The current file exports 43.' });
    const reread = loop.submit({ message: { role: 'user', content: [{ type: 'text', text: 'Inspect the current file.' }] },
      meta: { origin: { kind: 'system_trigger' } } });
    await loop.promptHandle(reread.id)!.completion;
    const updated = intent.read().state.current!;
    expect(updated.sourceRefs.find((source) => source.id === 'tool:read-changed')?.files?.[0]?.fingerprint)
      .toBe(createHash('sha256').update(changed).digest('hex'));
    expect(updated.findings[0]?.status).toBe('review');
    expect(updated.items[0]?.verification).toBe('unverified');
  });

  it('rechecks inputs received while the flag was disabled', async () => {
    let enabled = true;
    const context = createTestAgent(appService(IFlagService, stubFlag((id) => id === 'intent_engine' && enabled)));
    contexts.push(context);
    await context.restorePersisted();
    const loop = context.get(IAgentLoopService);
    const intent = context.get(IIntentService);
    await prompt(context, loop, 'Keep the API stable.');
    const before = intent.read();
    await intent.update({ operationId: 'review', intentId: before.state.current!.intentId, generation: before.generation,
      expectedRevision: before.state.current!.revision, handledInputs: before.state.current!.observedInputs,
      reviewReason: 'Preserve compatibility.' });
    enabled = false;
    await prompt(context, loop, 'Change the API after all.');
    enabled = true;
    await prompt(context, loop, 'Continue.');
    const task = intent.read().state.current!;
    expect(task.sourceRefs.some((source) => source.text === 'Change the API after all.')).toBe(true);
    expect(task.observedInputs.filter((id) => !task.handledInputs.includes(id))).toHaveLength(2);
  });

});
