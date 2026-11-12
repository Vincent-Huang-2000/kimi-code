import { createHash, randomUUID } from 'node:crypto';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { toDisposable } from '#/_base/di/lifecycle';
import { IAgentLoopService } from '#/agent/loop/loop';
import { CommandOutput } from '#/agent/command/commandEvents';
import { userInputText } from '#/agent/loop/history';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { EnvironmentWorkspaceView } from '#/environment/environmentWorkspaceView';
import { IEventBus } from '#/app/event/eventBus';
import { IEventService } from '#/app/event/event';
import { promptMetadataTextFromText } from '#/agent/prompt/promptMetadataText';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { TurnEnded } from '#/agent/loop/turnOps';
import { reserveIntentRequest, settleIntentUsage, estimateIntentRequestTokens, intentBudgetLevel } from './intentBudget';
import type { LoopRequestAttemptContext, LoopRequestAttemptOutcomeContext } from '#/agent/loop/requesterContract';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { INTENT_ENGINE_FLAG } from './flag';
import { IntentCommitted } from './intentOps';
import { applyIntentUpdate, fingerprint, intentAllowsEffects, intentProjection, INTENT_READ_TOOLS } from './intentPolicy';
import { createIntentTask, emptyIntentState, IntentBudgetSchema, IntentError, IntentStateSchema,
  type IntentState, type IntentSource, type IntentUpdate, type IntentUsage } from './intentState';

const DEEP_REQUEST_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'deep_request' };
const DEEP_CONTINUE_ORIGIN: PromptOrigin = { kind: 'system_trigger', name: 'deep_continue' };

export interface IIntentService {
  readonly _serviceBrand: undefined;
  read(): { generation: string; state: IntentState; error?: string };
  update(input: IntentUpdate): Promise<unknown>;
  command(args: string): Promise<void>;
  investigate(prompt: string, signal: AbortSignal): Promise<string>;
  bindInvestigation(owner: AgentIntentService, view: string, generation: string, revision: number): void;
}
export const IIntentService = createDecorator<IIntentService>('intentService');

const INSTRUCTION = 'Maintain task requirements during normal work with Intent; do not make a separate analysis request. ' +
  'Read details only when needed. Preserve user sources; never treat assumptions, system messages or subagent output as user confirmation. ' +
  'Review pending user input before project modifications: submit sourced changes or handledInputs with reviewReason explaining no change. ' +
  'Use newTaskSourceId only for an explicit task switch. Keep acceptance verification separate from task completion. ' +
  'During deep, investigate read-only, ask only blocking questions, then record a goal, constraints, acceptance and minimal next actions. ' +
  'Commit completeAnalysisRunId before development; only a later tool batch may modify the project. ' +
  'Completion keeps the same task and history and grants no new authorization: discussion-only requests remain discussion-only. ' +
  'Reuse valid findings and preparation; recheck affected evidence and current file contents as necessary. ' +
  'If questions are unavailable or unanswered, state the missing information and stop without inventing answers.';

