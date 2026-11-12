import { z } from 'zod';
import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';

export class IntentCommitted extends AgentEvent2<{ agentId: string; state: unknown }> {
  static override readonly type = 'intent.committed';
  static override readonly durable = true;
  static override readonly schema = z.object({ agentId: z.string(), state: z.unknown() });
  declare readonly state: unknown;
}

registerEvent2Class(IntentCommitted);
