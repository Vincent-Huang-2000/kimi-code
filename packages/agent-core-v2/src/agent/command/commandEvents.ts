import { z } from 'zod';
import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';

const commandOutputSchema = z.object({
  agentId: z.string(),
  command: z.string(),
  text: z.string(),
});

export type CommandOutputPayload = z.infer<typeof commandOutputSchema>;

export class CommandOutput extends AgentEvent2<CommandOutputPayload> {
  static override readonly type = 'command.output';
  static override readonly observable = true;
  static override readonly schema = commandOutputSchema;
  declare readonly command: string;
  declare readonly text: string;
}

export interface CommandOutputEvent extends Omit<CommandOutputPayload, 'agentId'> {
  readonly type: 'command.output';
}

registerEvent2Class(CommandOutput);
