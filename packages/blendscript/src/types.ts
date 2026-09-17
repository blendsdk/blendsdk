/** A scalar value understood and returned by BlendScript. */
export type ExpressionValue = string | number | boolean | null;

/** The public name of a concrete BlendScript runtime value type. */
export type ExpressionValueType = 'string' | 'number' | 'boolean' | 'null';

/**
 * A non-null field type accepted in a schema declaration.
 *
 * `scalar` preserves either a string or a finite number. Expressions must use
 * `text(...)` or `tryNumber(...)` before applying concrete-type operations.
 */
export type ExpressionFieldType = Exclude<ExpressionValueType, 'null'> | 'scalar';

/** Describes one field that an expression may reference. */
export interface ExpressionFieldSchema {
  /** The primitive value, or string-or-finite-number scalar, required for this field. */
  readonly type: ExpressionFieldType;
  /** Whether the record may explicitly contain `null`. Defaults to `false`. */
  readonly nullable?: boolean;
}

/** Maps exact field names to their declared value shapes. */
export type ExpressionSchema = Readonly<Record<string, Readonly<ExpressionFieldSchema>>>;

/** Options shared by validation and compilation. */
export interface ExpressionOptions {
  /** The complete set of fields available to the expression. */
  readonly schema: ExpressionSchema;
  /** An optional exact result type required from the expression. */
  readonly expectedResult?: ExpressionValueType;
}

/** The scalar type and nullability inferred from an expression. */
export type InferredExpressionType =
  | Readonly<{ type: ExpressionFieldType; nullable: boolean }>
  | Readonly<{ type: 'null'; nullable: true }>;

/** A zero-based, half-open range in UTF-16 source code units. */
export interface SourceSpan {
  /** Inclusive start offset. */
  readonly start: number;
  /** Exclusive end offset. */
  readonly end: number;
}

/** One-based source coordinates derived from a source span. */
export interface SourceLocation {
  /** Line containing the start offset. */
  readonly line: number;
  /** UTF-16 column containing the start offset. */
  readonly column: number;
  /** Line containing the exclusive end offset. */
  readonly endLine: number;
  /** UTF-16 column containing the exclusive end offset. */
  readonly endColumn: number;
}

/** Stable machine-readable codes for expression and record diagnostics. */
export type ExpressionDiagnosticCode =
  | 'BS_SOURCE_TOO_LONG'
  | 'BS_TOKEN_LIMIT_EXCEEDED'
  | 'BS_STRING_LITERAL_TOO_LONG'
  | 'BS_FIELD_NAME_TOO_LONG'
  | 'BS_NESTING_LIMIT_EXCEEDED'
  | 'BS_INVALID_CHARACTER'
  | 'BS_INVALID_STRING'
  | 'BS_INVALID_NUMBER'
  | 'BS_UNEXPECTED_TOKEN'
  | 'BS_UNKNOWN_FIELD'
  | 'BS_TYPE_MISMATCH'
  | 'BS_INVALID_ARGUMENT_COUNT'
  | 'BS_EXPECTED_RESULT_TYPE_MISMATCH'
  | 'BS_MISSING_FIELD'
  | 'BS_RUNTIME_TYPE_MISMATCH'
  | 'BS_STRING_VALUE_LIMIT_EXCEEDED'
  | 'BS_NULL_NOT_ALLOWED'
  | 'BS_EVALUATION_STEP_LIMIT_EXCEEDED';

/** Diagnostic codes that identify a problem with one record field. */
export type RecordExpressionDiagnosticCode =
  'BS_MISSING_FIELD' | 'BS_RUNTIME_TYPE_MISMATCH' | 'BS_STRING_VALUE_LIMIT_EXCEEDED';

/** A source-authored failure with an exact location. */
export interface SourceExpressionDiagnostic {
  /** Identifies this as a source diagnostic. */
  readonly kind: 'source';
  /** Stable machine-readable failure code. */
  readonly code: Exclude<ExpressionDiagnosticCode, 'BS_MISSING_FIELD' | 'BS_RUNTIME_TYPE_MISMATCH'>;
  /** All v1 diagnostics are errors. */
  readonly severity: 'error';
  /** Concise guidance intended for the expression author. */
  readonly message: string;
  /** Exact zero-based half-open source range. */
  readonly span: SourceSpan;
  /** One-based line and UTF-16 column coordinates. */
  readonly location: SourceLocation;
  /** Optional source-only context, bounded to 120 UTF-16 code units. */
  readonly excerpt?: string;
}

/** A runtime record failure associated with one declared field. */
export interface RecordExpressionDiagnostic {
  /** Identifies this as a record diagnostic. */
  readonly kind: 'record';
  /** Stable machine-readable record failure code. */
  readonly code: RecordExpressionDiagnosticCode;
  /** All v1 diagnostics are errors. */
  readonly severity: 'error';
  /** Concise guidance that never includes the record value. */
  readonly message: string;
  /** Exact schema field whose record value failed validation. */
  readonly field: string;
}

/** A failure returned for authored source or runtime record data. */
export type ExpressionDiagnostic = SourceExpressionDiagnostic | RecordExpressionDiagnostic;

/** Stable machine-readable codes thrown for programmer misuse. */
export type BlendScriptApiErrorCode =
  | 'BS_INVALID_ARGUMENT'
  | 'BS_INVALID_SCHEMA'
  | 'BS_INVALID_OPTIONS'
  | 'BS_INVALID_COMPILED_EXPRESSION'
  | 'BS_SCHEMA_FIELD_LIMIT_EXCEEDED';

/** Internal runtime brand; it is intentionally not re-exported by the package entrypoint. */
export const compiledExpressionBrand: unique symbol = Symbol('BlendScriptCompiledExpression');

/**
 * An opaque, reusable expression returned by `compileExpression`.
 *
 * The value is valid only in the loaded package instance that created it. Keep
 * the original source when persistence is required and compile it after loading.
 */
export interface CompiledExpression {
  /** Declaration-only brand that prevents structural construction in TypeScript. */
  readonly [compiledExpressionBrand]: true;
}

/** The result of checking expression source without retaining executable state. */
export type ValidationResult =
  | Readonly<{
      ok: true;
      resultType: InferredExpressionType;
      referencedFields: readonly string[];
    }>
  | Readonly<{ ok: false; diagnostics: readonly SourceExpressionDiagnostic[] }>;

/** The result of checking and compiling expression source. */
export type CompilationResult =
  | Readonly<{
      ok: true;
      expression: CompiledExpression;
      resultType: InferredExpressionType;
      referencedFields: readonly string[];
    }>
  | Readonly<{ ok: false; diagnostics: readonly SourceExpressionDiagnostic[] }>;

/** The result of evaluating a compiled expression against one record. */
export type EvaluationResult =
  | Readonly<{ ok: true; value: ExpressionValue }>
  | Readonly<{ ok: false; diagnostic: ExpressionDiagnostic }>;
