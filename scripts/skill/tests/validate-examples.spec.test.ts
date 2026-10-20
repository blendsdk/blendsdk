/**
 * Specification tests for the skill example validator.
 *
 * The validator checks every TypeScript code block in the committed skill
 * against the SDK's public surface. It rejects imports from package specifiers
 * the umbrella package does not export, rejects named imports the target
 * package does not export, and type-checks the remaining blocks with the real
 * compiler. Blocks marked as a fragment are exempt from the type check but
 * their imports are still checked. The validator never executes the extracted
 * code and never builds a shell command from its content.
 *
 * Every test runs against a throwaway monorepo seeded from `tests/fixtures/`.
 * The real `.agents/skills/blendsdk` tree is never modified.
 *
 * @module skill/tests/validate-examples.spec
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateExamples } from '../validate-examples.js';
import { FIXTURE_SDK_VERSION, createFixtureWorkspace } from './helpers/fixture-workspace.js';

import type { FixtureWorkspace } from './helpers/fixture-workspace.js';

/** Reference path used by every fixture, relative to the skill directory. */
const REFERENCE_PATH = 'references/packages/widget/usage.md';

/** Source surface for the `widget` package, read by the symbol check. */
const WIDGET_SOURCE = [
  'export class Widget {',
  '  label = "";',
  '}',
  '',
  'export interface WidgetOptions {',
  '  label: string;',
  '}',
  '',
  'export async function makeWidget(): Promise<Widget> {',
  '  return new Widget();',
  '}',
  '',
  'export function* widgetStream(): Generator<Widget> {',
  '  yield new Widget();',
  '}',
  '',
  'export declare function widgetInfo(): string;',
  '',
  'export default async function widgetFactory(): Promise<Widget> {',
  '  return new Widget();',
  '}',
  '',
].join('\n');

/** Compiled declaration for the `widget` package, read by the compiler check. */
const WIDGET_DECLARATION = [
  'export declare class Widget {',
  '  label: string;',
  '}',
  '',
  'export interface WidgetOptions {',
  '  label: string;',
  '}',
  '',
].join('\n');

/**
 * Writes a minimal umbrella package, its dist output, and the `widget` source
 * package into a fixture workspace.
 *
 * @param rootDir - Absolute path to the fixture workspace root
 * @param withDist - When false, the compiled umbrella output is omitted to
 *   simulate running the validator before a build
 */
