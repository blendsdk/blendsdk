/**
 * Specification tests for the local example repair tool.
 *
 * The repair tool consumes a validation report and asks a language model to fix
 * only the blocks that failed, using the SDK's public declarations. It rewrites
 * the reference in place, repeats up to a bounded number of rounds, keeps every
 * path inside the skill tree, and never runs in CI.
 *
 * Every test runs against a throwaway monorepo seeded from `tests/fixtures/`.
 *
 * @module skill/tests/repair-examples.spec
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { repairExamples } from '../repair.js';
import { validateExamples } from '../validate-examples.js';
import { createFixtureWorkspace } from './helpers/fixture-workspace.js';
import { writeWidgetUmbrella, WIDGET_REFERENCE_PATH } from './helpers/widget-fixture.js';

import type { FixtureWorkspace } from './helpers/fixture-workspace.js';
import type { RepairDependencies } from '../repair.js';

/** A block that uses a member the `Widget` type does not have. */
const BAD_BLOCK = [
  "import { Widget } from 'blendsdk/widget';",
  '',
  'const widget = new Widget();',
  'widget.nope();',
].join('\n');

/** A corrected block that only uses a real member. */
const GOOD_BLOCK = [
  "import { Widget } from 'blendsdk/widget';",
  '',
  'const widget = new Widget();',
  'console.log(widget.label);',
].join('\n');

/** Wraps a code block with a fence and a header, so bodies start on line 4. */
function fenced(code: string, infoString = 'ts'): string {
  return ['# Widget', '', '```' + infoString, code, '```', ''].join('\n');
}

/** Returns a generator that always answers with a single fenced block. */
function generatorReturning(code: string): RepairDependencies {
  return {
    generate: async () => '```ts\n' + code + '\n```',
  };
}

/** Writes the reference used by every repair test. */
function writeReference(workspace: FixtureWorkspace, content: string): void {
  const reference = path.join(workspace.skillDir, WIDGET_REFERENCE_PATH);
  fs.mkdirSync(path.dirname(reference), { recursive: true });
  fs.writeFileSync(reference, content, 'utf-8');
}

/** Reads the reference used by every repair test. */
function readReference(workspace: FixtureWorkspace): string {
  return fs.readFileSync(path.join(workspace.skillDir, WIDGET_REFERENCE_PATH), 'utf-8');
}

describe('Example repair tool', () => {
  let workspace: FixtureWorkspace;

  beforeEach(() => {
    workspace = createFixtureWorkspace();
    writeWidgetUmbrella(workspace.rootDir, true);
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('should rewrite only the failing blocks and leave passing blocks untouched', async () => {
    writeReference(workspace, fenced(BAD_BLOCK) + fenced(GOOD_BLOCK) + fenced(BAD_BLOCK));

    const result = await repairExamples(
      { rootDir: workspace.rootDir, report: validateExamples(workspace.rootDir) },
      generatorReturning(GOOD_BLOCK)
    );

    expect(result.fixed).toBe(2);
    expect(result.remaining).toBe(0);
    expect(readReference(workspace)).not.toContain('widget.nope()');
    expect(readReference(workspace).match(/widget\.label/g)?.length).toBe(3);
  });

  it('should stop after the round limit when a block stays broken', async () => {
    writeReference(workspace, fenced(BAD_BLOCK));

    const result = await repairExamples(
      { rootDir: workspace.rootDir, report: validateExamples(workspace.rootDir), maxRounds: 2 },
      generatorReturning(BAD_BLOCK)
    );

    expect(result.rounds).toBe(2);
    expect(result.remaining).toBeGreaterThan(0);
  });

  it('should refuse a path outside the skill tree', async () => {
    writeReference(workspace, fenced(BAD_BLOCK));
    const report = validateExamples(workspace.rootDir);
    report.details = [{ file: '../outside.md', line: 1, tier: '2', message: 'error TS2339' }];

    await expect(
      repairExamples({ rootDir: workspace.rootDir, report }, generatorReturning(GOOD_BLOCK))
    ).rejects.toThrow();

    expect(fs.existsSync(path.join(workspace.rootDir, 'outside.md'))).toBe(false);
  });

  it('should never execute extracted code or build a shell command from it', () => {
    const sourcePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'repair.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).not.toMatch(/\bexecSync\s*\(/);
    expect(source).not.toMatch(/(?<![.\w])exec\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\s*\(/);
  });
});
