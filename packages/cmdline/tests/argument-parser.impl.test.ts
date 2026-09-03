import { describe, expect, it, vi } from 'vitest';

import { createArgumentRegistry, parseArguments } from '../src/argument-parser.js';
import type { ICommand, ICommandOption } from '../src/types.js';

/** Creates a real command definition while keeping individual tests focused on token behavior. */
function command(
  options: readonly ICommandOption[] = [],
  overrides: Partial<ICommand> = {}
): ICommand {
  return {
    name: 'deploy',
    options: [...options],
    handler: vi.fn(),
    ...overrides,
  };
}

describe('argument parser token consumption', () => {
  it('retains source indexes for globals before a command and command options after it', () => {
    // Option occurrence indexes must continue referring to the caller's original argument list.
    const deploy = command([{ name: 'output', short: 'o', type: 'string' }]);
    const registry = createArgumentRegistry({
      parserName: 'test-cli',
      commands: [deploy],
      globalOptions: [{ name: 'verbose', short: 'v', type: 'boolean' }],
    });

    const result = parseArguments(
      ['--verbose', 'deploy', '--output', 'release'],
      registry,
      'strict'
    );

    expect(result.command).toBe(deploy);
    expect(result.commandIndex).toBe(1);
    expect(result.options).toEqual({ verbose: true, output: 'release' });
    expect(result.occurrences.map(occurrence => occurrence.index)).toEqual([0, 2]);
    expect(result.issues).toEqual([]);
  });

  it('consumes a negative decimal only for a registered numeric option', () => {
    // A leading dash on a numeric value must not turn it into an unrelated option token.
    const deploy = command([{ name: 'offset', short: 'o', type: 'number' }]);
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(['deploy', '--offset', '-2.5'], registry, 'strict');

    expect(result.options).toEqual({ offset: -2.5 });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]).toMatchObject({ index: 1, value: -2.5 });
    expect(result.issues).toEqual([]);
  });

  it('keeps every token visible after an unknown option', () => {
    // Unknown options consume nothing, preserving later plain tokens as separate ordered issues.
    const deploy = command([{ name: 'known', type: 'string' }]);
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(
      ['deploy', '--unknown', 'plain', '--known=value', 'extra'],
      registry,
      'strict'
    );

    expect(result.options).toEqual({ known: 'value' });
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'unknown-option', argument: '--unknown', index: 1 }),
      expect.objectContaining({ kind: 'unexpected-argument', argument: 'plain', index: 2 }),
      expect.objectContaining({ kind: 'unexpected-argument', argument: 'extra', index: 4 }),
    ]);
  });

  it('reports a missing value without hiding the following registered option', () => {
    // A non-boolean option cannot consume another option token as its missing value.
    const deploy = command([
      { name: 'output', type: 'string' },
      { name: 'force', type: 'boolean' },
    ]);
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(['deploy', '--output', '--force'], registry, 'strict');

    expect(result.options).toEqual({ force: true });
    expect(result.issues).toEqual([
      expect.objectContaining({
        kind: 'malformed-argument',
        argument: '--output',
        index: 1,
        optionName: 'output',
      }),
    ]);
  });

  it('uses last-value semantics unless an option explicitly accumulates', () => {
    // Duplicate occurrences remain observable even when only the final scalar value is effective.
    const deploy = command([
      { name: 'output', type: 'string' },
      { name: 'file', type: 'string', multiple: true },
    ]);
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(
      ['deploy', '--output=a', '--file=one', '--output=b', '--file=two'],
      registry,
      'strict'
    );

    expect(result.options).toEqual({ output: 'b', file: ['one', 'two'] });
    expect(result.occurrences.map(occurrence => occurrence.option.name)).toEqual([
      'output',
      'file',
      'output',
      'file',
    ]);
    expect(result.issues).toEqual([]);
  });

  it('treats an attached empty value as supplied input', () => {
    // The equals sign distinguishes an explicit empty value from a missing neighboring value.
    const deploy = command([{ name: 'output', type: 'string' }]);
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(['deploy', '--output='], registry, 'strict');

    expect(result.options).toEqual({ output: '' });
    expect(result.occurrences[0]).toMatchObject({ value: '', spelling: '--output=' });
    expect(result.issues).toEqual([]);
  });

  it('consumes default-command option values before deciding that no command token exists', () => {
    // A plain option value must not be mistaken for an explicit unknown command.
    const deploy = command([{ name: 'output', type: 'string' }], { default: true });
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(['--output', 'release'], registry, 'strict');

    expect(result.command).toBe(deploy);
    expect(result.commandIndex).toBeUndefined();
    expect(result.options).toEqual({ output: 'release' });
    expect(result.issues).toEqual([]);
  });

  it('orders malformed and unexpected leftovers by their original positions', () => {
    // Unsupported passthrough syntax and later operands remain distinct deterministic failures.
    const deploy = command();
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const result = parseArguments(['deploy', '--', 'extra'], registry, 'strict');

    expect(result.issues).toEqual([
      expect.objectContaining({ kind: 'malformed-argument', argument: '--', index: 1 }),
      expect.objectContaining({ kind: 'unexpected-argument', argument: 'extra', index: 2 }),
    ]);
  });

  it('keeps strict spelling exact while normalizing legacy command lookup', () => {
    // Compatibility lookup may fold case, but strict lookup must preserve declared spelling.
    const deploy = command([], { name: 'Deploy' });
    const registry = createArgumentRegistry({ parserName: 'test-cli', commands: [deploy] });

    const strictResult = parseArguments(['deploy'], registry, 'strict');
    const legacyResult = parseArguments(['deploy'], registry, 'legacy');

    expect(strictResult.command).toBeUndefined();
    expect(strictResult.issues[0]).toMatchObject({ kind: 'unknown-command', argument: 'deploy' });
    expect(legacyResult.command).toBe(deploy);
    expect(legacyResult.issues).toEqual([]);
  });

  it('reports malformed long and short option spellings without hiding later input', () => {
    const registry = createArgumentRegistry({
      parserName: 'test-cli',
      commands: [command()],
    });

    const result = parseArguments(['deploy', '--1bad', '-1x', 'later'], registry, 'strict');

    expect(result.issues.map(issue => issue.kind)).toEqual([
      'malformed-argument',
      'malformed-argument',
      'unexpected-argument',
    ]);
  });

  it('retains first-owner precedence when duplicate spellings reach the pure registry', () => {
    const first = command([], { name: 'deploy', aliases: ['ship'] });
    const second = command([], { name: 'deploy', aliases: ['ship'] });
    const firstGlobal: ICommandOption = { name: 'profile', short: 'p' };
    const duplicateGlobal: ICommandOption = { name: 'profile', short: 'p' };

    const registry = createArgumentRegistry({
      parserName: 'test-cli',
      commands: [first, second],
      globalOptions: [firstGlobal, duplicateGlobal],
    });

    expect(registry.strictCommands.get('deploy')).toBe(first);
    expect(registry.legacyCommands.get('ship')).toBe(first);
    expect(registry.strictGlobalLongOptions.get('profile')).toBe(firstGlobal);
    expect(registry.strictGlobalShortOptions.get('p')).toBe(firstGlobal);
  });

  it('covers explicit boolean text and invalid attached boolean text', () => {
    const enabled: ICommandOption = { name: 'enabled', type: 'boolean' };
    const registry = createArgumentRegistry({
      parserName: 'test-cli',
      commands: [command([enabled])],
    });

    const result = parseArguments(
      ['deploy', '--enabled=true', '--enabled=maybe'],
      registry,
      'strict'
    );

    expect(result.occurrences.map(occurrence => occurrence.value)).toEqual([true, 'maybe']);
  });
});
