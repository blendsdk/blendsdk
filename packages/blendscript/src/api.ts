import { analyze, type AnalysisSuccess } from './analyzer.js';
import { createCompiledExpression, getCompiledPayload } from './compiled-expression.js';
import { BlendScriptApiError } from './errors.js';
import { evaluatePayload } from './evaluator.js';
import { snapshotOptions } from './input-validation.js';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import type {
  CompilationResult,
  CompiledExpression,
  EvaluationResult,
  ExpressionOptions,
  ExpressionValue,
  SourceExpressionDiagnostic,
  ValidationResult,
} from './types.js';

type PipelineResult =
  | Readonly<{
      ok: true;
      analysis: AnalysisSuccess;
      schema: ReturnType<typeof snapshotOptions>['schema'];
    }>
  | Readonly<{ ok: false; diagnostics: readonly SourceExpressionDiagnostic[] }>;

function analyzeSource(source: unknown, options: unknown): PipelineResult {
  if (typeof source !== 'string') {
    throw new BlendScriptApiError('BS_INVALID_ARGUMENT', 'Expression source must be a string.');
  }
  const snapshot = snapshotOptions(options);
  const lexical = lex(source);
  if (!lexical.ok)
    return Object.freeze({ ok: false, diagnostics: Object.freeze([lexical.diagnostic]) });
  const parsed = parse(source, lexical.tokens);
  if (!parsed.ok)
    return Object.freeze({ ok: false, diagnostics: Object.freeze([parsed.diagnostic]) });
  const analysis = analyze(source, parsed.expression, snapshot.schema, snapshot.expectedResult);
  if (!analysis.ok) return analysis;
  return Object.freeze({ ok: true, analysis, schema: snapshot.schema });
}

/**
 * Checks source syntax and types against an explicit schema.
 *
 * @example
 * ```ts
 * validateExpression('Country == "NL"', {
 *   schema: { Country: { type: 'string' } },
 *   expectedResult: 'boolean',
 * });
 * ```
 */
export function validateExpression(source: string, options: ExpressionOptions): ValidationResult {
  const pipeline = analyzeSource(source, options);
  if (!pipeline.ok) return pipeline;
  return Object.freeze({
    ok: true,
    resultType: pipeline.analysis.resultType,
    referencedFields: pipeline.analysis.referencedFields,
  });
}

/**
 * Checks and compiles source into a fresh reusable opaque handle.
 *
 * @example
 * ```ts
 * const result = compileExpression('Enabled', {
 *   schema: { Enabled: { type: 'boolean' } },
 * });
 * ```
 */
export function compileExpression(source: string, options: ExpressionOptions): CompilationResult {
  const pipeline = analyzeSource(source, options);
  if (!pipeline.ok) return pipeline;
  const expression = createCompiledExpression({
    source,
    expression: pipeline.analysis.expression,
    resultType: pipeline.analysis.resultType,
    referencedFields: pipeline.analysis.referencedFields,
    schema: pipeline.schema,
  });
  return Object.freeze({
    ok: true,
    expression,
    resultType: pipeline.analysis.resultType,
    referencedFields: pipeline.analysis.referencedFields,
  });
}

/**
 * Evaluates a compiled expression against one complete schema-shaped record.
 *
 * @example
 * ```ts
 * const compilation = compileExpression('Enabled', {
 *   schema: { Enabled: { type: 'boolean' } },
 * });
 * if (compilation.ok) {
 *   evaluateExpression(compilation.expression, { Enabled: true });
 * }
 * ```
 */
export function evaluateExpression(
  expression: CompiledExpression,
  data: Readonly<Record<string, ExpressionValue>>
): EvaluationResult {
  return evaluatePayload(getCompiledPayload(expression), data);
}
