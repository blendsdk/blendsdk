import { CommandLineParser, CommandLineValidationError } from '@blendsdk/cmdline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('strict parsing through the public package API', () => {
  let originalArgv: string[];
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('The command-line library must not terminate the consuming process');
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it('lets the consumer catch strict rejection and own the process exit policy', async () => {
    // Invalid input must stop the command before application work can begin.
    const handler = vi.fn();
    const parser = new CommandLineParser({
      name: 'consumer-cli',
      version: '1.0.0',
      strict: true,
    }).addCommand({ name: 'deploy', handler });
    process.argv = ['node', 'consumer-cli.js', 'deploy', '--unknown'];

    let caughtError: CommandLineValidationError | undefined;
    try {
      await parser.execute();
    } catch (error) {
      if (!(error instanceof CommandLineValidationError)) {
        throw error;
      }

      caughtError = error;
      // The application translates typed rejection into an exit code without terminating itself.
      process.exitCode = 1;
    }

    expect(caughtError).toBeInstanceOf(CommandLineValidationError);
    expect(caughtError?.issues.length).toBeGreaterThan(0);
    expect(handler).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
