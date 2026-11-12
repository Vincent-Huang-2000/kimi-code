import { z } from 'zod';

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(4000);
export const SourceRefSchema = z.object({ sourceId: id, quote: text });
export const IntentFileEvidenceSchema = z.object({
  path: text, environmentId: id, cwd: text, fingerprint: text, environmentGeneration: id.optional(),
});
export const IntentSourceSchema = z.object({
  id,
  kind: z.enum(['user_input', 'user_answer', 'tool_result', 'subagent_finding']),
  text: z.string().max(32000),
  files: z.array(IntentFileEvidenceSchema).max(30).optional(),
  relatedRunId: id.optional(),
  generation: id.optional(),
});
export const IntentItemSchema = z.object({
  id,
  kind: z.enum(['goal', 'constraint', 'assumption', 'unknown', 'acceptance']),
  text,
  certainty: z.enum(['explicit', 'assumption', 'unknown', 'fact']).describe('explicit: stated by the user (quote a user input or answer); ' +
    'fact: established by a tool result or finding; assumption: inferred without confirmation; unknown: not yet known (required for kind unknown).'),
  scope: text.describe('Where the item applies, such as the task or a module name.'),
  sources: z.array(SourceRefSchema).max(20),
  status: z.enum(['active', 'superseded']).describe('active for current items; superseded retires one. Replace explicit items through supersedes instead.'),
  supersedes: id.describe('ID of the item this one replaces; the replaced item becomes superseded.').optional(),
  blocking: z.boolean().describe('True when analysis and project changes must wait until resolution is set.').optional(),
  resolution: text.describe('How a blocking item was settled.').optional(),
  verification: z.enum(['unverified', 'passed', 'failed', 'unavailable'])
    .describe('Acceptance result; passed or failed requires evidence quoting a tool result or subagent finding.').optional(),
  evidence: z.array(SourceRefSchema).max(20).optional(),
});
// Updates must cite at least one source; the runtime rejects empty lists, so the tool schema says so up front.
const RequiredSourcesSchema = z.array(SourceRefSchema).min(1).max(20)
  .describe('Quotations supporting this record: a sourceId from Intent sources and an exact substring of that source text.');
