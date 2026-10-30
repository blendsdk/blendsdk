/**
 * Fixture workspace helpers for the skill generator specification tests.
 *
 * The tests must never read or write the real repository's `.agents/skills/`
 * tree. Each test builds a throwaway monorepo in the operating system's temp
 * directory, seeded from the read-only fixtures under `tests/fixtures/`.
 *
 * @module skill/tests/helpers/fixture-workspace
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AiTrainingManifest, PackageHashes } from '../../../ai-training/types.js';

/** Absolute path to the read-only fixture directory. */
const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures'
);

/** Version declared by the fixture umbrella package (`packages/blendsdk`). */
export const FIXTURE_SDK_VERSION = '5.54.0';

/** Version embedded in the fixture ai-training sources, which must be replaced. */
export const FIXTURE_STALE_VERSION = '5.42.0';

/** Name of the single fixture package that is documented. */
export const FIXTURE_PACKAGE_NAME = 'package-a';

/**
 * Narrows an unknown value to the manifest shape the fixtures use.
 *
 * The helper avoids an unchecked cast so a malformed fixture fails with a clear
 * message instead of producing misleading test results.
 *
 * @param value - Parsed JSON value
 * @returns True when the value has a `packages` object
 */
function isManifest(value: unknown): value is AiTrainingManifest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'packages' in value &&
    typeof value.packages === 'object' &&
    value.packages !== null
  );
}

/** A throwaway monorepo used by one test. */
export interface FixtureWorkspace {
  /** Absolute path to the temporary repository root. */
  rootDir: string;

  /** Absolute path to `.agents/skills/blendsdk` inside the temporary root. */
  skillDir: string;

  /** Absolute path to `packages/package-a` inside the temporary root. */
  packageDir: string;

  /** Removes the temporary tree from disk. */
  cleanup(): void;
}

/**
 * Recursively copies a directory tree.
 *
 * @param source - Absolute path to the directory to copy
 * @param destination - Absolute path to create
 */
function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });

  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

/**
 * Creates a throwaway monorepo seeded from the fixtures.
 *
 * The tree contains the documented fixture package, the umbrella package used
 * for version resolution, and a committed skill tree holding a hand-written
 * `SKILL.md`.
 *
 * @returns A workspace handle with a cleanup function
 */
export function createFixtureWorkspace(): FixtureWorkspace {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-skill-spec-'));

  copyDirectory(
    path.join(FIXTURES_DIR, 'package-a'),
    path.join(rootDir, 'packages', FIXTURE_PACKAGE_NAME)
  );

  const umbrellaDir = path.join(rootDir, 'packages', 'blendsdk');
  fs.mkdirSync(umbrellaDir, { recursive: true });
  fs.writeFileSync(
    path.join(umbrellaDir, 'package.json'),
    JSON.stringify({ name: 'blendsdk', version: FIXTURE_SDK_VERSION }, null, 2) + '\n',
    'utf-8'
  );

  const skillDir = path.join(rootDir, '.agents', 'skills', 'blendsdk');
  fs.mkdirSync(skillDir, { recursive: true });
  copyDirectory(path.join(FIXTURES_DIR, 'skill-tree'), skillDir);

  return {
    rootDir,
    skillDir,
    packageDir: path.join(rootDir, 'packages', FIXTURE_PACKAGE_NAME),
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

/**
 * Reads every file under a directory into a map keyed by relative path.
 *
 * Keys use forward slashes so assertions are stable across platforms.
 *
 * @param dir - Absolute path to the directory to read
 * @returns Map of relative path to file content
 */
export function readTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();

  if (!fs.existsSync(dir)) {
    return files;
  }

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relative = path.relative(dir, fullPath).split(path.sep).join('/');
        files.set(relative, fs.readFileSync(fullPath, 'utf-8'));
      }
    }
  };

  walk(dir);
  return files;
}

/**
 * Loads one of the manifest fixtures and fills placeholder hashes with the
 * supplied values.
 *
 * Fixture files use the sentinel `__FRESH_HASH__` where a hash must match the
 * fixture package's current source. Tests pass the real computed hashes so the
 * freshness gate sees a genuinely fresh entry.
 *
 * @param name - Fixture file name without the `.json` extension
 * @param hashes - Hashes computed from the fixture package's current source
 * @returns The parsed manifest with placeholders resolved
 */
export function loadManifestFixture(name: string, hashes: PackageHashes): AiTrainingManifest {
  const fixturePath = path.join(FIXTURES_DIR, 'manifest', `${name}.json`);
  const parsed: unknown = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

  if (!isManifest(parsed)) {
    throw new Error(`Manifest fixture ${name}.json does not match the manifest shape.`);
  }

  const manifest = parsed;
  const entry = manifest.packages[FIXTURE_PACKAGE_NAME];

  if (entry) {
    for (const key of ['src', 'tests', 'apiSurface', 'packageJson'] as const) {
      if (entry.hashes[key] === '__FRESH_HASH__') {
        entry.hashes[key] = hashes[key];
      }
    }
    if (entry.aiTrainingHash === '__FRESH_HASH__') {
      entry.aiTrainingHash = hashes.src;
    }
  }

  return manifest;
}

/**
 * Writes an ai-training manifest into a workspace root.
 *
 * @param rootDir - Absolute path to the workspace root
 * @param manifest - Manifest to serialize
 */
export function writeManifest(rootDir: string, manifest: AiTrainingManifest): void {
  fs.writeFileSync(
    path.join(rootDir, '.ai-training-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8'
  );
}
