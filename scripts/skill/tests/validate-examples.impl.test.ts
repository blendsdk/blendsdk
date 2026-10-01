/**
 * Implementation tests for the example validator.
 *
 * These cover parser edges and reporting internals that the specification
 * tests do not pin down: tilde fences, commented-out imports, the `ts
 * fragment` alias, non-`blendsdk` imports, `--filter` narrowing, and the
 * structured report shape. Most tests use fragments so they resolve imports
 * without paying for a compiler run; only the report test needs a real one.
 *
 * @module skill/tests/validate-examples.impl
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatProblem, formatValidationReport, validateExamples } from '../validate-examples.js';
import { FIXTURE_SDK_VERSION, createFixtureWorkspace } from './helpers/fixture-workspace.js';

import type { FixtureWorkspace } from './helpers/fixture-workspace.js';

/**
 * Writes a minimal umbrella package and the `widget` source package.
 *
 * @param rootDir - Absolute path to the fixture workspace root
 */
function writeUmbrella(rootDir: string): void {
  const umbrellaDir = path.join(rootDir, 'packages', 'blendsdk');
  fs.writeFileSync(
    path.join(umbrellaDir, 'package.json'),
    JSON.stringify(
      {
        name: 'blendsdk',
        version: FIXTURE_SDK_VERSION,
        exports: { './widget': { types: './dist/widget/index.d.ts' } },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  const sourceDir = path.join(rootDir, 'packages', 'widget', 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export class Widget {}\n', 'utf-8');
}

/**
 * Writes one reference into a fixture workspace.
 *
 * @param workspace - Fixture workspace to write into
 * @param relativePath - Reference path relative to the skill directory
 * @param content - Markdown content
 */
function writeReference(workspace: FixtureWorkspace, relativePath: string, content: string): void {
  const target = path.join(workspace.skillDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');
}

describe('Skill example validator (implementation)', () => {
  let workspace: FixtureWorkspace;

  beforeEach(() => {
    workspace = createFixtureWorkspace();
    writeUmbrella(workspace.rootDir);
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('should parse tilde fences the same way as backtick fences', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '~~~typescript fragment',
        "import { Nope } from 'blendsdk/widget';",
        '~~~',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(
      report.details.some(problem => problem.tier === '1b' && problem.file.endsWith('usage.md'))
    ).toBe(true);
  });

  it('should ignore imports that appear inside comments', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '```typescript fragment',
        "// import { Nope } from 'blendsdk/widget';",
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('should accept the ts fragment alias and skip its type check', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '```ts fragment',
        "import { Widget } from 'blendsdk/widget';",
        "const broken: number = 'text';",
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.fragmentsSkipped).toBe(1);
  });

  it('should ignore imports that do not target blendsdk', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '```typescript fragment',
        "import { useState } from 'react';",
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
  });

  it('should scan only the filtered reference', () => {
    writeReference(
      workspace,
      'references/packages/widget/good.md',
      [
        '# Good',
        '',
        '```typescript fragment',
        "import { Widget } from 'blendsdk/widget';",
        '```',
        '',
      ].join('\n')
    );
    writeReference(
      workspace,
      'references/packages/widget/bad.md',
      [
        '# Bad',
        '',
        '```typescript fragment',
        "import { Nope } from 'blendsdk/widget';",
        '```',
        '',
      ].join('\n')
    );

    const clean = validateExamples(workspace.rootDir, {
      filter: '.agents/skills/blendsdk/references/packages/widget/good.md',
    });
    const dirty = validateExamples(workspace.rootDir, {
      filter: '.agents/skills/blendsdk/references/packages/widget/bad.md',
    });

    expect(clean.filesScanned).toBe(1);
    expect(clean.ok).toBe(true);
    expect(dirty.ok).toBe(false);
  });

  it('should skip a block that imports a sibling file', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '```typescript',
        "import { makeWidget } from './helpers.js';",
        'const widget = makeWidget();',
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.contextualSkipped).toBe(1);
  });

  it('should skip a block that drives a test runner', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '```typescript',
        "import { Widget } from 'blendsdk/widget';",
        "describe('Widget', () => {",
        "  it('works', () => {",
        '    expect(new Widget()).toBeDefined();',
        '  });',
        '});',
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.contextualSkipped).toBe(1);
  });

  it('should skip a block introduced by the preceding line as wrong', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '❌ Wrong:',
        '',
        '```typescript',
        "import { Nope } from 'blendsdk/widget';",
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.counterExamplesSkipped).toBe(1);
  });

  it('should skip a block whose first comment marks it not exported', () => {
    writeReference(
      workspace,
      'references/packages/widget/usage.md',
      [
        '# Example',
        '',
        '```typescript fragment',
        '// not exported from the package root:',
        "import { Nope } from 'blendsdk/widget';",
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.counterExamplesSkipped).toBe(1);
  });

  it('should report a missing filter path', () => {
    const report = validateExamples(workspace.rootDir, { filter: 'references/does-not-exist.md' });

    expect(report.ok).toBe(false);
    expect(report.details[0].tier).toBe('filter');
  });

  it('should serialize a structured report for tooling', () => {
    writeReference(
      workspace,
      'references/packages/widget/bad.md',
      [
        '# Bad',
        '',
        '```typescript fragment',
        "import { Nope } from 'blendsdk/widget';",
        '```',
        '',
      ].join('\n')
    );

    const report = validateExamples(workspace.rootDir);
    const parsed: unknown = JSON.parse(formatValidationReport(report));

    expect(parsed).toMatchObject({ ok: false, problemCount: 1 });
    const record = parsed as { problems: Array<{ file: string; tier: string }> };
    expect(record.problems[0].tier).toBe('1b');
    expect(record.problems[0].file.endsWith('bad.md')).toBe(true);
  });

  it('should format problems with and without a line number', () => {
    expect(formatProblem({ file: 'a.md', line: 3, tier: '1a', message: 'bad specifier' })).toBe(
      'a.md:3: bad specifier'
    );
    expect(formatProblem({ file: '', tier: 'build', message: 'build me' })).toBe('build me');
  });
});