const IntentItemUpdateSchema: z.ZodType<IntentItem> = z.discriminatedUnion('kind', [
  IntentItemSchema.omit({ verification: true, evidence: true }).extend({
    kind: z.enum(['goal', 'constraint', 'assumption', 'unknown']).describe('goal: the outcome to achieve; constraint: a limit to respect; ' +
      'assumption: an unconfirmed premise; unknown: an open question. Use acceptance for completion checks; ' +
      'next actions belong in executionPreparation.nextActions and choices in decisions, not in items.'),
    sources: RequiredSourcesSchema,
  }).strict(),
  IntentItemSchema.extend({
    kind: z.literal('acceptance').describe('A check showing the task is done; only acceptance items may carry verification and evidence.'),
    sources: RequiredSourcesSchema,
  }).strict(),
]);
export const IntentDecisionSchema = z.object({
  id, text, reason: text, scope: text,
  sources: z.array(SourceRefSchema).max(20),
  requirementIds: z.array(id).max(50),
  status: z.enum(['active', 'review', 'superseded']),
  supersedes: id.optional(),
});
export const IntentFindingSchema = z.object({
  id, text,
  requirementIds: z.array(id).max(50),
  sources: z.array(SourceRefSchema).min(1).max(20),
  files: z.array(IntentFileEvidenceSchema).max(30),
  status: z.enum(['valid', 'review']),
});
export const PreparationSchema = z.object({
  modules: z.array(text).max(30),
  nextActions: z.array(text).max(20),
  validation: z.array(text).max(20),
  planId: id.optional(),
  todoIds: z.array(id).max(30).optional(),
  goalId: id.optional(),
});
export const IntentBudgetSchema = z.object({
  maxRequests: z.number().int().positive().default(30),
  maxActiveMs: z.number().int().positive().default(600000),
  outputReserve: z.number().int().positive().default(8192),
});
export const IntentUsageSchema = z.object({
  requestId: id,
  agentId: id,
  operation: id,
  attempt: z.number().int().positive(),
  input: z.number().nonnegative().optional(),
  output: z.number().nonnegative().optional(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
  charged: z.number().nonnegative(),
  estimated: z.boolean(),
  activeMs: z.number().nonnegative(),
});
export const AnalysisRunSchema = z.object({
  id,
  requestId: id,
  status: z.enum(['analyzing', 'waiting_for_answer', 'ready', 'interrupted', 'failed']),
  boundRevision: z.number().int().nonnegative(),
  reason: text.optional(),
  budget: IntentBudgetSchema,
  activeMs: z.number().nonnegative().default(0),
  ledger: z.array(IntentUsageSchema),
  pendingQuestions: z.array(id),
});
export const IntentTaskSchema = z.object({
  intentId: id,
  revision: z.number().int().nonnegative(),
  lifecycle: z.enum(['active', 'ended', 'archived']),
  items: z.array(IntentItemSchema).max(200),
  decisions: z.array(IntentDecisionSchema).max(100),
  findings: z.array(IntentFindingSchema).max(100),
  executionPreparation: PreparationSchema.optional(),
  sourceRefs: z.array(IntentSourceSchema),
  observedInputs: z.array(id),
  handledInputs: z.array(id),
  reviews: z.array(z.object({ inputIds: z.array(id), reason: text })),
  analysis: AnalysisRunSchema.optional(),
});
export const IntentStateSchema = z.object({
  schemaVersion: z.literal(1),
  current: IntentTaskSchema.optional(),
  archives: z.array(IntentTaskSchema),
  operations: z.array(z.object({
    operationId: id, intentId: id, generation: id, fingerprint: text,
    revision: z.number().int().nonnegative(),
    analysisStatus: AnalysisRunSchema.shape.status.optional(),
  })),
  maintenanceLedger: z.array(IntentUsageSchema),
});
export const IntentUpdateSchema = z.object({
  operationId: id,
  intentId: id,
  generation: id,
  expectedRevision: z.number().int().nonnegative(),
  items: z.array(IntentItemUpdateSchema).max(50)
    .describe('Each entry replaces the stored item with the same id, so send every required field even when changing one.').optional(),
  decisions: z.array(IntentDecisionSchema.extend({ sources: RequiredSourcesSchema })).max(30).optional(),
  findings: z.array(IntentFindingSchema).max(30).optional(),
  executionPreparation: PreparationSchema
    .describe('Required before finishing analysis: affected modules, at least one next action and validation steps.').optional(),
  handledInputs: z.array(id).max(100).describe('Pending user input IDs this update reviews; requires reviewReason.').optional(),
  reviewReason: text.describe('How the reviewed inputs change the requirements, or why no change is needed.').optional(),
  completeAnalysisRunId: id.describe('The analysisRunId to mark ready. Requires an active goal and acceptance item, resolved blocking items, ' +
    'all user inputs handled, no pending questions and executionPreparation.nextActions. Project changes may start only in a later tool batch.').optional(),
  lifecycle: z.enum(['active', 'ended']).optional(),
  newTaskSourceId: id.describe('A user input ID that explicitly starts a different task; send it without other changes.').optional(),
});

export type IntentSource = z.infer<typeof IntentSourceSchema>;
export type IntentItem = z.infer<typeof IntentItemSchema>;
export type IntentTask = z.infer<typeof IntentTaskSchema>;
export type IntentState = z.infer<typeof IntentStateSchema>;
export type IntentUpdate = z.infer<typeof IntentUpdateSchema>;
export type IntentBudget = z.infer<typeof IntentBudgetSchema>;
export type IntentUsage = z.infer<typeof IntentUsageSchema>;
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;
export type SourceRef = z.infer<typeof SourceRefSchema>;

export function emptyIntentState(): IntentState {
  return { schemaVersion: 1, archives: [], operations: [], maintenanceLedger: [] };
}

export function createIntentTask(intentId: string, source: IntentSource): IntentTask {
  return {
    intentId, revision: 0, lifecycle: 'active', items: [], decisions: [], findings: [],
    sourceRefs: [source], observedInputs: [source.id], handledInputs: [], reviews: [],
  };
}

export class IntentError extends Error {
  constructor(readonly code: 'stale_version' | 'invalid_source' | 'invalid_transition' |
    'phase_denied' | 'no_task' | 'busy' | 'budget_exhausted' | 'persistence_failed' |
    'operation_conflict' | 'disabled', message: string) {
    super(`${code}: ${message}`);
    this.name = 'IntentError';
  }
}
