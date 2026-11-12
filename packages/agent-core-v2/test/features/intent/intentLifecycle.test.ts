import { createControlledPromise } from '@antfu/utils';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentCommitted } from '#/features/intent/intentOps';
import { IIntentService } from '#/features/intent/intentService';
import { intentAllowsEffects } from '#/features/intent/intentPolicy';
import type { IntentUpdate } from '#/features/intent/intentState';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IFlagService } from '#/app/flag/flag';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { executeLegacyTool } from '../../agent/toolExecutor/execute';
import { createTestAgent, appService, permissionModeServices, type TestAgentContext } from '../../harness';
import { stubFlag } from '../../app/flag/stubs';

const contexts: TestAgentContext[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const context of contexts.splice(0)) await context.dispose();
});

async function setup() {
  let enabled = true;
  const context = createTestAgent(appService(IFlagService, stubFlag((id) => id === 'intent_engine' && enabled)),
    appService(IAppendLogStore, new SyncDescriptor(AppendLogStore)), permissionModeServices('yolo'));
  contexts.push(context);
  await context.restorePersisted();
  return { context, intent: context.get(IIntentService), loop: context.get(IAgentLoopService),
    disable: () => { enabled = false; }, enable: () => { enabled = true; } };
}

async function start(context: TestAgentContext, intent: IIntentService, loop: IAgentLoopService) {
  context.mockNextResponse({ type: 'text', text: 'Investigating.' });
  await intent.command('Implement a stable API.');
  await loop.settled();
  const view = intent.read();
  const task = view.state.current!;
  await intent.update({ operationId: 'review', intentId: task.intentId, generation: view.generation,
    expectedRevision: task.revision, handledInputs: task.observedInputs, reviewReason: 'Keep compatibility.' });
}

function complete(intent: IIntentService): IntentUpdate {
  const view = intent.read();
  const task = view.state.current!;
  const sources = [{ sourceId: task.sourceRefs[0]!.id, quote: task.sourceRefs[0]!.text }];
  return { operationId: 'complete', intentId: task.intentId, generation: view.generation,
    expectedRevision: task.revision, handledInputs: task.observedInputs, reviewReason: 'Scope is clear.',
    items: [
      { id: 'goal', kind: 'goal', text: 'Implement the API', certainty: 'explicit', scope: 'task', sources, status: 'active' },
      { id: 'acceptance', kind: 'acceptance', text: 'Keep compatibility', certainty: 'explicit', scope: 'task', sources, status: 'active', verification: 'unverified' },
    ], executionPreparation: { modules: ['API'], nextActions: ['Implement'], validation: ['Test'] },
    completeAnalysisRunId: task.analysis!.id };
}

function holdFlush(context: TestAgentContext) {
  const entered = createControlledPromise<void>();
  const released = createControlledPromise<void>();
  const dispatcher = context.get(IEventDispatcher);
  const original = dispatcher.flush.bind(dispatcher);
  vi.spyOn(dispatcher, 'flush').mockImplementationOnce(async (options) => {
    entered.resolve();
    await released;
    await original(options);
  });
  return { entered: entered, release: released.resolve };
}

