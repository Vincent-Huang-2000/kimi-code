import { createHash } from 'node:crypto';
import {
  createIntentTask, IntentError, IntentUpdateSchema,
  type IntentItem, type IntentState, type IntentTask, type IntentUpdate, type SourceRef,
} from './intentState';
import { intentBudgetLevel } from './intentBudget';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, stable(v)]));
  }
  return value;
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value)) ?? 'undefined').digest('hex');
}

function requirementFingerprint(item: IntentItem | undefined): string {
  return fingerprint(item === undefined ? undefined : { ...item, verification: undefined, evidence: undefined });
}

export function validateSources(task: IntentTask, refs: readonly SourceRef[], explicit = false): void {
  if (refs.length === 0) throw new IntentError('invalid_source', 'Provide at least one source reference.');
  for (const ref of refs) {
    const source = task.sourceRefs.find((entry) => entry.id === ref.sourceId);
    if (source === undefined || ref.quote.trim().length === 0 || !source.text.includes(ref.quote)) {
      throw new IntentError('invalid_source', `Source or quotation does not match: ${ref.sourceId}`);
    }
    if (explicit && source.kind !== 'user_input' && source.kind !== 'user_answer') {
      throw new IntentError('invalid_source', 'Only a user input or matched answer can support an explicit requirement.');
    }
  }
}

function upsert<T extends { id: string }>(previous: T[], updates: T[] | undefined): T[] {
  const result = [...previous];
  const seen = new Set<string>();
  for (const update of updates ?? []) {
    if (seen.has(update.id)) throw new IntentError('invalid_transition', `Duplicate item: ${update.id}`);
    seen.add(update.id);
    const index = result.findIndex((item) => item.id === update.id);
    if (index === -1) result.push(update);
    else result[index] = update;
  }
  return result;
}

