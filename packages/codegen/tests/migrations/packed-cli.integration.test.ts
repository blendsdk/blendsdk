import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const assembledPackage = join(repositoryRoot, 'packages/blendsdk');
let consumerDirectory = '';
let installedPackage = '';

/** Returns true for a plain non-null property record. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Packs the assembled SDK, extracts those exact bytes, and wires only its regular dependencies.
 *
 * Using the repository's already-installed dependency copies keeps this integration test offline;
 * the package contents themselves still come exclusively from the publishable tarball.
 */
async function installPackedConsumer(): Promise<void> {
  consumerDirectory = await mkdtemp(join(tmpdir(), 'blendsdk-packed-consumer-'));
  const packDirectory = join(consumerDirectory, 'pack');
  const nodeModules = join(consumerDirectory, 'node_modules');
  await Promise.all([mkdir(packDirectory), mkdir(join(nodeModules, '.bin'), { recursive: true })]);
  await executeFile('npm', ['pack', '--ignore-scripts', '--pack-destination', packDirectory], {
    cwd: assembledPackage,
    timeout: 30_000,
  });
  const archive = (await readdir(packDirectory)).find(file => file.endsWith('.tgz'));
  if (!archive) throw new Error('npm pack did not create a BlendSDK tarball.');

  await executeFile('tar', ['-xzf', join(packDirectory, archive), '-C', consumerDirectory], {
    timeout: 30_000,
  });
  installedPackage = join(nodeModules, 'blendsdk');
  await rename(join(consumerDirectory, 'package'), installedPackage);
  await Promise.all([
    symlink(
      join(repositoryRoot, 'node_modules/damerau-levenshtein'),
      join(nodeModules, 'damerau-levenshtein'),
      'dir'
    ),
    symlink(join(repositoryRoot, 'node_modules/jiti'), join(nodeModules, 'jiti'), 'dir'),
    symlink(join(repositoryRoot, 'node_modules/prettier'), join(nodeModules, 'prettier'), 'dir'),
    symlink(join(repositoryRoot, 'node_modules/zod'), join(nodeModules, 'zod'), 'dir'),
    symlink('../blendsdk/dist/codegen/cli.js', join(nodeModules, '.bin/blendsdk'), 'file'),
  ]);
}

beforeAll(installPackedConsumer, 60_000);

afterAll(async () => {
  if (consumerDirectory) {
    await rm(consumerDirectory, { recursive: true, force: true });
  }
});

describe('packed migration CLI integration', () => {
  test('should expose the public API and executable without PostgreSQL installed', async () => {
    const packageJson: unknown = JSON.parse(
      await readFile(join(installedPackage, 'package.json'), 'utf8')
    );
    if (!isRecord(packageJson) || !isRecord(packageJson.bin)) {
      throw new Error('Packed BlendSDK package has no executable map.');
    }
    expect(packageJson.bin.blendsdk).toBe('./dist/codegen/cli.js');
    expect(packageJson.dependencies).toMatchObject({
      'damerau-levenshtein': '^1.0.8',
      prettier: '^3.9.6',
    });
    expect(await readdir(join(consumerDirectory, 'node_modules'))).not.toContain('pg');

    const publicApi: unknown = await import(
      pathToFileURL(join(installedPackage, 'dist/codegen/index.js')).href
    );
    expect(publicApi).toMatchObject({
      generateMigration: expect.any(Function),
      runMigrations: expect.any(Function),
      validateMigrations: expect.any(Function),
    });

    const result = await executeFile(join(consumerDirectory, 'node_modules/.bin/blendsdk'), [
      'migrate',
      '--help',
    ]);
    expect(result.stdout).toContain('BlendSDK PostgreSQL migrations');
    expect(result.stderr).toBe('');
  });

  test('should complete the disposable PostgreSQL playground workflow through the assembled CLI', async () => {
    const result = await executeFile(
      'yarn',
      ['workspace', '@blendsdk/playground', 'migrations:smoke'],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          BLENDSDK_PLAYGROUND_ADMIN_URL: 'postgresql://postgres:postgres@127.0.0.1:5597/postgres',
        },
        timeout: 60_000,
      }
    );

    expect(result.stdout).toMatch(/GENERATED .+add-display-name/u);
    expect(result.stdout).toMatch(/CREATED .+seed-customer-status/u);
    expect(result.stdout).toContain('PENDING');
    expect(result.stdout).toContain('UP_TO_DATE');
    expect(result.stderr).toBe('');
  }, 70_000);
});
