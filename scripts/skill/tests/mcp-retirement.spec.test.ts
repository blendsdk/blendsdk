/**
 * Specification tests for MCP retirement.
 *
 * The MCP documentation server is replaced by the agent skill. After retirement
 * the package directory is gone and no build, publish, or test path refers to
 * it. Historical archives and changelogs are out of scope; the scanned roots
 * are the active ones listed in RD-05.
 *
 * @module skill/tests/mcp-retirement.spec
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Absolute path to the repository root. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The retired package name. */
const RETIRED = 'blendsdk-mcp';

/** Directories never scanned. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo']);

/**
 * Finds every file under a directory that contains a needle.
 *
 * @param dir - Absolute path to the directory to scan
 * @param needle - Substring to look for
 * @returns Absolute paths of matching files
 */
function filesContaining(dir: string, needle: string): string[] {
  const matches: string[] = [];
  if (!fs.existsSync(dir)) {
    return matches;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      matches.push(...filesContaining(path.join(dir, entry.name), needle));
    } else {
      const file = path.join(dir, entry.name);
      if (fs.readFileSync(file, 'utf-8').includes(needle)) {
        matches.push(path.relative(ROOT, file));
      }
    }
  }

  return matches;
}

describe('MCP retirement', () => {
  it('should remove the blendsdk-mcp package directory', () => {
    expect(fs.existsSync(path.join(ROOT, 'packages', RETIRED))).toBe(false);
  });

  it('should leave no blendsdk-mcp reference in build, publish, or test paths', () => {
    const buildPublishPaths = [
      path.join(ROOT, '.github', 'workflows', 'release.yml'),
      path.join(ROOT, '.github', 'workflows', 'ci.yml'),
      path.join(ROOT, 'scripts', 'lockstep.ts'),
      path.join(ROOT, 'scripts', 'assemble.ts'),
      path.join(ROOT, 'scripts', 'sync-public.sh'),
      path.join(ROOT, 'scripts', 'ai-training', 'change-detection.ts'),
    ].filter(file => fs.existsSync(file));

    const offending = buildPublishPaths.filter(file =>
      fs.readFileSync(file, 'utf-8').includes(RETIRED)
    );
    expect(offending.map(file => path.relative(ROOT, file))).toEqual([]);

    expect(filesContaining(path.join(ROOT, 'packages', 'blendscript', 'tests'), RETIRED)).toEqual(
      []
    );
    expect(filesContaining(path.join(ROOT, '.clinerules'), RETIRED)).toEqual([]);
  });

  it('should leave no blendsdk-mcp reference in package manifests', () => {
    const manifests = fs
      .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(ROOT, 'packages', entry.name, 'package.json'))
      .filter(file => fs.existsSync(file));

    const offending = manifests.filter(file =>
      fs.readFileSync(file, 'utf-8').includes(RETIRED)
    );
    expect(offending.map(file => path.relative(ROOT, file))).toEqual([]);
  });

  it('should exclude blendsdk-mcp from the ai-training package exclusions', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'scripts', 'ai-training', 'change-detection.ts'),
      'utf-8'
    );

    expect(source).not.toContain(RETIRED);
    expect(source).toContain('playground');
  });
});