export function applyIntentUpdate(state: IntentState, input: IntentUpdate, generation: string,
  newIntentId: string): { state: IntentState; result: IntentState['operations'][number] } {
  const update = IntentUpdateSchema.parse(input);
  const current = state.current;
  if (current === undefined) throw new IntentError('no_task', 'Submit a task first.');
  if (current.intentId !== update.intentId || generation !== update.generation) {
    throw new IntentError('stale_version', 'Task view expired. Read Intent again before proposing an update.');
  }
  const hash = fingerprint(update);
  const previous = state.operations.find((operation) => operation.operationId === update.operationId &&
    operation.intentId === current.intentId && operation.generation === generation);
  if (previous !== undefined) {
    if (previous.fingerprint !== hash) throw new IntentError('operation_conflict', 'Operation ID was already used with different content.');
    return { state, result: previous };
  }
  if (current.revision !== update.expectedRevision) {
    throw new IntentError('stale_version', `Expected revision ${current.revision}; read Intent and rebase the proposal.`);
  }
  if (update.newTaskSourceId !== undefined) {
    const source = current.sourceRefs.find((entry) => entry.id === update.newTaskSourceId && entry.kind === 'user_input');
    if (source === undefined) throw new IntentError('invalid_source', 'A new task requires a real user input.');
    if (update.items !== undefined || update.decisions !== undefined || update.findings !== undefined ||
      update.executionPreparation !== undefined || update.handledInputs !== undefined ||
      update.reviewReason !== undefined || update.lifecycle !== undefined || update.completeAnalysisRunId !== undefined) {
      throw new IntentError('invalid_transition', 'Switch tasks in a separate operation before updating the new task.');
    }
    if (!current.observedInputs.includes(source.id)) {
      throw new IntentError('invalid_source', 'A new task requires an observed user input.');
    }
    const task = createIntentTask(newIntentId, source);
    const result = { operationId: update.operationId, intentId: current.intentId,
      generation, fingerprint: hash, revision: task.revision };
    return { state: { ...state, current: task,
      archives: [...state.archives, { ...current, lifecycle: 'archived' }],
      operations: [...state.operations, result] }, result };
  }
  let task = structuredClone(current);
  const replacementTargets = new Set<string>();
  for (const item of update.items ?? []) {
    validateSources(task, item.sources, item.certainty === 'explicit');
    if (item.kind === 'unknown' && item.certainty !== 'unknown') {
      throw new IntentError('invalid_transition', 'Resolve or supersede an unknown explicitly.');
    }
    if (item.certainty === 'fact' && item.sources.some((ref) =>
      task.sourceRefs.find((source) => source.id === ref.sourceId)?.kind === 'model_inference')) {
      throw new IntentError('invalid_source', 'Inference is not a code fact.');
    }
    if (item.kind !== 'acceptance' && (item.verification !== undefined || item.evidence !== undefined)) {
      throw new IntentError('invalid_transition', 'Only acceptance criteria may carry verification results.');
    }
    if (item.evidence !== undefined && item.evidence.length > 0) validateSources(task, item.evidence);
    if (item.verification === 'passed' || item.verification === 'failed') {
      validateSources(task, item.evidence ?? []);
      if (item.evidence?.some((ref) => !['tool_result', 'subagent_finding'].includes(
        task.sourceRefs.find((source) => source.id === ref.sourceId)!.kind))) {
        throw new IntentError('invalid_source', 'Verification requires execution evidence.');
      }
    }
    const old = task.items.find((entry) => entry.id === item.id);
    if (old?.status === 'superseded' && item.status === 'active') {
      throw new IntentError('invalid_transition', 'Superseded requirements must not be reactivated in place.');
    }
    if (old?.certainty === 'explicit' && requirementFingerprint(old) !== requirementFingerprint(item)) {
      throw new IntentError('invalid_transition', 'Preserve explicit requirements; supersede them with a new sourced item.');
    }
    if (item.supersedes !== undefined) {
      if (item.status !== 'active') throw new IntentError('invalid_transition', 'A replacement requirement must be active.');
      const replaced = task.items.find((entry) => entry.id === item.supersedes);
      if (replaced === undefined || replaced.id === item.id) throw new IntentError('invalid_transition', 'Unknown replacement target.');
      if (replacementTargets.has(replaced.id)) throw new IntentError('invalid_transition', 'A requirement cannot have two replacements in one operation.');
      if (replaced.certainty === 'explicit') {
        if (item.certainty !== 'explicit') throw new IntentError('invalid_source', 'An assumption cannot replace an explicit requirement.');
        validateSources(task, item.sources, true);
      }
      replacementTargets.add(replaced.id);
    }
  }
  const changedIds = new Set((update.items ?? []).filter((item) =>
    requirementFingerprint(task.items.find((old) => old.id === item.id)) !== requirementFingerprint(item)).flatMap((item) =>
    item.supersedes === undefined ? [item.id] : [item.id, item.supersedes]));
  task.items = upsert(task.items, update.items).map((item) =>
    replacementTargets.has(item.id) ? { ...item, status: 'superseded' } : item);
  task.decisions = task.decisions.map((decision) => decision.requirementIds.some((id) => changedIds.has(id))
    ? { ...decision, status: 'review' } : decision);
  const invalidEvidence = new Set(task.findings.filter((finding) =>
    finding.requirementIds.some((id) => changedIds.has(id))).flatMap((finding) =>
    finding.sources.map((source) => source.sourceId)));
  task.findings = task.findings.map((finding) => finding.requirementIds.some((id) => changedIds.has(id))
    ? { ...finding, status: 'review' } : finding);
  task.items = task.items.map((item) => item.kind === 'acceptance' &&
    item.evidence?.some((source) => invalidEvidence.has(source.sourceId))
    ? { ...item, verification: 'unverified' } : item);
  for (const record of [...(update.decisions ?? []), ...(update.findings ?? [])]) {
    validateSources(task, record.sources);
    if (record.requirementIds.some((id) => !task.items.some((item) => item.id === id))) {
      throw new IntentError('invalid_source', 'A decision or finding references an unknown requirement.');
    }
  }
  for (const finding of update.findings ?? []) {
    const trustedFiles = finding.sources.flatMap((ref) =>
      task.sourceRefs.find((source) => source.id === ref.sourceId)?.files ?? []);
    if (finding.files.some((file) => !trustedFiles.some((trusted) => fingerprint(trusted) === fingerprint(file)))) {
      throw new IntentError('invalid_source', 'File evidence must match a recorded authorized read.');
    }
  }
  task.decisions = upsert(task.decisions, update.decisions);
  task.findings = upsert(task.findings, update.findings);
  if (update.executionPreparation !== undefined) task.executionPreparation = update.executionPreparation;
  if (update.lifecycle !== undefined) task.lifecycle = update.lifecycle;
  const handled = update.handledInputs ?? [];
  if (handled.some((id) => !task.observedInputs.includes(id))) {
    throw new IntentError('invalid_source', 'Cannot acknowledge an unobserved input.');
  }
  const newlyHandled = [...new Set(handled)].filter((id) => !task.handledInputs.includes(id));
  if (newlyHandled.length > 0) {
    if (update.reviewReason === undefined) throw new IntentError('invalid_transition', 'Explain the requirement change or why no change is needed.');
    task.handledInputs.push(...newlyHandled);
    task.reviews.push({ inputIds: newlyHandled, reason: update.reviewReason });
  }
  if (update.completeAnalysisRunId !== undefined) {
    const analysis = task.analysis;
    if (analysis?.id !== update.completeAnalysisRunId || analysis.status !== 'analyzing') {
      throw new IntentError('invalid_transition', 'Only the current analyzing run may finish.');
    }
    const active = task.items.filter((item) => item.status === 'active');
    if (!active.some((item) => item.kind === 'goal') || !active.some((item) => item.kind === 'acceptance') ||
      active.some((item) => item.blocking === true && item.resolution === undefined) ||
      task.observedInputs.some((id) => !task.handledInputs.includes(id)) || analysis.pendingQuestions.length > 0 ||
      task.executionPreparation === undefined || task.executionPreparation.nextActions.length === 0) {
      throw new IntentError('invalid_transition', 'Resolve blocking unknowns, review inputs, and record a goal, acceptance criteria and next action.');
    }
    analysis.status = 'ready';
    analysis.reason = undefined;
  }
  const changed = fingerprint({ ...task, reviews: [], handledInputs: [] }) !==
    fingerprint({ ...current, reviews: [], handledInputs: [] });
  task.revision = current.revision + (changed ? 1 : 0);
  if (task.analysis !== undefined) task.analysis.boundRevision = task.revision;
  const result = { operationId: update.operationId, intentId: current.intentId, generation,
    fingerprint: hash, revision: task.revision, analysisStatus: task.analysis?.status };
  return { state: { ...state, current: task, operations: [...state.operations, result] }, result };
}

