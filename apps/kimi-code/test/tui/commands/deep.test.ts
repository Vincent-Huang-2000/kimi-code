import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleDeepCommand } from '#/tui/commands/deep';

function makeHost() {
  const session = {
    listCommands: vi.fn(async () => [{ name: 'deep' }]),
    runCommand: vi.fn(async (_name: string, _args: string) => {}),
  };
  const host = {
    session,
    state: {
      appState: { model: 'test-model' },
      editor: { getText: vi.fn(() => '') },
      editorReplacementMounted: false,
    },
    showError: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
  };
  return { host, session, target: host as unknown as SlashCommandHost };
}

describe('handleDeepCommand', () => {
  it.each(['', 'Investigate checkout', '--status', '--cancel', '--continue'])(
    'dispatches %s through the contributed SDK command without a prompt fallback', async (args) => {
      const { host, session, target } = makeHost();
      await handleDeepCommand(target, args, '/deep ' + args);
      expect(session.listCommands).toHaveBeenCalledOnce();
      expect(session.runCommand).toHaveBeenCalledWith('deep', args);
      expect(host.sendNormalUserInput).not.toHaveBeenCalled();
      expect(host.restoreInputText).not.toHaveBeenCalled();
      expect(host.showError).not.toHaveBeenCalled();
    },
  );

  it('restores input when the current engine does not expose deep', async () => {
    const { host, session, target } = makeHost();
    session.listCommands.mockResolvedValueOnce([]);
    await handleDeepCommand(target, 'Investigate checkout', '/deep Investigate checkout');
    expect(session.runCommand).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    expect(host.restoreInputText).toHaveBeenCalledWith('/deep Investigate checkout');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it.each(['busy', 'storage failed', 'no current task'])('preserves rejected input on %s', async (message) => {
    const { host, session, target } = makeHost();
    session.runCommand.mockRejectedValueOnce(new Error(message));
    await handleDeepCommand(target, '', '/deep');
    expect(host.showError).toHaveBeenCalledWith(message);
    expect(host.restoreInputText).toHaveBeenCalledWith('/deep');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('preserves a newer draft when an asynchronous command fails', async () => {
    const { host, session, target } = makeHost();
    session.runCommand.mockImplementationOnce(async () => {
      host.state.editor.getText.mockReturnValue('newer draft');
      throw new Error('busy');
    });
    await handleDeepCommand(target, '', '/deep');
    expect(host.restoreInputText).not.toHaveBeenCalled();
  });

  it('does not replace an opened dialog on failure', async () => {
    const { host, session, target } = makeHost();
    session.runCommand.mockImplementationOnce(async () => {
      host.state.editorReplacementMounted = true;
      throw new Error('busy');
    });
    await handleDeepCommand(target, '', '/deep');
    expect(host.restoreInputText).not.toHaveBeenCalled();
  });

  it('requires a model for analysis but not status or cancellation', async () => {
    const { host, session, target } = makeHost();
    host.state.appState.model = '';
    await handleDeepCommand(target, 'Investigate checkout', '/deep Investigate checkout');
    expect(session.runCommand).not.toHaveBeenCalled();
    expect(host.restoreInputText).toHaveBeenCalledWith('/deep Investigate checkout');
    for (const args of ['--status', '--cancel']) await handleDeepCommand(target, args, '/deep ' + args);
    expect(session.runCommand).toHaveBeenCalledTimes(2);
  });
});
