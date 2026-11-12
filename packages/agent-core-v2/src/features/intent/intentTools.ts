import { z } from 'zod';
import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool, ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IIntentService } from './intentService';
import { IntentError, IntentUpdateSchema, type IntentSource } from './intentState';
import { intentProjection } from './intentPolicy';

const IntentInputSchema = z.object({
  update: IntentUpdateSchema.optional(),
  section: z.enum(['items', 'decisions', 'findings', 'sources']).optional(),
  sourceId: z.string().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});
type IntentInput = z.infer<typeof IntentInputSchema>;
export const IIntentTool = createDecorator<AgentTool<IntentInput>>('intentTool');

export class IntentTool implements AgentTool<IntentInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Intent';
  readonly description = 'Read the current task requirements, trusted source quotations, generation, revision, findings and analysis state. ' +
    'Omit update for a compact overview and the latest 20 source previews. Read section items, decisions, findings or sources with offset and limit (at most 20). ' +
    'Read one sourceId with offset to obtain up to 8000 characters of its exact original text; nextOffset is null when complete. ' +
    'Submit a sourced incremental update with a unique operationId and the current intentId, generation and expectedRevision. ' +
    'Every item and decision cites at least one source quotation; for assumptions and unknowns quote the user request or tool result they come from. ' +
    'Explicit requirements need a matching user quotation. Assumptions are not confirmations. Supersede changed explicit items instead of overwriting them. ' +
    'Acknowledge pending inputs with handledInputs and reviewReason. Complete deep with completeAnalysisRunId only after recording goal, acceptance, ' +
    'resolved blocking questions and next actions. Completion never grants permission to modify code for discussion-only requests. ' +
    'Only acceptance items may include verification or evidence. Verification passed/failed requires tool evidence; ' +
    'task completion does not imply acceptance. Use newTaskSourceId only for an explicit task switch.';
  readonly parameters = toInputJsonSchema(IntentInputSchema);
  constructor(@IIntentService private readonly intent: IIntentService) {}
  resolveExecution(input: IntentInput): ToolExecution {
    const args = IntentInputSchema.parse(input);
    return { description: args.update === undefined ? 'Reading task requirements' : 'Updating task requirements',
      approvalRule: this.name, accesses: [], execute: async () => {
        try {
          const result = args.update === undefined ? this.read(args) : await this.intent.update(args.update);
          return { output: JSON.stringify(result) };
        } catch (error) { return { isError: true, output: String(error) }; }
      } };
  }
  private read(input: IntentInput): unknown {
    const view = this.intent.read();
    const task = view.state.current;
    const metadata = {
      intentId: task?.intentId,
      generation: view.generation,
      revision: task?.revision,
      analysisRunId: task?.analysis?.id,
      error: view.error,
      totals: {
        items: task?.items.length ?? 0,
        decisions: task?.decisions.length ?? 0,
        findings: task?.findings.length ?? 0,
        sources: task?.sourceRefs.length ?? 0,
      },
    };
    const offset = input.offset ?? 0;
    if (input.sourceId !== undefined) {
      const source = task?.sourceRefs.find((entry) => entry.id === input.sourceId);
      if (source === undefined) throw new IntentError('invalid_source', 'The source does not belong to the current task.');
      const end = Math.min(offset + 8000, source.text.length);
      return { ...metadata, sourceId: source.id, kind: source.kind, text: source.text.slice(offset, end),
        textLength: source.text.length, files: source.files, offset, nextOffset: end < source.text.length ? end : null };
    }
    if (input.section !== undefined) {
      const limit = input.limit ?? 20;
      const records = input.section === 'sources'
        ? (task?.sourceRefs ?? []).map(sourceDirectoryEntry)
        : task?.[input.section] ?? [];
      const end = Math.min(offset + limit, records.length);
      return { ...metadata, section: input.section, entries: records.slice(offset, end),
        offset, nextOffset: end < records.length ? end : null };
    }
    return { ...metadata, summary: intentProjection(view.state, view.generation),
      sources: task?.sourceRefs.slice(-20).map(sourceDirectoryEntry) ?? [] };
  }
}

function sourceDirectoryEntry(source: IntentSource) {
  return { sourceId: source.id, kind: source.kind, preview: source.text.slice(0, 500), textLength: source.text.length };
}

const InvestigationSchema = z.object({ prompt: z.string().min(1).max(8000) });
type InvestigationInput = z.infer<typeof InvestigationSchema>;
export const IIntentInvestigateTool = createDecorator<AgentTool<InvestigationInput>>('intentInvestigateTool');
export class IntentInvestigateTool implements AgentTool<InvestigationInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'IntentInvestigate';
  readonly description = 'Delegate one bounded read-only investigation using the current requirement slice and deep budget. ' +
    'The result is evidence, never user confirmation. Reuse findings; do not delegate duplicate searches. Stale results require review.';
  readonly parameters = toInputJsonSchema(InvestigationSchema);
  constructor(@IIntentService private readonly intent: IIntentService) {}
  resolveExecution(input: InvestigationInput): ToolExecution {
    const args = InvestigationSchema.parse(input);
    return { description: 'Investigating task requirements', approvalRule: this.name, accesses: [],
      execute: async ({ signal }) => {
        try { return { output: await this.intent.investigate(args.prompt, signal) }; }
        catch (error) { return { isError: true, output: String(error) }; }
      } };
  }
}
