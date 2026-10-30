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
  RecordDiagnosticReason,
  RecordExpressionDiagnostic,
  RecordExpressionDiagnosticCode,
  RuntimeValueType,
  SourceExpressionDiagnostic,
  SourceLocation,
  SourceSpan,
  ValidationResult,
} from './types.js';
