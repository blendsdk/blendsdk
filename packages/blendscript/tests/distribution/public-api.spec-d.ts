import {
  BlendScriptApiError as DirectApiError,
  compileExpression as directCompile,
  evaluateExpression as directEvaluate,
  validateExpression as directValidate,
  type CompilationResult,
  type CompiledExpression,
  type EvaluationResult,
  type ExpressionFieldType,
  type ExpressionOptions,
  type RecordDiagnosticReason as DirectRecordDiagnosticReason,
  type RecordExpressionDiagnostic as DirectRecordExpressionDiagnostic,
  type RuntimeValueType as DirectRuntimeValueType,
  type ValidationResult,
} from '@blendsdk/blendscript';
import {
  BlendScriptApiError as UmbrellaApiError,
  compileExpression as umbrellaCompile,
  evaluateExpression as umbrellaEvaluate,
  validateExpression as umbrellaValidate,
  type CompilationResult as UmbrellaCompilationResult,
  type CompiledExpression as UmbrellaCompiledExpression,
  type EvaluationResult as UmbrellaEvaluationResult,
  type RecordDiagnosticReason as UmbrellaRecordDiagnosticReason,
  type RuntimeValueType as UmbrellaRuntimeValueType,
} from 'blendsdk/blendscript';

const options: ExpressionOptions = {
  schema: { Status: { type: 'string' } },
  expectedResult: 'boolean',
};

const scalarType: ExpressionFieldType = 'scalar';
const scalarOptions: ExpressionOptions = {
  schema: { Item: { type: scalarType } },
};
const scalarCompilation: CompilationResult = directCompile(
  'tryNumber(Item) != NULL AND tryNumber(Item) > 1',
  scalarOptions
);

const directValidation: ValidationResult = directValidate('Status == "active"', options);
const umbrellaValidation: ValidationResult = umbrellaValidate('Status == "active"', options);
const directCompilation: CompilationResult = directCompile('Status == "active"', options);
const umbrellaCompilation: UmbrellaCompilationResult = umbrellaCompile(
  'Status == "active"',
  options
);

declare const directCompiled: CompiledExpression;
declare const umbrellaCompiled: UmbrellaCompiledExpression;
const directEvaluation: EvaluationResult = directEvaluate(directCompiled, { Status: 'active' });
const umbrellaEvaluation: UmbrellaEvaluationResult = umbrellaEvaluate(umbrellaCompiled, {
  Status: 'active',
});

// Handles are deliberately owned by the loaded package instance that compiled them.
// @ts-expect-error A direct-package handle is not owned by the umbrella package instance.
umbrellaEvaluate(directCompiled, { Status: 'active' });

const directError: Error = new DirectApiError('BS_INVALID_ARGUMENT', 'Invalid argument.');
const umbrellaError: Error = new UmbrellaApiError('BS_INVALID_ARGUMENT', 'Invalid argument.');

// Record-diagnostic metadata types are part of both public entrypoints.
const directReason: DirectRecordDiagnosticReason = 'string-too-long';
const umbrellaReason: UmbrellaRecordDiagnosticReason = 'missing-field';
const directActualType: DirectRuntimeValueType = 'non-finite-number';
const umbrellaActualType: UmbrellaRuntimeValueType = 'accessor';

// A record diagnostic carries the four structured members with public types.
declare const directRecordDiagnostic: DirectRecordExpressionDiagnostic;
const structuredReason: DirectRecordDiagnosticReason = directRecordDiagnostic.reason;
const structuredExpectedType: ExpressionFieldType = directRecordDiagnostic.expectedType;
const structuredNullable: boolean = directRecordDiagnostic.nullable;
const structuredActualType: DirectRuntimeValueType = directRecordDiagnostic.actualType;
// @ts-expect-error Record diagnostic members are readonly.
directRecordDiagnostic.reason = 'missing-field';

void directValidation;
void umbrellaValidation;
void directCompilation;
void umbrellaCompilation;
void directEvaluation;
void umbrellaEvaluation;
void directError;
void umbrellaError;
void scalarCompilation;
void directReason;
void umbrellaReason;
void directActualType;
void umbrellaActualType;
void structuredReason;
void structuredExpectedType;
void structuredNullable;
void structuredActualType;

// Internal modules are intentionally unavailable through either package boundary.
// @ts-expect-error The direct package exposes only its root entrypoint.
type DirectInternalModule = typeof import('@blendsdk/blendscript/evaluator');
// @ts-expect-error The umbrella exposes only the public BlendScript entrypoint.
type UmbrellaInternalModule = typeof import('blendsdk/blendscript/evaluator');
