import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/api/cli.js';
import { loadApiContract } from '../src/api/config.js';
import { ApiCliError } from '../src/api/errors.js';

/**
 * Implementation tests for the `blendsdk api` CLI: configuration discovery and
 * validation, and command-line parsing and exit codes.
 *
 * @module codegen/tests/api-cli.impl
 */

/** Directories created by a test, removed after each test. */
const tempDirectories: string[] = [];

/**
 * Creates an empty temporary directory.
 *
 * @returns The absolute path of the new directory.
 */
function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-api-cli-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

/**
 * Writes a config file and returns its path.
 *
 * @param directory - The directory to write into.
 * @param contractBody - The object body to place after `export default`.
 * @returns The config file path.
 */
function writeConfig(directory: string, contractBody: string): string {
  const configPath = path.join(directory, 'blendsdk.api.ts');
  fs.writeFileSync(
    configPath,
    [
      'class ThingsController {',
      '  routes() {',
      '    return [',
      '      {',
      "        method: 'get',",
      "        path: '/',",
      '        handler: () => undefined,',
      '        openapi: {',
      "          operationId: 'listThings',",
      "          tags: ['things'],",
      "          responses: [{ statusCode: 200, description: 'ok', schema: {} }],",
      '        },',
      '      },',
      '    ];',
      '  }',
      '}',
      `export default ${contractBody};`,
      '',
    ].join('\n')
  );
  return configPath;
}

/** The standard valid contract body used by the tests. */
const VALID_BODY = [
  '{',
  "  outputDir: 'client',",
  "  contractFile: 'api.json',",
  "  controllers: [{ basePath: '/api/things', controller: ThingsController }],",
  "  openapi: { title: 'Impl API', version: '1.0.0' },",
  '}',
].join('\n');

/**
 * Runs the CLI and captures its output.
 *
 * @param argv - The arguments after the executable name.
 * @returns The exit code and captured stderr.
 */
async function run(argv: string[]): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  const code = await main(argv, {
    stdout: () => undefined,
    stderr: message => (stderr += message),
  });
  return { code, stderr };
}

describe('api contract discovery and validation', () => {
  test('discovers the config by searching upward from a subdirectory', async () => {
    const directory = tempDirectory();
    const configPath = writeConfig(directory, VALID_BODY);
    const nested = path.join(directory, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });

    const contract = await loadApiContract({ startDirectory: nested });

    expect(contract.configPath).toBe(configPath);
    expect(contract.outputDir).toBe(path.join(directory, 'client'));
    expect(contract.contractFile).toBe(path.join(directory, 'api.json'));
  });

  test('rejects an output directory that escapes the config directory', async () => {
    const directory = tempDirectory();
    const configPath = writeConfig(directory, VALID_BODY.replace("'client'", "'../outside'"));

    const error = await loadApiContract({ configPath }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiCliError);
    expect((error as ApiCliError).exitCode).toBe(2);
  });

  test('rejects an unknown top-level configuration key', async () => {
    const directory = tempDirectory();
    const configPath = writeConfig(directory, VALID_BODY.replace('{', '{ unexpected: true,'));

    await expect(loadApiContract({ configPath })).rejects.toBeInstanceOf(ApiCliError);
  });

  test('rejects an unknown generator option', async () => {
    const directory = tempDirectory();
    const configPath = writeConfig(
      directory,
      VALID_BODY.replace('  outputDir', '  generator: { mystery: true },\n  outputDir')
    );

    await expect(loadApiContract({ configPath })).rejects.toBeInstanceOf(ApiCliError);
  });

  test('reports a missing config as a configuration error', async () => {
    const directory = tempDirectory();
    const error = await loadApiContract({
      configPath: path.join(directory, 'missing.ts'),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiCliError);
    expect((error as ApiCliError).exitCode).toBe(2);
  });

  test('does not discover a config above the repository root', async () => {
    const directory = tempDirectory();
    fs.mkdirSync(path.join(directory, '.git'));
    const nested = path.join(directory, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });

    await expect(loadApiContract({ startDirectory: nested })).rejects.toBeInstanceOf(ApiCliError);
  });
});

describe('api command parsing and exit codes', () => {
  test('prints help and exits 0 for --help', async () => {
    const result = await run(['api', '--help']);
    expect(result.code).toBe(0);
  });

  test('exits 2 when no action is given', async () => {
    expect((await run(['api'])).code).toBe(2);
  });

  test('exits 2 for an unknown option', async () => {
    expect((await run(['api', 'generate', '--wat'])).code).toBe(2);
  });

  test('exits 2 when --config has no value', async () => {
    expect((await run(['api', 'generate', '--config'])).code).toBe(2);
  });

  test('writes a valid contract JSON and exits 0 when generating', async () => {
    const directory = tempDirectory();
    const configPath = writeConfig(directory, VALID_BODY);

    const result = await run(['api', 'generate', '--config', configPath]);

    expect(result.code).toBe(0);
    const written = JSON.parse(fs.readFileSync(path.join(directory, 'api.json'), 'utf8')) as {
      openapi: string;
    };
    expect(written.openapi).toBe('3.1.0');
  });

  test('exits 1 when a committed file drifts', async () => {
    const directory = tempDirectory();
    const configPath = writeConfig(directory, VALID_BODY);
    await run(['api', 'generate', '--config', configPath]);
    fs.appendFileSync(path.join(directory, 'client', 'client.ts'), '\n// drift\n');

    const result = await run(['api', 'check', '--config', configPath]);

    expect(result.code).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('client.ts');
  });
});
