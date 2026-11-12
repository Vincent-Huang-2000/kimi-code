import { LLM_NOT_SET_MESSAGE, NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { canRestoreSubmittedInput } from './resolve';

export async function handleDeepCommand(
  host: SlashCommandHost,
  args: string,
  input: string,
): Promise<void> {
  try {
    const session = host.session;
    if (session === undefined) throw new Error(NO_ACTIVE_SESSION_MESSAGE);
    const commands = await session.listCommands();
    if (!commands.some((command) => command.name === 'deep')) {
      throw new Error('Deep analysis is unavailable in this session. Enable intent_engine and use a supported engine.');
    }
    if (!['--status', '--cancel'].includes(args.trim()) && host.state.appState.model.trim().length === 0) {
      throw new Error(LLM_NOT_SET_MESSAGE);
    }
    await session.runCommand('deep', args);
  } catch (error) {
    host.showError(formatErrorMessage(error));
    if (canRestoreSubmittedInput(host)) host.restoreInputText(input);
  }
}
