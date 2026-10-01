/**
 * Implementation tests for the deterministic skill generator.
 *
 * These tests cover internals and edge cases that the specification tests do
 * not: the returned summary, CRLF input normalization, duplicate metadata
 * blocks, and empty source sections.
 *
 * @module skill/tests/generate.impl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateSkillTree } from '../generate.js';
import { GENERATED_MARKER, SkillGenerationError } from '../mapping.js';
import {
  FIXTURE_PACKAGE_NAME,
  createFixtureWorkspace,
  readTree,
} from './helpers/fixture-workspace.js';

import type { FixtureWorkspace } from './helpers/fixture-workspace.js';

describe('Skill generator (implementation)', () => {
  let workspace: FixtureWorkspace;

  beforeEach(() => {
    workspace = createFixtureWorkspace();
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('should report every written file and the generated packages', () => {
    const summary = generateSkillTree({ rootDir: workspace.rootDir });

    expect(summary.packages).toEqual([FIXTURE_PACKAGE_NAME]);
    expect(summary.filesWritten).toEqual([
      `references/packages/${FIXTURE_PACKAGE_NAME}/overview.md`,
      `references/packages/${FIXTURE_PACKAGE_NAME}/usage.md`,
      `references/packages/${FIXTURE_PACKAGE_NAME}/recipes.md`,
      `references/packages/${FIXTURE_PACKAGE_NAME}/pitfalls.md`,
      `references/packages/${FIXTURE_PACKAGE_NAME}/api.md`,
      'references/index.md',
      'references/dependency-graph.md',
    ]);
  });

  it('should normalize CRLF input to LF output', () => {
    const sourcePath = path.join(workspace.packageDir, 'ai-training', '01-core-concepts.md');
    const crlf = fs.readFileSync(sourcePath, 'utf-8').replace(/\n/g, '\r\n');
    fs.writeFileSync(sourcePath, crlf, 'utf-8');

    generateSkillTree({ rootDir: workspace.rootDir });

    const usage = readTree(workspace.skillDir).get(
      `references/packages/${FIXTURE_PACKAGE_NAME}/usage.md`
    );
    expect(usage).toBeDefined();
    expect(usage?.includes('\r')).toBe(false);
  });

  it('should emit a single canonical metadata header when sources have duplicate blocks', () => {
    const duplicated = [
      '# package-a Basic Usage',
      '',
      '> **Package**: `@blendsdk/package-a`',
      '> **Version**: 5.42.0',
      '',
      '> **Package**: `@blendsdk/package-a`',
      '> **Version**: 5.42.0',
      '',
      'Body text.',
      '',
    ].join('\n');
    fs.writeFileSync(
      path.join(workspace.packageDir, 'ai-training', '02-basic-usage.md'),
      duplicated,
      'utf-8'
    );

    generateSkillTree({ rootDir: workspace.rootDir });

    const usage = readTree(workspace.skillDir).get(
      `references/packages/${FIXTURE_PACKAGE_NAME}/usage.md`
    );
    expect(usage).toBeDefined();
    expect(usage?.match(/> \*\*Package\*\*:/g)).toHaveLength(1);
    expect(usage?.trimEnd().endsWith(GENERATED_MARKER)).toBe(true);
  });

  it('should tolerate an empty source section', () => {
    fs.writeFileSync(
      path.join(workspace.packageDir, 'ai-training', '03-advanced-patterns.md'),
      '',
      'utf-8'
    );

    expect(() => generateSkillTree({ rootDir: workspace.rootDir })).not.toThrow();

    const recipes = readTree(workspace.skillDir).get(
      `references/packages/${FIXTURE_PACKAGE_NAME}/recipes.md`
    );
    expect(recipes?.trimEnd().endsWith(GENERATED_MARKER)).toBe(true);
  });

  it('should write only the requested subset of packages', () => {
    const summary = generateSkillTree({
      rootDir: workspace.rootDir,
      packages: [FIXTURE_PACKAGE_NAME],
    });

    expect(summary.packages).toEqual([FIXTURE_PACKAGE_NAME]);
    expect(summary.filesWritten).toHaveLength(7);
  });

  it('should reject an output path whose ancestor directory is an escaping symlink', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-skill-outside-'));

    try {
      fs.symlinkSync(outside, path.join(workspace.skillDir, 'references'));

      expect(() => generateSkillTree({ rootDir: workspace.rootDir })).toThrow(SkillGenerationError);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('should reject a dangling symlink at the destination leaf', () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-skill-dangling-'));
    const outsideTarget = path.join(outsideDir, 'escaped.md');

    try {
      const targetDir = path.join(
        workspace.skillDir,
        'references',
        'packages',
        FIXTURE_PACKAGE_NAME
      );
      fs.mkdirSync(targetDir, { recursive: true });
      fs.symlinkSync(outsideTarget, path.join(targetDir, 'overview.md'));

      expect(() => generateSkillTree({ rootDir: workspace.rootDir })).toThrow(SkillGenerationError);
      expect(fs.existsSync(outsideTarget)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('should strip the private scope even inside file paths', () => {
    const source = path.join(workspace.packageDir, 'ai-training', '07-troubleshooting.md');
    const marker = '```markdown\n';
    const raw = fs.readFileSync(source, 'utf-8');
    const openingFenceEnd = raw.indexOf(marker) + marker.length;
    const injected =
      raw.slice(0, openingFenceEnd) +
      'Error: cannot resolve /app/node_modules/@blendsdk/webafx/package.json\n\n' +
      raw.slice(openingFenceEnd);
    fs.writeFileSync(source, injected, 'utf-8');

    generateSkillTree({ rootDir: workspace.rootDir });

    const pitfalls = readTree(workspace.skillDir).get(
      `references/packages/${FIXTURE_PACKAGE_NAME}/pitfalls.md`
    );

    expect(pitfalls).toBeDefined();
    expect(pitfalls).not.toContain('@blendsdk/');
    expect(pitfalls).toContain('/app/node_modules/blendsdk/webafx/package.json');
  });
});