export const INTENT_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch',
  'Intent', 'AskUserQuestion', 'TodoList', 'TaskList', 'TaskOutput', 'FetchURL', 'ReadMediaFile', 'NotifyUser', 'SelectTools']);

export function intentNeedsReview(task: IntentTask | undefined): boolean {
  return task !== undefined && task.observedInputs.some((id) => !task.handledInputs.includes(id));
}

export function intentAllowsEffects(task: IntentTask | undefined): boolean {
  return !intentNeedsReview(task) && !task?.items.some((item) => item.status === 'active' && item.blocking === true && item.resolution === undefined) && (task?.analysis === undefined || task.analysis.status === 'ready');
}

export function intentProjection(state: IntentState, generation: string): string {
  const task = state.current;
  if (task === undefined) return 'No current task.';
  const lines = [`Intent ${task.intentId}; revision ${task.revision}; generation ${generation}.`,
    `Analysis: ${task.analysis?.status ?? 'default tracking'}${task.analysis?.reason === undefined ? '' : ` (${task.analysis.reason})`}.`,
    `Pending user inputs: ${task.observedInputs.filter((id) => !task.handledInputs.includes(id)).join(', ') || 'none'}.`];
  const run = task.analysis;
  if (run !== undefined) {
    const tokens = run.ledger.reduce((sum, entry) => sum + entry.charged, 0);
    const estimated = run.ledger.some((entry) => entry.estimated) ? ' (includes estimates)' : '';
    lines.push(`Analysis budget: requests ${run.ledger.length}/${run.budget.maxRequests}; active seconds ` +
      `${Math.ceil(run.activeMs / 1000)}/${Math.ceil(run.budget.maxActiveMs / 1000)}.`);
    lines.push(`Token usage: ${tokens} (tracking only)${estimated}.`);
    if (run.status === 'analyzing' || run.status === 'waiting_for_answer') {
      const level = intentBudgetLevel(run);
      if (level === 'converge') lines.push('Analysis budget is at least 80% used. Converge on the key unknowns; save findings and the next action.');
      if (level === 'exhausted') lines.push('Analysis budget is exhausted. Save available findings and report unfinished analysis; do not start more requests.');
    }
  }
  for (const item of task.items.filter((entry) => entry.status === 'active').slice(0, 20)) {
    lines.push(`${item.kind} [${item.id}, ${item.certainty}]: ${item.text.slice(0, 240)}`);
  }
  for (const finding of task.findings.slice(-5)) lines.push(`Finding [${finding.id}, ${finding.status}]: ${finding.text.slice(0, 240)}`);
  if (task.executionPreparation !== undefined) lines.push(`Next: ${task.executionPreparation.nextActions.join('; ').slice(0, 500)}`);
  return lines.join('\n');
}
