import type { ExpressionNode, LiteralNode } from './ast.js';
import { getBuiltin } from './builtins.js';
import { sourceDiagnostic } from './diagnostics.js';
import { MAX_SEMANTIC_DIAGNOSTICS } from './limits.js';
import type {
  ExpressionFieldType,
  ExpressionValueType,
  InferredExpressionType,
  SourceExpressionDiagnostic,
} from './types.js';

/** Immutable schema entry captured before source analysis. */
export interface SchemaEntry {
  readonly name: string;
  readonly type: ExpressionFieldType;
  readonly nullable: boolean;
  readonly index: number;
}

interface TypeInfo {
  readonly type: ExpressionFieldType | 'null';
  readonly nullable: boolean;
}

/** Successful source analysis retained by validation and compilation. */
export interface AnalysisSuccess {
  readonly ok: true;
  readonly expression: ExpressionNode;
  readonly resultType: InferredExpressionType;
  readonly referencedFields: readonly string[];
}

/** Static source analysis result. */
export type AnalysisResult =
  AnalysisSuccess | Readonly<{ ok: false; diagnostics: readonly SourceExpressionDiagnostic[] }>;

function literalType(node: LiteralNode): TypeInfo {
  if (node.value === null) return { type: 'null', nullable: true };
  if (typeof node.value === 'string') return { type: 'string', nullable: false };
  if (typeof node.value === 'number') return { type: 'number', nullable: false };
  return { type: 'boolean', nullable: false };
}

function isEqualityCompatible(left: TypeInfo, right: TypeInfo): boolean {
  if (left.type === right.type) return true;
  if (left.type === 'null') return right.nullable;
  if (right.type === 'null') return left.nullable;
  return false;
}

/** Adds an actionable conversion hint when a diagnostic involves a mixed scalar. */
function scalarConversionGuidance(...types: readonly TypeInfo[]): string {
  return types.some(type => type.type === 'scalar')
    ? ' Use text(...) or tryNumber(...) to convert scalar values explicitly.'
    : '';
}

/** Checks a built-in argument, including the two concrete forms accepted by scalar parameters. */
function isBuiltinArgumentCompatible(
  actual: TypeInfo,
  expected: ExpressionFieldType,
  acceptsRuntimeNull: boolean
): boolean {
  if (actual.type === 'null') return acceptsRuntimeNull;
  if (actual.type === expected) return true;
  return (
    expected === 'scalar' &&
    (actual.type === 'string' || actual.type === 'number' || actual.type === 'scalar')
  );
}