function writeUmbrella(rootDir: string, withDist: boolean): void {
  const umbrellaDir = path.join(rootDir, 'packages', 'blendsdk');
  fs.writeFileSync(
    path.join(umbrellaDir, 'package.json'),
    JSON.stringify(
      {
        name: 'blendsdk',
        version: FIXTURE_SDK_VERSION,
        exports: {
          './widget': {
            types: './dist/widget/index.d.ts',
            import: './dist/widget/index.js',
          },
        },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  const widgetSourceDir = path.join(rootDir, 'packages', 'widget', 'src');
  fs.mkdirSync(widgetSourceDir, { recursive: true });
  fs.writeFileSync(path.join(widgetSourceDir, 'index.ts'), WIDGET_SOURCE, 'utf-8');

  if (!withDist) {
    return;
  }

  const widgetDistDir = path.join(umbrellaDir, 'dist', 'widget');
  fs.mkdirSync(widgetDistDir, { recursive: true });
  fs.writeFileSync(path.join(widgetDistDir, 'index.d.ts'), WIDGET_DECLARATION, 'utf-8');
  fs.writeFileSync(path.join(widgetDistDir, 'index.js'), '', 'utf-8');
}

/**
 * Writes one markdown reference into a fixture workspace's skill tree.
 *
 * @param workspace - Fixture workspace to write into
 * @param content - Markdown content of the reference
 * @param relativePath - Reference path relative to the skill directory
 */
function writeReference(
  workspace: FixtureWorkspace,
  content: string,
  relativePath = REFERENCE_PATH
): void {
  const referencePath = path.join(workspace.skillDir, relativePath);
  fs.mkdirSync(path.dirname(referencePath), { recursive: true });
  fs.writeFileSync(referencePath, content, 'utf-8');
}

/**
 * Wraps TypeScript code in a fenced block with a header line above it.
 *
 * The code always starts on line 4, so tests can assert on a stable line
 * number when the validator reports a problem.
 *
 * @param code - Lines of TypeScript to place in the block
 * @param infoString - Fence info string, such as `ts` or `typescript fragment`
 * @returns Markdown reference content
 */
function fencedBlock(code: string[], infoString = 'ts'): string {
  return ['# Widget usage', '', '```' + infoString, ...code, '```', ''].join('\n');
}

describe('Skill example validator', () => {
  let workspace: FixtureWorkspace;

  beforeEach(() => {
    workspace = createFixtureWorkspace();
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('should reject an import from a package the umbrella does not export', () => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock([
        "import { Widget } from 'blendsdk/not-a-package';",
        '',
        'const widget = new Widget();',
      ])
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(
      report.problems.some(problem =>
        problem.includes("unknown package specifier 'blendsdk/not-a-package'")
      )
    ).toBe(true);
    expect(report.problems.some(problem => problem.includes('usage.md:4:'))).toBe(true);
  });

  it('should reject a named import the target package does not export', () => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock(["import { Nope } from 'blendsdk/widget';", '', 'const value = new Nope();'])
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(
      report.problems.some(
        problem => problem.includes("unknown symbol 'Nope'") && problem.includes('blendsdk/widget')
      )
    ).toBe(true);
    expect(report.problems.some(problem => problem.includes('usage.md:4:'))).toBe(true);
  });

  it.each([
    ['async function', 'makeWidget'],
    ['generator function', 'widgetStream'],
    ['declared function', 'widgetInfo'],
    ['default async function', 'widgetFactory'],
  ])('should accept a named import of the %s export', (_form, name) => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock([`import { ${name} } from 'blendsdk/widget';`], 'typescript fragment')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('should report compiler diagnostics for a block that does not type-check', () => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock([
        "import { Widget } from 'blendsdk/widget';",
        '',
        "const label: number = 'not a number';",
        '',
        'const widget = new Widget();',
      ])
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(
      report.problems.some(problem => /error TS\d+/.test(problem) && problem.includes('usage.md'))
    ).toBe(true);
  });

  it('should skip the type check for a fragment but still accept its imports', () => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock(
        ["import { Widget } from 'blendsdk/widget';", '', "const label: number = 'not a number';"],
        'typescript fragment'
      )
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('should still reject unknown imports inside a fragment', () => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock(["import { Nope } from 'blendsdk/widget';"], 'typescript fragment')
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(report.problems.some(problem => problem.includes("unknown symbol 'Nope'"))).toBe(true);
  });

  it('should compile a JSX block as a component file instead of rejecting it', () => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock([
        "import { Widget } from 'blendsdk/widget';",
        '',
        'export const element = <Widget label="hello" />;',
      ])
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('should not compile API signature listings in api.md', () => {
    writeUmbrella(workspace.rootDir, true);
    writeReference(
      workspace,
      fencedBlock(['constructor(config?: WidgetOptions)', '', 'readonly label: string;']),
      'references/packages/widget/api.md'
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('should fail with the build-first instruction when the umbrella is not built', () => {
    writeUmbrella(workspace.rootDir, false);
    writeReference(
      workspace,
      fencedBlock(["import { Widget } from 'blendsdk/widget';", '', 'const widget = new Widget();'])
    );

    const report = validateExamples(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(
      report.problems.some(problem => problem.includes('npx turbo run build --filter=blendsdk'))
    ).toBe(true);
  });

  it('should never execute extracted code or build a shell command from it', () => {
    const sourcePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'validate-examples.ts'
    );
    const source = fs.readFileSync(sourcePath, 'utf-8');

    expect(source).not.toMatch(/\bexecSync\s*\(/);
    expect(source).not.toMatch(/(?<![.\w])exec\s*\(/);
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function\s*\(/);
  });
});
