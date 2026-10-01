import type { ExpressionNode } from './ast.js';
import { evaluateBuiltin } from './builtins.js';
import type { CompiledPayload } from './compiled-expression.js';
import { sourceDiagnostic } from './diagnostics.js';
import { snapshotRecord } from './input-validation.js';
import { MAX_EVALUATION_STEPS, MAX_STRING_LENGTH } from './limits.js';
import type {
  EvaluationResult,
  ExpressionDiagnostic,
  ExpressionValue,
  SourceExpressionDiagnostic,
  SourceSpan,
} from './types.js';

class EvaluationFailure extends Error {
  public constructor(public readonly diagnostic: ExpressionDiagnostic) {
    super(diagnostic.message);
  }
}

/** Interprets one immutable v1 AST against a validated record snapshot. */
export function evaluatePayload(payload: CompiledPayload, data: unknown): EvaluationResult {
  const record = snapshotRecord(data, payload.schema);
  if (!record.ok) return Object.freeze({ ok: false, diagnostic: record.diagnostic });
  const values = new Map<string, ExpressionValue>();
  for (const field of payload.schema) {
    const value = record.values[field.index];
    if (value === undefined) throw new Error(`Missing internal snapshot value for ${field.name}.`);
    values.set(field.name, value);
  }

  let steps = 0;
  const failSource = (
    code: SourceExpressionDiagnostic['code'],
    message: string,
    sourceSpan: SourceSpan
  ): never => {
    throw new EvaluationFailure(
      sourceDiagnostic(payload.source, code, message, sourceSpan.start, sourceSpan.end)
    );
  };
  const charge = (amount: number, sourceSpan: SourceSpan): void => {
    if (amount < 0 || steps > MAX_EVALUATION_STEPS - amount) {
      failSource(
        'BS_EVALUATION_STEP_LIMIT_EXCEEDED',
        `Evaluation cannot exceed ${MAX_EVALUATION_STEPS} deterministic work steps.`,
        sourceSpan
      );
    }
    steps += amount;
  };
  const requireNonNull = (
    value: ExpressionValue,
    node: ExpressionNode
  ): Exclude<ExpressionValue, null> => {
    if (value === null) {
      return failSource(
        'BS_NULL_NOT_ALLOWED',
        'This operation cannot use a null value.',
        node.span
      );
    }
    return value;
  };

  const visit = (node: ExpressionNode): ExpressionValue => {
    charge(1, node.span);
    switch (node.kind) {
      case 'literal':
        return node.value;
      case 'field': {
        if (!values.has(node.name))
          throw new Error(`Analyzed field ${node.name} has no runtime slot.`);
        const value = values.get(node.name);
        if (value === undefined)
          throw new Error(`Analyzed field ${node.name} has an invalid runtime value.`);
        return value;
      }
      case 'unary': {
        const operand = requireNonNull(visit(node.operand), node);
        if (typeof operand !== 'boolean')
          throw new Error('Analyzer allowed a non-Boolean NOT operand.');
        return !operand;
      }
      case 'binary': {
        const left = visit(node.left);
        if (node.operator === 'and' || node.operator === 'or') {
          const booleanLeft = requireNonNull(left, node);
          if (typeof booleanLeft !== 'boolean') {
            throw new Error('Analyzer allowed a non-Boolean logical operand.');
          }
          if (node.operator === 'and' && !booleanLeft) return false;
          if (node.operator === 'or' && booleanLeft) return true;
          const booleanRight = requireNonNull(visit(node.right), node);
          if (typeof booleanRight !== 'boolean') {
            throw new Error('Analyzer allowed a non-Boolean logical operand.');
          }
          return booleanRight;
        }
        const right = visit(node.right);
        if (node.operator === 'equal') return left === right;
        if (node.operator === 'notEqual') return left !== right;
        const numericLeft = requireNonNull(left, node);
        const numericRight = requireNonNull(right, node);
        if (typeof numericLeft !== 'number' || typeof numericRight !== 'number') {
          throw new Error('Analyzer allowed non-numeric ordering operands.');
        }
        if (node.operator === 'less') return numericLeft < numericRight;
        if (node.operator === 'lessEqual') return numericLeft <= numericRight;
        if (node.operator === 'greater') return numericLeft > numericRight;
        return numericLeft >= numericRight;
      }
      case 'membership': {
        const candidate = visit(node.value);
        for (const member of node.members) {
          if (candidate === visit(member)) return true;
        }
        return false;
      }
      case 'call': {
        const argumentsList = node.arguments.map(visit);
        return evaluateBuiltin(node.name, argumentsList, {
          charge: amount => charge(amount, node.span),
          failNull: () =>
            failSource(
              'BS_NULL_NOT_ALLOWED',
              `Built-in ${node.name} cannot use a null argument.`,
              node.span
            ),
          failStringLimit: () =>
            failSource(
              'BS_STRING_VALUE_LIMIT_EXCEEDED',
              `Built-in ${node.name} produced a string above the ${MAX_STRING_LENGTH} limit.`,
              node.span
            ),
        });
      }
    }
  };

  try {
    return Object.freeze({ ok: true, value: visit(payload.expression) });
  } catch (error) {
    if (error instanceof EvaluationFailure) {
      return Object.freeze({ ok: false, diagnostic: error.diagnostic });
    }
    throw error;
  }
}