describe('Intent lifecycle boundaries', () => {
  it.each(['cancel', 'disable'] as const)('never publishes ready when %s races durable completion', async (action) => {
    const { context, loop, intent, disable } = await setup();
    await start(context, intent, loop);
    const before = intent.read();
    const held = holdFlush(context);
    const completion = expect(intent.update(complete(intent))).rejects.toThrow('stale_version');
    await held.entered;
    let stopped: Promise<void>;
    if (action === 'cancel') stopped = intent.command('--cancel');
    else {
      disable();
      const execute = vi.fn(async () => ({ output: 'changed' }));
      context.get(IAgentToolRegistryService).register({ name: 'ExampleMutation', description: 'mutate',
        parameters: { type: 'object', properties: {} },
        resolveExecution: () => ({ approvalRule: 'ExampleMutation', execute }) });
      await executeLegacyTool(context.get(IAgentToolExecutorService), [
        { id: 'disabled-mutation', name: 'ExampleMutation', type: 'function', arguments: '{}' },
      ], { turnId: 1 });
      expect(execute).not.toHaveBeenCalled();
      stopped = Promise.resolve();
    }
    expect(intent.read().generation).not.toBe(before.generation);
    expect(intentAllowsEffects(intent.read().state.current)).toBe(false);
    held.release();
    await completion;
    await stopped;
    await vi.waitFor(() => expect(intent.read().state.current?.analysis?.status).toBe('interrupted'));
    expect(intent.read().error).toBeUndefined();
    await context.get(IEventDispatcher).restore();
    expect(intent.read().state.current?.analysis?.status).toBe('interrupted');
  });

  it('serializes concurrent deep startup before any model request', async () => {
    const { context, loop, intent } = await setup();
    const held = holdFlush(context);
    context.mockNextResponse({ type: 'text', text: 'Investigating.' });
    const first = intent.command('Implement a stable API.');
    await held.entered;
    await expect(intent.command('A second request')).rejects.toThrow('busy');
    held.release();
    await first;
    await loop.settled();
    expect(context.llmCalls).toHaveLength(1);
    expect(intent.read().state.current?.analysis?.ledger).toHaveLength(1);
    expect(intent.read().state.current?.sourceRefs.some((source) => source.text === 'A second request')).toBe(false);
  });

  it('cancels startup while its initial state is still being saved', async () => {
    const { context, intent } = await setup();
    const held = holdFlush(context);
    const starting = expect(intent.command('Implement a stable API.')).rejects.toThrow('phase_denied');
    await held.entered;
    const cancelled = intent.command('--cancel');
    held.release();
    await starting;
    await cancelled;
    expect(context.llmCalls).toHaveLength(0);
  });

  it('persists active elapsed time before the turn ends and preserves it on recovery', async () => {
    const { context, loop, intent } = await setup();
    await start(context, intent, loop);
    const baseline = intent.read().state.current!.analysis!.activeMs;
    let current = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => current);
    const event = context.get(IEventDispatcher);
    const original = event.dispatch.bind(event);
    const savedTimes: number[] = [];
    let turnEnded = false;
    vi.spyOn(event, 'dispatch').mockImplementation(async (item) => {
      if (item instanceof TurnEnded) turnEnded = true;
      if (item instanceof IntentCommitted && !turnEnded) {
        const state = item.state as ReturnType<IIntentService['read']>['state'];
        savedTimes.push(state.current?.analysis?.activeMs ?? 0);
      }
      return original(item);
    });
    const hook = loop.requester.registerHook({
      beforeAttempt: () => { current += 5000; },
    });
    context.mockNextResponse({ type: 'text', text: 'Measured investigation.' });
    const measured = loop.submit({ message: { role: 'user', content: [{ type: 'text', text: 'Measure.' }] },
      meta: { origin: { kind: 'system_trigger' } } });
    await loop.promptHandle(measured.id)!.completion;
    hook.dispose();
    expect(savedTimes.some((time) => time - baseline >= 5000)).toBe(true);
    const recorded = intent.read().state.current!.analysis!.activeMs;
    expect(recorded - baseline).toBeGreaterThanOrEqual(5000);
    await event.restore();
    expect(intent.read().state.current!.analysis!.activeMs).toBeGreaterThanOrEqual(recorded);
  });

  it('retains disabled-period corrections across context clear and recovery', async () => {
    const { context, loop, intent, disable, enable } = await setup();
    await start(context, intent, loop);
    await intent.update(complete(intent));
    disable();
    context.mockNextResponse({ type: 'text', text: 'Correction received.' });
    await loop.submit({ input: [{ type: 'text', text: 'Change the API after all.' }] });
    await loop.settled();
    context.clearContext();
    await context.get(IEventDispatcher).restore();
    enable();
    const task = intent.read().state.current!;
    expect(task.sourceRefs.some((source) => source.text === 'Change the API after all.')).toBe(true);
    expect(intentAllowsEffects(task)).toBe(false);
    expect(task.analysis).toBeUndefined();
  });

  it('rejects stale updates after undo restores the same revision', async () => {
    const { context, loop, intent } = await setup();
    context.mockNextResponse({ type: 'text', text: 'Initial request received.' });
    await loop.submit({ input: [{ type: 'text', text: 'Keep the API stable.' }] });
    await loop.settled();
    const before = intent.read();
    const original = before.state.current!;
    const late: IntentUpdate = { operationId: 'late-review', intentId: original.intentId,
      generation: before.generation, expectedRevision: original.revision,
      handledInputs: original.observedInputs, reviewReason: 'Preserve compatibility.' };
    context.mockNextResponse({ type: 'text', text: 'Correction received.' });
    await loop.submit({ input: [{ type: 'text', text: 'Investigate the CLI too.' }] });
    await loop.settled();
    expect(intent.read().state.current?.revision).toBeGreaterThan(original.revision);
    expect(await context.undoHistory(1)).toBe(1);
    const restored = intent.read();
    expect(restored.state.current?.revision).toBe(original.revision);
    expect(restored.generation).not.toBe(before.generation);
    expect(restored.state.current?.sourceRefs.some((source) => source.text === 'Investigate the CLI too.')).toBe(false);
    await expect(intent.update(late)).rejects.toThrow('stale_version');
    expect(intent.read().state.operations.some((operation) => operation.operationId === late.operationId)).toBe(false);
    await expect(intent.update({ ...late, generation: restored.generation })).resolves.toBeDefined();
  });

  it('keeps restored session branches independent', async () => {
    const original = await setup();
    await start(original.context, original.intent, original.loop);
    await original.intent.update(complete(original.intent));
    const originalView = original.intent.read();
    const branch = await setup();
    await branch.context.restore(await original.context.persistedWireRecords());
    const branchView = branch.intent.read();
    expect(branchView.state.current).toEqual(originalView.state.current);
    expect(branchView.generation).not.toBe(originalView.generation);
    await expect(branch.intent.update({ operationId: 'old-branch', intentId: originalView.state.current!.intentId,
      generation: originalView.generation, expectedRevision: originalView.state.current!.revision })).rejects.toThrow('stale_version');
    branch.context.mockNextResponse({ type: 'text', text: 'Branch correction received.' });
    await branch.loop.submit({ input: [{ type: 'text', text: 'Change only this branch.' }] });
    await branch.loop.settled();
    expect(branch.intent.read().state.current?.sourceRefs.some((source) => source.text === 'Change only this branch.')).toBe(true);
    expect(original.intent.read()).toEqual(originalView);
    expect(branch.intent.read().state.current?.analysis).toBeUndefined();
    expect(original.intent.read().state.current?.analysis?.status).toBe('ready');
  });

  it('does not grant a forked subagent permission to alter the main Intent', async () => {
    const { context, loop, intent } = await setup();
    await start(context, intent, loop);
    const before = intent.read();
    const lifecycle = context.get(IAgentLifecycleService);
    const fork = await lifecycle.fork(lifecycle.get('main')!, { agentId: 'intent-fork' });
    const child = lifecycle.handleOf(fork.agentId)!;
    expect(child.accessor.get(IAgentLoopService).history().length).toBeGreaterThan(0);
    const childIntent = child.accessor.get(IIntentService);
    expect(childIntent.read().state.current).toBeUndefined();
    await expect(childIntent.update({ operationId: 'child-update', intentId: before.state.current!.intentId,
      generation: before.generation, expectedRevision: before.state.current!.revision })).rejects.toThrow('disabled');
    await expect(childIntent.command('Change the parent requirement.')).rejects.toThrow('disabled');
    expect(intent.read()).toEqual(before);
  });
});
