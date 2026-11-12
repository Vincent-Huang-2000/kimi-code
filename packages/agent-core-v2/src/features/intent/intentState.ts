import { z } from 'zod';

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(4000);
export const SourceRefSchema = z.object({ sourceId: id, quote: text });
export const IntentFileEvidenceSchema = z.object({
  path: text, environmentId: id, cwd: text, fingerprint: text, environmentGeneration: id.optional(),
});
export const IntentSourceSchema = z.object({
  id,
  kind: z.enum(['user_input', 'user_answer', 'tool_result', 'subagent_finding', 'model_inference']),
  text: z.string().max(32000),
  files: z.array(IntentFileEvidenceSchema).max(30).optional(),
  relatedRunId: id.optional(),
  generation: id.optional(),
});
export const IntentItemSchema = z.object({
  id,
  kind: z.enum(['goal', 'constraint', 'assumption', 'unknown', 'acceptance']),
  text,
  certainty: z.enum(['explicit', 'assumption', 'unknown', 'fact']),
  scope: text,
  sources: z.array(SourceRefSchema).max(20),
  status: z.enum(['active', 'superseded']),
  supersedes: id.optional(),
  blocking: z.boolean().optional(),
  resolution: text.optional(),
  verification: z.enum(['unverified', 'passed', 'failed', 'unavailable']).optional(),
  evidence: z.array(SourceRefSchema).max(20).optional(),
});
const IntentItemUpdateSchema: z.ZodType<IntentItem> = z.discriminatedUnion('kind', [
  IntentItemSchema.omit({ verification: true, evidence: true }).extend({
    kind: z.enum(['goal', 'constraint', 'assumption', 'unknown']),
  }).strict(),
  IntentItemSchema.extend({ kind: z.literal('acceptance') }).strict(),
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
  items: z.array(IntentItemUpdateSchema).max(50).optional(),
  decisions: z.array(IntentDecisionSchema).max(30).optional(),
  findings: z.array(IntentFindingSchema).max(30).optional(),
  executionPreparation: PreparationSchema.optional(),
  handledInputs: z.array(id).max(100).optional(),
  reviewReason: text.optional(),
  completeAnalysisRunId: id.optional(),
  lifecycle: z.enum(['active', 'ended']).optional(),
  newTaskSourceId: id.optional(),
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