export class AgentIntentService extends Service implements IIntentService {
  declare readonly _serviceBrand: undefined;
  private optimistic = emptyIntentState();
  private confirmed = emptyIntentState();
  private generation = randomUUID();
  private failure: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, IntentSource>();
  private readonly batches = new Map<string, { generation: string; effects: boolean }>();
  private readonly children = new Map<string, AbortController>();
  private readonly questions = new Map<string, { generation: string; revision: number; runId?: string }>();
  private delegation: { owner: AgentIntentService; view: string; generation: string; revision: number } | undefined;
  private restored = false;
  private disabled = false;
  private lastEnabled: boolean;
  private readonly turnRuns = new Map<number, string>();
  private activeSince: number | undefined;
  private activeTimer: ReturnType<typeof setTimeout> | undefined;
  private budgetStopped = false;
  private interruptedRun: string | undefined;
  private starting: Promise<void> | undefined;
  private startCancellation: string | undefined;
  private readonly reservations = new Map<string, { generation: string; runId?: string; started: number }>();
  private pausedByQuestion: string | undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scope: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolExecutorService private readonly executor: IAgentToolExecutorService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentReminderService private readonly reminder: IAgentReminderService,
    @IFlagService private readonly flags: IFlagService,
    @IConfigService private readonly configuration: IConfigService,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentEnvironmentService private readonly environment: IAgentEnvironmentService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IEventService private readonly eventService: IEventService,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
    this.lastEnabled = flags.enabled(INTENT_ENGINE_FLAG);
    const participant = {
      id: 'intent', events: [IntentCommitted], undoable: true,
      getState: () => this.optimistic,
      commit: (state: IntentState) => { this.optimistic = state; },
      transition: (_state: IntentState, event: unknown) => event instanceof IntentCommitted
        ? IntentStateSchema.parse(event.state) : undefined,
      onWillReplay: () => {
        this.generation = randomUUID();
        this.pausedByQuestion = undefined;
        this.restored = false;
        this.pauseClock();
        this.pending.clear();
        this.stopInvestigations();
      },
      onDidReplay: (state: IntentState, outcome: { ok: boolean }) => {
        this.confirmed = structuredClone(state);
        this.failure = outcome.ok ? undefined : 'Intent replay failed.';
        const run = this.confirmed.current?.analysis;
        if (run !== undefined && run.status !== 'ready') {
          run.status = 'interrupted';
          run.reason = 'recovery';
          run.pendingQuestions = [];
        }
        this.restored = outcome.ok;
        this.budgetStopped = false;
        this.interruptedRun = undefined;
      },
    };
    if (dispatcher.restorePhase === 'ready') {
      void dispatcher.attachLate(participant).then((attachment) => {
        this._register(attachment);
      }).catch((error: unknown) => { this.failure = String(error); });
    } else this._register(dispatcher.attach(participant));
    this._register(loop.onDidAppendMessage((message) => { this.observe(message); }));
    this._register(loop.hooks.onWillBeginStep.register('intent-input', async (context, next) => {
      this.checkFlag();
      const runId = this.confirmed.current?.analysis?.id;
      if (context.firstStepOfTurn && runId !== undefined) this.turnRuns.set(context.turnId, runId);
      if (this.confirmed.current !== undefined) for (const message of loop.history()) this.observe(message);
      if (this.enabled() || this.confirmed.current !== undefined) await this.syncInputs();
      if (this.enabled()) await this.refreshFindings();
      await next();
    }));
    this._register(loop.hooks.onDidFinishStep.register('intent-question', async (context, next) => {
      const paused = this.pausedByQuestion;
      this.pausedByQuestion = undefined;
      if (paused !== undefined) {
        // End the turn here: a later request would be refused because the analysis is no longer active.
        // Record the question result now, since no further step will sync it.
        await this.syncInputs().catch(() => undefined);
        context.stopTurn = true;
        context.stopReason = paused;
        this.show(paused);
      }
      await next();
    }));
    this._register(reminder.register<string>('intent', async (context) => {
      if (this.delegation !== undefined) return context.lastInjection === undefined ? this.delegation.view : undefined;
      if (!this.enabled()) return undefined;
      await this.syncInputs();
      if (this.confirmed.current === undefined) return undefined;
      const task = this.confirmed.current;
      const disclosure = fingerprint([this.generation, task.intentId, task.revision, task.items, task.decisions,
        task.findings, task.executionPreparation, task.observedInputs, task.handledInputs,
        task.analysis?.id, task.analysis?.status, task.analysis?.reason, intentBudgetLevel(task.analysis), this.failure]);
      if (context.lastDisclosure === disclosure) return undefined;
      return { content: `${INSTRUCTION}\n${intentProjection(this.confirmed, this.generation)}`, disclosure };
    }));
    this._register(loop.registerToolBatchStarting((event) => {
      this.checkFlag();
      const snapshot = { generation: this.generation,
        effects: this.interruptedRun === undefined && !this.hasPendingUserInput() && this.failure === undefined && intentAllowsEffects(this.confirmed.current) };
      for (const call of event.toolCalls) this.batches.set(call.id, snapshot);
    }));
    this._register(executor.registerHook({
      beforeExecute: async (context) => {
        if (this.enabled() && context.call.name === 'AskUserQuestion' && this.isBuiltinTool('AskUserQuestion')) {
          if (context.args?.background !== true) this.pauseClock();
          await this.syncInputs();
          await this.serial(async () => {
            const next = structuredClone(this.confirmed);
            const run = next.current?.analysis;
            this.questions.set(context.call.id, { generation: this.generation,
              revision: next.current?.revision ?? 0, runId: run?.id });
            if (run?.status === 'analyzing' || run?.status === 'waiting_for_answer') {
              run.status = 'waiting_for_answer';
              run.pendingQuestions.push(context.call.id);
              await this.save(next);
            }
          });
        }
      },
      executing: (context) => {
        this.checkFlag();
        const name = context.call.name;
        if (this.delegation !== undefined) {
          if (!this.delegationValid() || !this.readOnlyTool(name) || name === 'Intent' || name === 'AskUserQuestion') {
            return { reject: 'Intent investigation is read-only or its task view has expired.' };
          }
          return;
        }
        if (!this.enabled() && !this.disabled) return;
        if (this.readOnlyTool(name) || (name === 'IntentInvestigate' && this.isBuiltinTool(name))) return;
        const batch = this.batches.get(context.call.id);
        if (this.disabled || this.interruptedRun !== undefined || this.failure !== undefined || this.hasPendingUserInput() || !intentAllowsEffects(this.confirmed.current) ||
          batch?.effects === false || (batch !== undefined && batch.generation !== this.generation)) {
          return { reject: 'Intent requires review or unfinished analysis. Read Intent; finish and save analysis before a later modification batch.' };
        }
      },
      afterExecute: async (context) => {
        if (!this.enabled()) return;
        const output = context.result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
        const question = this.questions.get(context.call.id);
        let kind: IntentSource['kind'] = 'tool_result';
        let sourceText = output;
        if (question !== undefined) {
          this.questions.delete(context.call.id);
          if (this.confirmed.current?.analysis?.status === 'waiting_for_answer') this.startClock();
          const run = this.confirmed.current?.analysis;
          if (context.result.outcome.type === 'success' && question.generation === this.generation &&
            !this.hasPendingUserInput() && question.revision === this.confirmed.current?.revision && question.runId === run?.id) {
            try {
              const parsed: unknown = JSON.parse(output);
              if (parsed !== null && typeof parsed === 'object' && 'answers' in parsed &&
                parsed.answers !== null && typeof parsed.answers === 'object' &&
                Object.values(parsed.answers).some((value) => value === true || (typeof value === 'string' && value.trim().length > 0))) {
                kind = 'user_answer';
                sourceText = Object.entries(parsed.answers).flatMap(([key, value]) =>
                  value === true ? [key] : typeof value === 'string' && value.trim().length > 0 ? [value] : []).join('\n');
              }
            } catch {}
          }
          await this.serial(async () => {
            const next = structuredClone(this.confirmed);
            const active = next.current?.analysis;
            if (active !== undefined && active.id === question.runId) {
              active.pendingQuestions = active.pendingQuestions.filter((id) => id !== context.call.id);
              if (active.status === 'waiting_for_answer') {
                if (context.result.outcome.type === 'failed') {
                  active.status = 'failed';
                  active.reason = context.result.outcome.error.type === 'output' ? 'question_output_failed' : 'question_failed';
                } else if (context.result.outcome.type === 'aborted') {
                  active.status = 'interrupted';
                  active.reason = 'cancelled';
                } else if (active.pendingQuestions.length === 0) {
                  active.status = kind === 'user_answer' ? 'analyzing' : 'interrupted';
                  active.reason = kind === 'user_answer' ? undefined : 'answer_required';
                }
              }
              await this.save(next);
              if (active.status === 'failed' || active.status === 'interrupted') this.pauseClock();
              if (active.status === 'interrupted' && active.reason === 'answer_required') {
                this.pausedByQuestion = 'Deep analysis paused: the question was not answered. ' +
                  'Run /deep --continue to ask again, or /deep <request> to start a new analysis.';
              } else if (active.status === 'failed') {
                this.pausedByQuestion = `Deep analysis stopped: the question tool failed (${active.reason}). ` +
                  'Resolve the reported error, then run /deep --continue.';
              }
            }
          });
        }
        const files = context.call.name === 'Read' && context.result.outcome.type === 'success' &&
          context.prepared?.kind === 'execute' && this.isBuiltinTool('Read')
          ? await this.captureEvidence((context.prepared.accesses ?? []).flatMap((access) =>
            access.kind === 'file' && access.operation === 'read' && access.recursive !== true ? [access.path] : []))
          : undefined;
        if (output.trim().length > 0 && context.call.name !== 'Intent' && context.call.name !== 'IntentInvestigate') this.pending.set(`tool:${context.call.id}`, {
          id: `tool:${context.call.id}`, kind, text: sourceText.slice(0, 32000),
          relatedRunId: question?.runId, generation: this.generation, files,
        });
        if (context.prepared?.kind === 'execute') {
          const writes = context.prepared.accesses?.filter((access) => access.kind === 'all' ||
            access.operation === 'write' || access.operation === 'readwrite') ?? [];
          if (writes.length > 0) await this.invalidateFindings(writes.map((access) => access.kind === 'all' ? '*' : access.path));
        }
      },
    }));
    this._register(configuration.onDidChangeConfiguration(() => { this.checkFlag(); }));
    this._register(loop.requester.registerHook({
      beforeAttempt: async (context) => {
        this.checkFlag();
        if (this.delegation !== undefined) {
          if (!this.delegationValid()) throw new IntentError('stale_version', 'Investigation view expired.');
          await this.delegation.owner.admit(context, this.scope.agentId, this.delegation);
        } else if (this.enabled()) {
          await this.syncInputs();
          await this.admit(context, this.scope.agentId);
        }
      },
      afterAttempt: async (context) => {
        const owner = this.delegation?.owner ?? this;
        await owner.settle(context, this.scope.agentId);
      },
    }));
    this._register(eventBus.subscribe(TurnEnded, (event) => {
      if (event.agentId !== this.scope.agentId) return;
      this.pauseClock();
      this.disabled = false;
      this.pausedByQuestion = undefined;
      const runId = this.turnRuns.get(event.turnId);
      this.turnRuns.delete(event.turnId);
      if (!this.enabled() || this.confirmed.current?.analysis === undefined ||
        this.confirmed.current.analysis.id !== runId) return;
      if ((event.reason === 'failed' || event.reason === 'cancelled') &&
        ['analyzing', 'waiting_for_answer'].includes(this.confirmed.current.analysis.status)) {
        this.stopInvestigations();
        void this.interrupt(event.reason).catch(() => undefined);
      } else void this.serial(() => this.save(structuredClone(this.confirmed))).catch(() => undefined);
    }));
    this._register(toDisposable(() => { this.pauseClock(); this.stopInvestigations(); }));
  }

  private hasPendingUserInput(): boolean {
    return [...this.pending.values()].some((source) => source.kind === 'user_input' || source.kind === 'user_answer');
  }

  private enabled(): boolean { return this.scope.agentId === MAIN_AGENT_ID && this.flags.enabled(INTENT_ENGINE_FLAG); }

  read(): { generation: string; state: IntentState; error?: string } {
    return { generation: this.generation, state: structuredClone(this.confirmed), error: this.failure };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async save(next: IntentState): Promise<void> {
    if (this.failure !== undefined) throw new IntentError('persistence_failed', this.failure);
    const generation = this.generation;
    this.sampleClock();
    if (next.current?.analysis?.id === this.confirmed.current?.analysis?.id && next.current?.analysis !== undefined) {
      next.current.analysis.activeMs = Math.max(next.current.analysis.activeMs, this.confirmed.current?.analysis?.activeMs ?? 0);
    }
    next = IntentStateSchema.parse(next);
    try {
      await this.dispatcher.dispatch(new IntentCommitted({ agentId: this.scope.agentId, state: next }));
      await this.dispatcher.flush({ strict: true });
    } catch (error) {
      this.failure = String(error);
      this.stopInvestigations();
      throw new IntentError('persistence_failed', `${String(error)}. Reload the session to reconcile saved operations.`);
    }
    if (generation !== this.generation) throw new IntentError('stale_version', 'State changed during persistence.');
    this.confirmed = next;
    if (next.current?.analysis?.status === 'ready') this.pauseClock();
  }

  private observe(message: ContextMessage): void {
    if (this.scope.agentId !== MAIN_AGENT_ID || !this.restored || message.id === undefined ||
      message.role !== 'user' || message.origin?.kind !== 'user') return;
    if (!this.enabled() && this.confirmed.current === undefined) return;
    if (this.confirmed.current?.observedInputs.includes(message.id) ||
      this.confirmed.archives.some((task) => task.observedInputs.includes(message.id!)) || this.pending.has(message.id)) return;
    const text = userInputText(message) ?? '';
    if (text.trim().length > 0) this.pending.set(message.id, { id: message.id, kind: 'user_input', text: text.slice(0, 32000) });
  }

  private syncInputs(): Promise<void> {
    return this.serial(async () => {
      if (this.pending.size === 0) return;
      const sources = [...this.pending.values()];
      const next = structuredClone(this.confirmed);
      for (const source of sources) {
        if (next.current === undefined) {
          if (source.kind === 'user_input') next.current = createIntentTask(randomUUID(), source);
          continue;
        }
        if (next.current.sourceRefs.some((entry) => entry.id === source.id)) continue;
        next.current.sourceRefs.push(source);
        if (source.kind === 'user_input' || source.kind === 'user_answer') {
          next.current.observedInputs.push(source.id);
          next.current.revision++;
          if (next.current.analysis?.status === 'ready') next.current.analysis = undefined;
        }
      }
      await this.save(next);
      for (const source of sources) if (this.pending.get(source.id) === source) this.pending.delete(source.id);
    });
  }

  async update(input: IntentUpdate): Promise<unknown> {
    if (!this.enabled()) throw new IntentError('disabled', 'Intent updates are only available on the main agent with intent_engine enabled.');
    await this.syncInputs();
    return this.serial(async () => {
      if (!this.enabled()) throw new IntentError('disabled', 'Intent Engine is disabled.');
      const proposal = structuredClone(input);
      for (const finding of proposal.findings ?? []) {
        finding.files = finding.files.map((file) => {
          const trusted = finding.sources.flatMap((ref) =>
            this.confirmed.current?.sourceRefs.find((source) => source.id === ref.sourceId)?.files ?? [])
            .find((entry) => entry.path === file.path);
          if (trusted === undefined) throw new IntentError('invalid_source', 'File findings require evidence from an authorized Read result.');
          return trusted;
        });
      }
      const updated = applyIntentUpdate(this.confirmed, proposal, this.generation, randomUUID());
      if (updated.state !== this.confirmed) {
        await this.save(updated.state);
        if (input.newTaskSourceId !== undefined) {
          this.pauseClock();
          this.generation = randomUUID();
          this.interruptedRun = undefined;
          this.budgetStopped = false;
          this.stopInvestigations();
        }
      }
      return { ...updated.result, summary: intentProjection(this.confirmed, this.generation) };
    });
  }

  private isBuiltinTool(name: string): boolean {
    return this.tools.listReferences().find((tool) => tool.name === name)?.source === 'builtin';
  }

  private readOnlyTool(name: string): boolean {
    return INTENT_READ_TOOLS.has(name) && this.isBuiltinTool(name);
  }

  private checkFlag(): void {
    const enabled = this.flags.enabled(INTENT_ENGINE_FLAG);
    const wasEnabled = this.lastEnabled;
    this.lastEnabled = enabled;
    if (!enabled && wasEnabled && this.starting !== undefined) this.startCancellation = 'feature_disabled';
    if (!enabled && wasEnabled && this.confirmed.current?.analysis !== undefined &&
      ['analyzing', 'waiting_for_answer'].includes(this.confirmed.current.analysis.status)) {
      this.disabled = true;
      const interrupted = this.interrupt('feature_disabled');
      this.loop.cancel(undefined, 'Intent Engine disabled');
      void interrupted.catch(() => undefined);
    }
    if (enabled) this.disabled = false;
  }

  private stopInvestigations(): void {
    for (const controller of this.children.values()) controller.abort('Intent analysis interrupted');
    this.children.clear();
    for (const toolCallId of this.questions.keys()) {
      this.loop.abortTool(toolCallId, 'Intent analysis interrupted');
      void this.executor.handlerForCall(toolCallId)?.stop('Intent analysis interrupted').catch(() => undefined);
    }
    this.questions.clear();
  }

  private interrupt(reason: string): Promise<void> {
    const run = this.confirmed.current?.analysis;
    if (run === undefined || run.status === 'ready') return Promise.resolve();
    if (this.interruptedRun === run.id) return this.queue.then(() => undefined);
    this.interruptedRun = run.id;
    this.generation = randomUUID();
    this.pauseClock();
    this.stopInvestigations();
    return this.serial(async () => {
      const next = structuredClone(this.confirmed);
      if (next.current?.analysis?.id !== run.id) return;
      next.current.analysis.status = reason === 'failed' ? 'failed' : 'interrupted';
      next.current.analysis.reason = reason;
      next.current.analysis.pendingQuestions = [];
      await this.save(next);
    });
  }

  private async captureEvidence(paths: readonly string[]): Promise<NonNullable<IntentSource['files']>> {
    const files: NonNullable<IntentSource['files']> = [];
    if (paths.length === 0 || !this.environment.isAvailable(['fs'])) return files;
    const lease = this.environment.acquire(['fs']);
    try {
      const view = new EnvironmentWorkspaceView(lease.environment, this.environment.workspaceRoots());
      for (const path of paths.slice(0, 30)) {
        try {
          const resolved = view.assertAllowed(await lease.environment.fs!.realpath(view.resolve(path)));
          const head = await lease.environment.fs!.readFileHead(resolved, 2_000_000);
          if (!head.stat.isFile || head.stat.size > head.bytes.length) continue;
          files.push({ path, cwd: view.workDir, environmentId: lease.environment.identity.environmentId,
            environmentGeneration: lease.environment.identity.generation,
            fingerprint: createHash('sha256').update(head.bytes).digest('hex') });
        } catch {}
      }
      return files;
    } finally { lease.dispose(); }
  }

  private async refreshFindings(): Promise<void> {
    const task = this.confirmed.current;
    if (task === undefined) return;
    const paths = [...new Set(task.findings.filter((finding) => finding.status === 'valid').flatMap((finding) =>
      finding.files.map((file) => file.path)))];
    if (paths.length === 0) return;
    const current = await this.captureEvidence(paths);
    await this.serial(async () => {
      if (this.confirmed.current?.intentId !== task.intentId) return;
      const next = structuredClone(this.confirmed);
      let changed = false;
      for (const finding of next.current!.findings) {
        if (finding.status !== 'valid') continue;
        if (finding.files.some((file) => !current.some((entry) => fingerprint(entry) === fingerprint(file)))) {
          finding.status = 'review';
          changed = true;
          for (const item of next.current!.items) {
            if (item.kind === 'acceptance' && item.evidence?.some((ref) =>
              finding.sources.some((source) => source.sourceId === ref.sourceId))) item.verification = 'unverified';
          }
        }
      }
      if (changed) await this.save(next);
    });
  }

  private invalidateFindings(paths: readonly string[]): Promise<void> {
    return this.serial(async () => {
      const next = structuredClone(this.confirmed);
      let changed = false;
      for (const finding of next.current?.findings ?? []) {
        if (finding.status === 'valid' && finding.files.some((file) => paths.some((path) => path === '*' || file.path === path))) {
          finding.status = 'review';
          changed = true;
          for (const item of next.current!.items) {
            if (item.kind === 'acceptance' && item.evidence?.some((ref) =>
              finding.sources.some((source) => source.sourceId === ref.sourceId))) item.verification = 'unverified';
          }
        }
      }
      if (changed) await this.save(next);
    });
  }

  async command(args: string): Promise<void> {
    if (!this.enabled()) throw new IntentError('disabled', 'Enable KIMI_CODE_EXPERIMENTAL_INTENT_ENGINE=1 to use /deep.');
    const input = args.trim();
    if (input.length > 32000) throw new IntentError('invalid_transition', 'Deep requests must not exceed 32000 characters.');
    if (input === '--status') {
      this.show(intentProjection(this.confirmed, this.generation) + (this.failure === undefined ? '' : `\nSave failed: ${this.failure}`));
      return;
    }
    if (input === '--cancel') {
      if (this.starting !== undefined) {
        this.startCancellation = 'cancelled';
        await this.starting.catch(() => undefined);
      }
      const run = this.confirmed.current?.analysis;
      if (run === undefined || !['analyzing', 'waiting_for_answer'].includes(run.status)) {
        this.show(intentProjection(this.confirmed, this.generation));
        return;
      }
      const interrupted = this.interrupt('cancelled');
      this.loop.cancel(undefined, 'Deep cancelled');
      await interrupted;
      this.show(intentProjection(this.confirmed, this.generation));
      return;
    }
    if (input.startsWith('--') && input !== '--continue') throw new IntentError('invalid_transition', 'Usage: /deep [request] | --continue | --cancel | --status');
    if (this.starting !== undefined) throw new IntentError('busy', 'Deep analysis is already starting.');
    this.startCancellation = undefined;
    const starting = this.startAnalysis(input);
    this.starting = starting;
    try { await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  private async startAnalysis(input: string): Promise<void> {
    if (this.loop.snapshot().state !== 'idle' || this.loop.snapshot().hasPendingRequests) throw new IntentError('busy', 'Wait for the current turn before /deep. Your request was not submitted.');
    for (const agent of this.lifecycle.list()) {
      const handle = this.lifecycle.handleOf(agent.agentId);
      const active = handle?.accessor.get(IAgentTaskService).list(true) ?? [];
      if (active.length > 0 || (agent.agentId !== MAIN_AGENT_ID && handle?.accessor.get(IAgentLoopService).snapshot().state !== 'idle')) {
        throw new IntentError('busy', `Resolve running work before /deep: ${active.map((task) => task.taskId).join(', ') || agent.agentId}`);
      }
    }
    await this.syncInputs();
    const continuing = input === '--continue';
    if (input.length > 0 && !continuing) {
      const source = { id: `deep:${randomUUID()}`, kind: 'user_input' as const, text: input };
      this.pending.set(source.id, source);
      await this.syncInputs();
    }
    if (this.confirmed.current === undefined) throw new IntentError('no_task', 'Usage: /deep <request>.');
    await this.serial(async () => {
      if (this.startCancellation !== undefined || !this.enabled()) throw new IntentError('phase_denied', 'Deep startup was cancelled.');
      const next = structuredClone(this.confirmed);
      const task = next.current!;
      if (continuing) {
        if (task.analysis === undefined || !['interrupted', 'failed'].includes(task.analysis.status)) {
          throw new IntentError('invalid_transition', 'No interrupted analysis to continue.');
        }
        task.analysis.status = 'analyzing';
        task.analysis.reason = undefined;
        task.analysis.pendingQuestions = [];
        task.analysis.boundRevision = task.revision;
      } else {
        task.analysis = { id: randomUUID(), requestId: randomUUID(), status: 'analyzing',
          boundRevision: task.revision, budget: IntentBudgetSchema.parse(this.configuration.get('intent') ?? {}),
          ledger: [], pendingQuestions: [], activeMs: 0 };
      }
      await this.save(next);
    });
    if (this.startCancellation !== undefined || !this.enabled()) {
      await this.interrupt(this.startCancellation ?? 'feature_disabled');
      throw new IntentError('phase_denied', 'Deep startup was cancelled.');
    }
    this.generation = randomUUID();
    this.interruptedRun = undefined;
    this.budgetStopped = false;
    this.show('Deep analysis started. Findings remain available in the current task.');
    const request = input.length > 0 && !continuing;
    const entry = this.loop.submit({ message: { role: 'user', content: [{ type: 'text', text:
      request ? input : 'Continue the current task with one-shot deep analysis.' }] },
      meta: { origin: request ? DEEP_REQUEST_ORIGIN : DEEP_CONTINUE_ORIGIN } });
    if (request) {
      await applyPromptMetadataUpdate({ metadata: this.metadata, eventService: this.eventService,
        sessionId: this.sessionContext.sessionId }, promptMetadataTextFromText(`/deep ${input}`));
    }
    const startedRunId = this.confirmed.current?.analysis?.id;
    const handle = this.loop.promptHandle(entry.id);
    void handle?.completion.then(async (completion) => {
      const run = this.confirmed.current?.analysis;
      if (run !== undefined && run.id === startedRunId &&
        ['analyzing', 'waiting_for_answer'].includes(run.status) &&
        (completion.state === 'failed' || completion.state === 'cancelled' || completion.state === 'blocked')) {
        this.stopInvestigations();
        await this.interrupt(completion.state);
      }
    }).catch((error: unknown) => { this.failure = String(error); });
  }

  private show(text: string): void {
    void this.dispatcher.dispatch(new CommandOutput({ agentId: this.scope.agentId, command: 'deep', text }));
  }

  bindInvestigation(owner: AgentIntentService, view: string, generation: string, revision: number): void {
    this.delegation = { owner, view, generation, revision };
  }

  private delegationValid(): boolean {
    const delegation = this.delegation;
    return delegation !== undefined && delegation.owner.enabled() && delegation.owner.generation === delegation.generation &&
      delegation.owner.confirmed.current?.revision === delegation.revision && delegation.owner.failure === undefined &&
      !delegation.owner.hasPendingUserInput() && delegation.owner.interruptedRun === undefined &&
      delegation.owner.children.has(this.scope.agentId) && !delegation.owner.budgetStopped;
  }

  private startClock(): void {
    const run = this.confirmed.current?.analysis;
    if (run === undefined || (run.status !== 'analyzing' && run.status !== 'waiting_for_answer') || this.activeSince !== undefined) return;
    this.activeSince = Date.now();
    this.activeTimer = setTimeout(() => {
      this.budgetStopped = true;
      const interrupted = this.interrupt('budget_exhausted');
      this.loop.cancel(undefined, 'Deep active-time budget exhausted');
      void interrupted.then(() => { this.show(intentProjection(this.confirmed, this.generation)); }).catch(() => undefined);
    }, Math.max(0, run.budget.maxActiveMs - run.activeMs));
    this.activeTimer.unref();
  }

  private pauseClock(): void {
    if (this.activeTimer !== undefined) clearTimeout(this.activeTimer);
    this.activeTimer = undefined;
    this.sampleClock();
    this.activeSince = undefined;
  }

  private sampleClock(): void {
    const run = this.confirmed.current?.analysis;
    if (this.activeSince === undefined || run === undefined) return;
    const now = Date.now();
    run.activeMs += Math.max(0, now - this.activeSince);
    this.activeSince = now;
  }

  private async admit(context: LoopRequestAttemptContext, agentId: string,
    binding?: { generation: string; revision: number }): Promise<void> {
    await this.serial(async () => {
      if (binding !== undefined && (binding.generation !== this.generation ||
        binding.revision !== this.confirmed.current?.revision || this.hasPendingUserInput())) {
        throw new IntentError('stale_version', 'Investigation view expired before request admission.');
      }
      if (this.failure !== undefined) throw new IntentError('persistence_failed', this.failure);
      if (this.interruptedRun !== undefined || this.disabled) throw new IntentError('phase_denied', 'Analysis was interrupted.');
      this.sampleClock();
      const next = structuredClone(this.confirmed);
      const task = next.current;
      if (task === undefined) return;
      const run = task.analysis;
      if (run !== undefined && run.status !== 'ready' &&
        (this.budgetStopped || !['analyzing', 'waiting_for_answer'].includes(run.status))) {
        throw new IntentError('phase_denied', 'Analysis is interrupted. Use /deep --continue or start a new explicit analysis.');
      }
      const key = `${agentId}:${context.logicalRequestId}:${context.attempt}`;
      const ledger = run !== undefined && run.status !== 'ready' ? run.ledger : next.maintenanceLedger;
      if (ledger.some((entry) => entry.requestId === key)) return;
      let charged = estimateIntentRequestTokens(context.request);
      if (run !== undefined && run.status !== 'ready') {
        try { charged = reserveIntentRequest(run, context.request); }
        catch (error) {
          this.budgetStopped = true;
          this.interruptedRun = run.id;
          this.generation = randomUUID();
          this.pauseClock();
          this.stopInvestigations();
          run.status = 'interrupted';
          run.reason = 'budget_exhausted';
          await this.save(next);
          this.show(intentProjection(this.confirmed, this.generation));
          throw error;
        }
      }
      const entry: IntentUsage = { requestId: key, agentId,
        operation: context.source.type === 'operation' ? context.source.requestKind ?? 'operation' : 'turn',
        attempt: context.attempt, charged, estimated: true, activeMs: 0 };
      ledger.push(entry);
      await this.save(next);
      this.reservations.set(key, { generation: this.generation,
        runId: run?.status === 'ready' ? undefined : run?.id, started: Date.now() });
      this.startClock();
    });
  }

  private async settle(context: LoopRequestAttemptOutcomeContext, agentId: string): Promise<void> {
    const key = `${agentId}:${context.logicalRequestId}:${context.attempt}`;
    await this.serial(async () => {
      const reservation = this.reservations.get(key);
      if (reservation === undefined) return;
      this.reservations.delete(key);
      if (reservation.generation !== this.generation || this.failure !== undefined) return;
      const next = structuredClone(this.confirmed);
      const run = next.current?.analysis;
      const ledger = reservation.runId === undefined ? next.maintenanceLedger : run?.id === reservation.runId ? run.ledger : undefined;
      if (ledger === undefined) return;
      const index = ledger.findIndex((entry) => entry.requestId === key);
      if (index < 0) return;
      ledger[index] = settleIntentUsage(ledger[index]!, context.outcome.usage, Math.max(0, Date.now() - reservation.started));
      await this.save(next);
    });
  }

  async investigate(prompt: string, signal: AbortSignal): Promise<string> {
    if (!this.enabled()) throw new IntentError('disabled', 'Only the main agent may delegate Intent investigation.');
    await this.syncInputs();
    const task = this.confirmed.current;
    if (task === undefined) throw new IntentError('no_task', 'No current task.');
    if (task.analysis !== undefined && task.analysis.status !== 'analyzing') throw new IntentError('phase_denied', 'Analysis is not active.');
    const generation = this.generation;
    const revision = task.revision;
    const plan = await this.subagents.planSpawn({ callerAgentId: this.scope.agentId, profileName: 'explore' });
    const spawned = await this.subagents.spawn({ callerAgentId: this.scope.agentId, plan, prompt,
      labels: { intentId: task.intentId, analysisRunId: task.analysis?.id ?? 'default' } });
    const child = this.lifecycle.handleOf(spawned.agentId)!;
    child.accessor.get(IIntentService).bindInvestigation(this, intentProjection(this.confirmed, generation), generation, revision);
    const controller = new AbortController();
    this.children.set(spawned.agentId, controller);
    try {
      const run = await this.subagents.run(this.lifecycle.get(spawned.agentId)!, { kind: 'prompt', prompt: spawned.promptText },
        { signal: AbortSignal.any([signal, controller.signal]) });
      const result = await run.completion;
      if (generation !== this.generation || revision !== this.confirmed.current?.revision || controller.signal.aborted) {
        return `Stale investigation; review only, do not apply automatically:\n${result.summary}`;
      }
      this.pending.set(`subagent:${spawned.agentId}`, { id: `subagent:${spawned.agentId}`,
        kind: 'subagent_finding', text: result.summary.slice(0, 32000), generation,
        relatedRunId: task.analysis?.id });
      return result.summary;
    } finally {
      this.children.delete(spawned.agentId);
    }
  }
}
