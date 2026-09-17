/**
 * Drift gate for the committed BlendSDK agent skill tree.
 *
 * The gate regenerates the skill into a temporary directory and compares the
 * result with the committed tree. Only generated files are compared: a file is
 * generated when it ends with the generator marker, so hand-written and
 * migrated content is ignored by design. Any missing, added, or byte-different
 * generated file fails the gate.
 *
 * @module skill/check-drift
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateSkillTree } from './generate.js';
import { GENERATED_MARKER } from './mapping.js';

/**
 * Result of a drift comparison.
 */
export interface DriftReport {
  /** True when the committed tree matches a fresh regeneration exactly. */
  ok: boolean;

  /** Committed generated files that a fresh run would not produce. */
  missing: string[];

  /** Files a fresh run would add that are not committed. */
  added: string[];

  /** Files whose committed bytes differ from a fresh run. */
  changed: string[];
}

/**
 * Recursively collects generated files under a directory.
 *
 * Paths are returned relative to `dir` using `/` separators. Files without the
 * generated marker are skipped, which is what keeps hand-written and migrated
 * content out of the comparison.
 *
 * @param dir - Absolute path to the directory to scan
 * @returns Map of relative path to content for generated files only
 */
function readGeneratedFiles(dir: string): Map<string, string> {
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
        const content = fs.readFileSync(fullPath, 'utf-8');

        if (content.trimEnd().endsWith(GENERATED_MARKER)) {
          files.set(path.relative(dir, fullPath).split(path.sep).join('/'), content);
        }
      }
    }
  };

  walk(dir);
  return files;
}

/**
 * Compares the committed skill tree with a fresh generation.
 *
 * @param options - Drift options
 * @param options.rootDir - Absolute path to the monorepo root
 * @param options.skillDir - Committed skill directory; defaults to
 *   `<rootDir>/.agents/skills/blendsdk`
 * @returns The drift report
 */
export function checkDrift(options: { rootDir: string; skillDir?: string }): DriftReport {
  const rootDir = path.resolve(options.rootDir);
  const skillDir = path.resolve(
    options.skillDir ?? path.join(rootDir, '.agents', 'skills', 'blendsdk')
  );
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-skill-drift-'));

  try {
    generateSkillTree({ rootDir, skillDir, outputDir: tempDir });

    const committed = readGeneratedFiles(skillDir);
    const regenerated = readGeneratedFiles(tempDir);

    const missing: string[] = [];
    const added: string[] = [];
    const changed: string[] = [];

    for (const [relativePath, content] of regenerated) {
      if (!committed.has(relativePath)) {
        added.push(relativePath);
      } else if (committed.get(relativePath) !== content) {
        changed.push(relativePath);
      }
    }

    for (const relativePath of committed.keys()) {
      if (!regenerated.has(relativePath)) {
        missing.push(relativePath);
      }
    }

    missing.sort();
    added.sort();
    changed.sort();

    return {
      ok: missing.length === 0 && added.length === 0 && changed.length === 0,
      missing,
      added,
      changed,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Runs the drift gate as a command-line tool.
 *
 * Prints a success line or the offending paths and sets a non-zero exit code.
 */
function main(): void {
  try {
    const report = checkDrift({ rootDir: process.cwd() });

    if (report.ok) {
      console.log('Skill tree is up to date.');
      return;
    }

    console.error('Skill tree is out of date: run yarn skill:generate.');
    for (const relativePath of report.missing) {
      console.error(`  missing: ${relativePath}`);
    }
    for (const relativePath of report.added) {
      console.error(`  added:   ${relativePath}`);
    }
    for (const relativePath of report.changed) {
      console.error(`  changed: ${relativePath}`);
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
