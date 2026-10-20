import { describe, expect, it, vi } from 'vitest';

import { CommandLineParser } from '../src/index.js';

describe('invocation-local command input and output', () => {
  it('can execute the same strict parser with independent argument lists', async () => {
    const values: string[] = [];
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'show',
      options: [{ name: 'value', type: 'string', required: true }],
      handler: options => values.push(String(options['value'])),
    });

    await parser.execute(undefined, { argv: ['show', '--value', 'first'] });
    await parser.execute(undefined, { argv: ['show', '--value', 'second'] });

    expect(values).toEqual(['first', 'second']);
  });

  it('renders strict help through the invocation writer without using console output', async () => {
    const output: string[] = [];
    const consoleOutput = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
      name: 'show',
      handler: vi.fn(),
    });

    await parser.execute(undefined, { argv: ['show', '--help'], write: line => output.push(line) });

    expect(output.join('\n')).toContain('Command:');
    expect(output.join('\n')).toContain('show');
    expect(consoleOutput).not.toHaveBeenCalled();
  });

  it('does not read or mutate process arguments when invocation arguments are supplied', async () => {
    const original = process.argv;
    const handler = vi.fn();
    process.argv = ['node', 'unrelated.js', 'wrong-command'];
    try {
      const parser = new CommandLineParser({ name: 'test-cli', strict: true }).addCommand({
        name: 'show',
        handler,
      });

      await parser.execute(undefined, { argv: ['show'] });

      expect(handler).toHaveBeenCalledOnce();
      expect(process.argv).toEqual(['node', 'unrelated.js', 'wrong-command']);
    } finally {
      process.argv = original;
    }
  });

  it('preserves the legacy execute return type for existing consumers', () => {
    const parser = new CommandLineParser({ name: 'test-cli' });
    const legacyResult: Promise<{ readonly value: string }> = parser.execute();

    expect(legacyResult).toBeInstanceOf(Promise);
  });
});
