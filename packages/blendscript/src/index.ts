export { compileExpression, evaluateExpression, validateExpression } from './api.js';
export { BlendScriptApiError } from './errors.js';

export type {
  BlendScriptApiErrorCode,
  CompilationResult,
  CompiledExpression,
  EvaluationResult,
  ExpressionDiagnostic,
  ExpressionDiagnosticCode,
  ExpressionFieldSchema,
  ExpressionFieldType,
  ExpressionOptions,
  ExpressionSchema,
  ExpressionValue,
  ExpressionValueType,
  InferredExpressionType,
  RecordExpressionDiagnostic,
  RecordExpressionDiagnosticCode,
  SourceExpressionDiagnostic,
  SourceLocation,
  SourceSpan,
  ValidationResult,
} from './types.js';