/** Resolves fields and verifies every v1 operator and built-in type rule. */
export function analyze(
  source: string,
  expression: ExpressionNode,
  schema: readonly SchemaEntry[],
  expectedResult?: ExpressionValueType
): AnalysisResult {
  const fields = new Map(schema.map(entry => [entry.name, entry]));
  const references: string[] = [];
  const seenReferences = new Set<string>();
  const diagnostics: SourceExpressionDiagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  let syntaxDiagnostic: SourceExpressionDiagnostic | undefined;
  const compareDiagnostics = (
    left: SourceExpressionDiagnostic,
    right: SourceExpressionDiagnostic
  ): number => {
    if (left.span.start !== right.span.start) return left.span.start - right.span.start;
    if (left.span.end !== right.span.end) return left.span.end - right.span.end;
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
  };

  const addDiagnostic = (
    code: SourceExpressionDiagnostic['code'],
    message: string,
    start: number,
    end: number
  ): void => {
    const key = `${code}:${start}:${end}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push(sourceDiagnostic(source, code, message, start, end));
    diagnostics.sort(compareDiagnostics);
    if (diagnostics.length > MAX_SEMANTIC_DIAGNOSTICS) diagnostics.pop();
  };

  const visit = (node: ExpressionNode): TypeInfo | undefined => {
    if (syntaxDiagnostic) return undefined;
    switch (node.kind) {
      case 'literal':
        return literalType(node);
      case 'field': {
        const field = fields.get(node.name);
        if (!field) {
          const builtin = getBuiltin(node.name);
          if (builtin && source[node.span.start] !== '[') {
            syntaxDiagnostic = sourceDiagnostic(
              source,
              'BS_UNEXPECTED_TOKEN',
              `Built-in ${node.name} must be called with parentheses.`,
              node.span.start,
              node.span.end
            );
          } else {
            addDiagnostic(
              'BS_UNKNOWN_FIELD',
              `Field ${JSON.stringify(node.name)} is not declared in the schema.`,
              node.span.start,
              node.span.end
            );
          }
          return undefined;
        }
        if (!seenReferences.has(field.name)) {
          seenReferences.add(field.name);
          references.push(field.name);
        }
        return { type: field.type, nullable: field.nullable };
      }
      case 'unary': {
        const operand = visit(node.operand);
        if (operand && operand.type !== 'boolean') {
          addDiagnostic(
            'BS_TYPE_MISMATCH',
            'NOT requires a Boolean expression.',
            node.span.start,
            node.span.end
          );
        }
        return operand ? { type: 'boolean', nullable: false } : undefined;
      }
      case 'binary': {
        const left = visit(node.left);
        const right = visit(node.right);
        if (!left || !right) return undefined;
        if (node.operator === 'and' || node.operator === 'or') {
          if (left.type !== 'boolean' || right.type !== 'boolean') {
            addDiagnostic(
              'BS_TYPE_MISMATCH',
              `${node.operator.toUpperCase()} requires Boolean operands.`,
              node.span.start,
              node.span.end
            );
          }
          return { type: 'boolean', nullable: false };
        }
        if (node.operator === 'equal' || node.operator === 'notEqual') {
          if (!isEqualityCompatible(left, right)) {
            addDiagnostic(
              'BS_TYPE_MISMATCH',
              `Equality operands must have compatible types.${scalarConversionGuidance(left, right)}`,
              node.span.start,
              node.span.end
            );
          }
          return { type: 'boolean', nullable: false };
        }
        if (left.type !== 'number' || right.type !== 'number') {
          addDiagnostic(
            'BS_TYPE_MISMATCH',
            `Ordering comparisons require numeric operands.${scalarConversionGuidance(left, right)}`,
            node.span.start,
            node.span.end
          );
        }
        return { type: 'boolean', nullable: false };
      }
      case 'membership': {
        const value = visit(node.value);
        const memberTypes = node.members.map(literalType);
        if (value) {
          for (let index = 0; index < memberTypes.length; index += 1) {
            const member = memberTypes[index];
            const memberNode = node.members[index];
            if (member && memberNode && !isEqualityCompatible(value, member)) {
              addDiagnostic(
                'BS_TYPE_MISMATCH',
                `IN members must have a type compatible with the left operand.${scalarConversionGuidance(value, member)}`,
                memberNode.span.start,
                memberNode.span.end
              );
            }
          }
        }
        return value ? { type: 'boolean', nullable: false } : undefined;
      }
      case 'call': {
        const definition = getBuiltin(node.name);
        if (!definition) throw new Error(`Parser produced unknown built-in ${node.name}.`);
        const argumentTypes = node.arguments.map(visit);
        if (node.arguments.length !== definition.parameters.length) {
          addDiagnostic(
            'BS_INVALID_ARGUMENT_COUNT',
            `${definition.name} expects ${definition.parameters.length} argument(s).`,
            node.span.start,
            node.span.end
          );
        } else {
          for (let index = 0; index < definition.parameters.length; index += 1) {
            const actual = argumentTypes[index];
            const expected = definition.parameters[index];
            const argument = node.arguments[index];
            if (
              actual &&
              expected &&
              argument &&
              !isBuiltinArgumentCompatible(actual, expected, definition.acceptsRuntimeNull)
            ) {
              addDiagnostic(
                'BS_TYPE_MISMATCH',
                `${definition.name} argument ${index + 1} must be ${expected}.${scalarConversionGuidance(actual)}`,
                argument.span.start,
                argument.span.end
              );
            }
          }
        }
        return { type: definition.resultType, nullable: definition.resultNullable };
      }
    }
  };

  const inferred = visit(expression);
  if (syntaxDiagnostic) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze([syntaxDiagnostic]) });
  }
  if (
    inferred &&
    expectedResult &&
    (inferred.type !== expectedResult || (inferred.nullable && inferred.type !== 'null'))
  ) {
    addDiagnostic(
      'BS_EXPECTED_RESULT_TYPE_MISMATCH',
      `Expression result must be a non-null ${expectedResult}.`,
      expression.span.start,
      expression.span.end
    );
  }
  if (diagnostics.length > 0) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  }
  if (!inferred) throw new Error('Analysis completed without an inferred type or diagnostic.');
  const resultType: InferredExpressionType = Object.freeze(
    inferred.type === 'null'
      ? { type: 'null', nullable: true }
      : { type: inferred.type, nullable: inferred.nullable }
  );
  return Object.freeze({
    ok: true,
    expression,
    resultType,
    referencedFields: Object.freeze(references),
  });
}
