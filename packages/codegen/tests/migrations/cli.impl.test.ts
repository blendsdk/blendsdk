import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { main, type MigrationCliIo } from '../../src/migration/cli.js';

const playgroundConfig = resolve(
  import.meta.dirname,
  '../../../playground/database-migrations/blendsdk.migrations.ts'
);

/** Captured result from one reusable CLI invocation. */
interface InvocationResult {
  /** Returned process exit class. */
  readonly exitCode: number;
  /** Ordinary output lines. */
  readonly stdout: readonly string[];
  /** Sanitized diagnostic lines. */
  readonly stderr: readonly string[];
}

/** Runs the reusable entry point without changing process-global output or exit state. */
async function invoke(argv: readonly string[]): Promise<InvocationResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: MigrationCliIo = {
    stdout: message => stdout.push(message),
    stderr: message => stderr.push(message),
  };
  const exitCode = await main(argv, io);
  return { exitCode, stdout, stderr };
}

/** Captures the two process listener counts owned temporarily by migration execution. */
function signalListenerCounts(): readonly [number, number] {
  return [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
}

describe('migration CLI implementation', () => {
  test.each([
    ['generate', true],
    ['create', true],
    ['up', false],
    ['down', false],
    ['status', false],
    ['validate', false],
    ['baseline', true],
    ['adopt-baseline', false],
  ] as const)('should route %s help without running a migration', async (command, needsName) => {
    const argv = ['migrate', command, ...(needsName ? ['example'] : []), '--help'];
    const result = await invoke(argv);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.join('\n')).toContain(command);
    expect(result.stderr).toEqual([]);
  });

  test.each([
    { argv: [] },
    { argv: ['migrate'] },
    { argv: ['migrate', 'unknown'] },
    { argv: ['migrate', 'generate'] },
    { argv: ['migrate', 'status', 'unexpected-name'] },
  ])('should return usage exit code for invalid argv $argv', async ({ argv }) => {
    const result = await invoke(argv);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toEqual([
      'USAGE: Run `blendsdk migrate --help` for the supported commands.',
    ]);
  });

  test('should return usage exit code when down confirmation is absent', async () => {
    const result = await invoke(['migrate', 'down']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toEqual(['USAGE: Invalid migration command arguments.']);
  });

  test('should preserve exit state and remove signal listeners after successful execution', async () => {
    const listenersBefore = signalListenerCounts();
    const exitCodeBefore = process.exitCode;
    const result = await invoke(['migrate', 'validate', '--offline', '--config', playgroundConfig]);

    expect(result).toMatchObject({ exitCode: 0, stdout: ['UP_TO_DATE'], stderr: [] });
    expect(process.exitCode).toBe(exitCodeBefore);
    expect(signalListenerCounts()).toEqual(listenersBefore);
  });

  test('should not intercept termination signals for commands without cancellation support', async () => {
    const once = vi.spyOn(process, 'once');

    await invoke(['migrate', 'validate', '--offline', '--config', playgroundConfig]);

    expect(once).not.toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(once).not.toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    once.mockRestore();
  });

  test('should remove signal listeners after a configuration failure', async () => {
    const listenersBefore = signalListenerCounts();
    const result = await invoke([
      'migrate',
      'validate',
      '--offline',
      '--config',
      resolve(import.meta.dirname, 'missing-config.ts'),
    ]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toHaveLength(1);
    expect(result.stderr[0]).toMatch(/^CONFIGURATION:/u);
    expect(signalListenerCounts()).toEqual(listenersBefore);
  });
});
