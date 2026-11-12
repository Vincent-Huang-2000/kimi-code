import type { LoopRequestAttemptContext } from '#/agent/loop/requesterContract';
import { estimateTokens, estimateTokensForMessage, estimateTokensForTools } from '#/llm-adapter/contract/tokens';
import type { TokenUsage } from '#human/llm-requester/usage';
import { IntentError, type AnalysisRun, type IntentUsage } from './intentState';

type IntentRequest = Pick<LoopRequestAttemptContext['request'], 'content' | 'model' | 'profile'>;

export function estimateIntentRequestTokens(request: IntentRequest, outputReserve = 8192): number {
  let inputEstimate = tokenCount(request.content.usedTokens);
  if (inputEstimate === undefined) {
    inputEstimate = estimateTokens(request.profile?.systemPrompt ?? '');
    if (request.profile?.tools !== undefined) inputEstimate += estimateTokensForTools(request.profile.tools);
    for (const message of request.content.messages) {
      inputEstimate += estimateTokensForMessage(message);
      if (message.role === 'system' && message.tools !== undefined) {
        inputEstimate += estimateTokensForTools(message.tools);
      }
    }
  }
  const output = typeof request.model.maxOutputTokens === 'number'
    ? request.model.maxOutputTokens : outputReserve;
  return inputEstimate + output;
}

export function reserveIntentRequest(run: AnalysisRun, request: IntentRequest): number {
  const reservation = estimateIntentRequestTokens(request, run.budget.outputReserve);
  if (run.ledger.length >= run.budget.maxRequests ||
    run.activeMs >= run.budget.maxActiveMs) {
    throw new IntentError('budget_exhausted', 'Deep budget reached; no further analysis requests are admitted.');
  }
  return reservation;
}

export function intentBudgetLevel(run: AnalysisRun | undefined): 'normal' | 'converge' | 'exhausted' {
  if (run === undefined) return 'normal';
  const fraction = Math.max(
    run.ledger.length / run.budget.maxRequests,
    run.activeMs / run.budget.maxActiveMs,
  );
  return fraction >= 1 ? 'exhausted' : fraction >= 0.8 ? 'converge' : 'normal';
}

function tokenCount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function settleIntentUsage(reserved: IntentUsage, usage: TokenUsage | undefined, activeMs: number): IntentUsage {
  const input = tokenCount(usage?.inputOther);
  const output = tokenCount(usage?.output);
  const cacheRead = tokenCount(usage?.inputCacheRead);
  const cacheWrite = tokenCount(usage?.inputCacheCreation);
  const known = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const complete = input !== undefined && output !== undefined && cacheRead !== undefined && cacheWrite !== undefined;
  return { ...reserved, input, output, cacheRead, cacheWrite,
    charged: complete ? known : Math.max(reserved.charged, known),
    estimated: !complete, activeMs };
}
