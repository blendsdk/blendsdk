/**
 * Source-freshness gate for the committed BlendSDK agent skill.
 *
 * The gate proves the committed skill was assembled from the current package
 * sources. It reads `.ai-training-manifest.json` and compares each package's
 * stored hashes with what is on disk. A mismatch means the sources changed
 * after the skill was generated, so the skill must be regenerated. The stored
 * SDK version is inert provenance and never invalidates freshness.
 *
 * This gate is not run on every push: any package edit would turn CI red until
 * a paid source regeneration runs. It blocks publishing instead, and stays
 * available locally.
 *
 * @module skill/check-freshness
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computePackageHashes,
  discoverDocumentablePackages,
} from '../ai-training/change-detection.js';
import { MANIFEST_FILENAME, readManifest } from '../ai-training/manifest.js';

import type { PackageHashes } from '../ai-training/types.js';

/**
 * Result of a freshness check.
 */
export interface FreshnessReport {
  /** True when every documented package's content hashes match the manifest. */
  ok: boolean;

  /** One message per freshness problem, in package order. */
  problems: string[];
}

/** Hash categories compared against the manifest, in a stable order. */
const HASH_FIELDS: ReadonlyArray<keyof PackageHashes> = [
  'src',
  'tests',
  'apiSurface',
  'packageJson',
];

/**
 * Checks that the manifest file exists and contains parseable JSON.
 *
 * `readManifest` deliberately recovers from a missing or corrupt manifest, so
 * the gate would otherwise report per-package problems instead of naming the
 * file. This pre-check produces the clear, actionable failure the error table
 * requires.
 *
 * @param manifestPath - Absolute path to `.ai-training-manifest.json`
 * @returns A problem message, or `undefined` when the file is usable
 */
function inspectManifestFile(manifestPath: string): string | undefined {
  if (!fs.existsSync(manifestPath)) {
    return `stale: manifest not found at ${manifestPath} — run yarn skill:generate after regenerating ai-training`;
  }

  try {
    JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return `stale: manifest at ${manifestPath} is not valid JSON — run yarn skill:generate`;
  }

  return undefined;
}

/**
 * Checks whether the committed skill is built from the current sources.
 *
 * @param rootDir - Absolute path to the monorepo root
 * @returns The freshness report
 * @throws SkillGenerationError when the umbrella package version cannot be read
 */
export function checkFreshness(rootDir: string): FreshnessReport {
  const resolvedRoot = path.resolve(rootDir);

  const manifestProblem = inspectManifestFile(path.join(resolvedRoot, MANIFEST_FILENAME));
  if (manifestProblem) {
    return { ok: false, problems: [manifestProblem] };
  }

  const manifest = readManifest(resolvedRoot);
  const packageNames = [...discoverDocumentablePackages(resolvedRoot)].sort();
  const problems: string[] = [];

  if (packageNames.length === 0) {
    return { ok: false, problems: ['stale: no documentable packages discovered'] };
  }

  for (const packageName of packageNames) {
    const entry = manifest.packages[packageName];

    if (!entry) {
      problems.push(`stale: ${packageName} has no manifest entry`);
      continue;
    }

    const currentHashes = computePackageHashes(path.join(resolvedRoot, 'packages', packageName));
    const hashChanged = HASH_FIELDS.some(
      (field) => currentHashes[field] !== entry.hashes[field]
    );

    if (hashChanged) {
      problems.push(
        `stale: ${packageName} — run yarn skill:generate after regenerating ai-training`
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Runs the freshness gate as a command-line tool.
 *
 * Prints a success line or the problem list and sets a non-zero exit code.
 */
function main(): void {
  try {
    const report = checkFreshness(process.cwd());

    if (report.ok) {
      console.log('Skill sources are fresh.');
      return;
    }

    console.error('Skill sources are stale:');
    for (const problem of report.problems) {
      console.error(`  ${problem}`);
    }
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
