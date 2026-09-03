import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as direct from '../../dist/index.js';
import * as umbrella from '../../../blendsdk/dist/blendscript/index.js';
import type {
  CompilationResult,
  EvaluationResult,
  ExpressionOptions,
  ExpressionValue,
  InferredExpressionType,
  SourceExpressionDiagnostic,
  ValidationResult,
} from '../../dist/index.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const packageRoot = path.join(repositoryRoot, 'packages', 'blendscript');
const umbrellaRoot = path.join(repositoryRoot, 'packages', 'blendsdk');

interface RuntimeApi<TCompiled> {
  compileExpression(
    source: string,
    options: ExpressionOptions
  ):
    | Readonly<{
        ok: true;
        expression: TCompiled;
        resultType: InferredExpressionType;
        referencedFields: readonly string[];
      }>
    | Readonly<{ ok: false; diagnostics: readonly SourceExpressionDiagnostic[] }>;
  evaluateExpression(
    expression: TCompiled,
    data: Readonly<Record<string, ExpressionValue>>
  ): EvaluationResult;
  validateExpression(source: string, options: ExpressionOptions): ValidationResult;
}

interface PackFile {
  path: string;
}

interface PackReport {
  files: PackFile[];
}

function readJson(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected a JSON object in ${filePath}.`);
  }
  return value;
}

function readStringRecord(value: unknown, label: string): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  const result: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== 'string') throw new Error(`Expected ${label}.${key} to be a string.`);
    result[key] = member;
  }
  return result;
}

function readPackReport(output: string): PackReport {
  const reportStart = output.lastIndexOf('\n[\n  {');
  const json = reportStart === -1 ? output : output.slice(reportStart + 1);
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.length !== 1) throw new Error('Expected one npm pack report.');
  const report: unknown = value[0];
  if (typeof report !== 'object' || report === null || !('files' in report)) {
    throw new Error('Expected npm pack output to contain files.');
  }
  const files: unknown = report.files;
  if (!Array.isArray(files)) throw new Error('Expected npm pack files to be an array.');
  const normalized: PackFile[] = files.map(file => {
    if (typeof file !== 'object' || file === null || !('path' in file)) {
      throw new Error('Expected every npm pack file to have a path.');
    }
    if (typeof file.path !== 'string') throw new Error('Expected npm pack path to be a string.');
    return { path: file.path };
  });
  return { files: normalized };
}

function conformanceResults<TCompiled>(runtime: RuntimeApi<TCompiled>): readonly unknown[] {
  const schema = {
    Name: { type: 'string' },
    OptionalCode: { type: 'string', nullable: true },
    Item: { type: 'scalar' },
  } as const;
  const source = 'contains(trim(Name), "Blend") AND OptionalCode == NULL AND text(Item) == "001"';
  const validation = runtime.validateExpression(source, {
    schema,
    expectedResult: 'boolean',
  });
  const compilation = runtime.compileExpression(source, {
    schema,
    expectedResult: 'boolean',
  });
  if (!compilation.ok) throw new Error(`Expected compilation success.`);
  const evaluation = runtime.evaluateExpression(compilation.expression, {
    Name: '  BlendScript 😀  ',
    OptionalCode: null,
    Item: '001',
  });
  const nullFailure = runtime.compileExpression('trim(OptionalCode)', { schema });
  if (!nullFailure.ok) throw new Error('Expected nullable trim to compile.');
  const diagnostic = runtime.evaluateExpression(nullFailure.expression, {
    Name: 'BlendScript',
    OptionalCode: null,
    Item: 1,
  });
  const sourceLimit = runtime.validateExpression(' '.repeat(16_385), { schema: {} });
  const shortCircuit = runtime.compileExpression('TRUE OR equalsIgnoreCase(Name, Name)', {
    schema,
  });
  if (!shortCircuit.ok) throw new Error('Expected short-circuit expression to compile.');
  const shortCircuitResult = runtime.evaluateExpression(shortCircuit.expression, {
    Name: 'x'.repeat(4_096),
    OptionalCode: null,
    Item: 1,
  });
  const conversion = runtime.compileExpression('tryNumber(Item)', { schema });
  if (!conversion.ok) throw new Error('Expected scalar conversion to compile.');
  const conversionResult = runtime.evaluateExpression(conversion.expression, {
    Name: 'BlendScript',
    OptionalCode: null,
    Item: '001',
  });
  return [
    validation,
    compilation.resultType,
    compilation.referencedFields,
    evaluation,
    diagnostic,
    sourceLimit,
    shortCircuitResult,
    conversionResult,
  ];
}

describe('BlendScript built distribution', () => {
  it('should expose exactly the approved runtime namespace from direct and umbrella builds', () => {
    const expected = [
      'BlendScriptApiError',
      'compileExpression',
      'evaluateExpression',
      'validateExpression',
    ];
    expect(Object.keys(direct).sort()).toEqual(expected);
    expect(Object.keys(umbrella).sort()).toEqual(expected);
  });

  it('should preserve normalized behavior across direct and umbrella builds', () => {
    expect(conformanceResults(umbrella)).toEqual(conformanceResults(direct));
  });

  it('should remain executable when eval and Function are unavailable before import', () => {
    const directUrl = pathToFileURL(path.join(packageRoot, 'dist', 'index.js')).href;
    const umbrellaUrl = pathToFileURL(
      path.join(umbrellaRoot, 'dist', 'blendscript', 'index.js')
    ).href;
    const script = `
      globalThis.eval = undefined;
      globalThis.Function = undefined;
      for (const moduleUrl of [${JSON.stringify(directUrl)}, ${JSON.stringify(umbrellaUrl)}]) {
        const runtime = await import(moduleUrl);
        const compiled = runtime.compileExpression('trim(Name) == "BlendScript"', {
          schema: { Name: { type: 'string' } },
          expectedResult: 'boolean'
        });
        if (!compiled.ok) process.exit(2);
        const result = runtime.evaluateExpression(compiled.expression, { Name: ' BlendScript ' });
        if (!result.ok || result.value !== true) process.exit(3);
      }
    `;
    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '--eval', script], { stdio: 'pipe' })
    ).not.toThrow();
  });

  it('should keep versions, dependencies, discovery, and excluded infrastructure exact', () => {
    const root = readJson(path.join(repositoryRoot, 'package.json'));
    const blendScript = readJson(path.join(packageRoot, 'package.json'));
    const umbrellaManifest = readJson(path.join(umbrellaRoot, 'package.json'));
    const rootVersion = root.version;
    expect(blendScript.version).toBe(rootVersion);
    expect(umbrellaManifest.version).toBe(rootVersion);
    expect(blendScript.private).toBe(true);
    expect(blendScript.dependencies).toBeUndefined();
    const developmentDependencies = readStringRecord(
      umbrellaManifest.devDependencies,
      'umbrella devDependencies'
    );
    expect(developmentDependencies['@blendsdk/blendscript']).toBe(rootVersion);
    expect(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).toContain(
      '"packages/*"'
    );
    expect(readdirSync(packageRoot)).not.toEqual(
      expect.arrayContaining(['docker', 'postgresql', 'xlsx', 'google-apps-script'])
    );
  });

  it('should keep package references and the standalone course discoverable', () => {
    const requiredSources = [
      'README.md',
      '00-overview.md',
      '01-core-concepts.md',
      '02-basic-usage.md',
      '03-advanced-patterns.md',
      '04-best-practices.md',
      '05-common-scenarios.md',
      '06-testing-patterns.md',
      '07-troubleshooting.md',
      '08-api-reference.md',
      '09-examples-library.md',
    ];
    expect(readdirSync(path.join(packageRoot, 'ai-training')).sort()).toEqual(
      requiredSources.sort()
    );
    expect(
      readFileSync(path.join(repositoryRoot, 'scripts', 'techdocs', 'constants.ts'), 'utf8')
    ).toContain("{ name: 'blendscript'");
    expect(
      readFileSync(
        path.join(repositoryRoot, 'packages', 'blendsdk-mcp', 'scripts', 'generate-docs.ts'),
        'utf8'
      )
    ).toContain("'blendscript'");
    expect(
      readFileSync(
        path.join(
          repositoryRoot,
          'packages',
          'blendsdk-docs',
          'docs',
          'packages',
          'blendscript.md'
        ),
        'utf8'
      )
    ).toContain('BlendScript');
    expect(
      readFileSync(
        path.join(
          repositoryRoot,
          'packages',
          'blendsdk-mcp',
          'docs',
          '02-packages',
          'blendscript.md'
        ),
        'utf8'
      )
    ).toContain('BlendScript');
    const coursePath = '/guides/blendscript-v1';
    expect(
      readFileSync(
        path.join(
          repositoryRoot,
          'packages',
          'blendsdk-docs',
          'docs',
          'guides',
          'blendscript-v1.md'
        ),
        'utf8'
      )
    ).toContain('# BlendScript Course');
    expect(
      readFileSync(
        path.join(repositoryRoot, 'packages', 'blendsdk-docs', 'docs', 'guides', 'index.md'),
        'utf8'
      )
    ).toContain(coursePath);
    expect(
      readFileSync(
        path.join(repositoryRoot, 'packages', 'blendsdk-docs', 'docs', 'index.md'),
        'utf8'
      )
    ).toContain(coursePath);
  });

  it('should pack only the approved public BlendScript artifacts', () => {
    const report = readPackReport(
      execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: umbrellaRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    const paths = report.files.map(file => file.path).sort();
    expect(paths).toEqual(
      expect.arrayContaining([
        'README.md',
        'package.json',
        'dist/blendscript/index.d.ts',
        'dist/blendscript/index.js',
      ])
    );
    const blendScriptPaths = paths.filter(filePath => filePath.includes('blendscript'));
    expect(blendScriptPaths.every(filePath => filePath.startsWith('dist/blendscript/'))).toBe(true);
    expect(
      blendScriptPaths.every(filePath => /\.(?:js|js\.map|d\.ts|d\.ts\.map)$/.test(filePath))
    ).toBe(true);
    for (const filePath of blendScriptPaths.filter(candidate =>
      /\.(?:js|d\.ts)$/.test(candidate)
    )) {
      expect(readFileSync(path.join(umbrellaRoot, filePath), 'utf8')).not.toContain(
        '@blendsdk/blendscript'
      );
    }
  });
});
