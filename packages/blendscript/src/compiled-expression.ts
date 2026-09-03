import type { SchemaEntry } from './analyzer.js';
import type { ExpressionNode } from './ast.js';
import { BlendScriptApiError } from './errors.js';
import {
  compiledExpressionBrand,
  type CompiledExpression,
  type InferredExpressionType,
} from './types.js';

/** Immutable internal state owned by one compiled handle. */
export interface CompiledPayload {
  readonly source: string;
  readonly expression: ExpressionNode;
  readonly resultType: InferredExpressionType;
  readonly referencedFields: readonly string[];
  readonly schema: readonly SchemaEntry[];
}

const payloads = new WeakMap<object, CompiledPayload>();

/** Creates a fresh frozen handle and registers its immutable payload. */
export function createCompiledExpression(payload: CompiledPayload): CompiledExpression {
  const expression: CompiledExpression = Object.freeze({
    [compiledExpressionBrand]: true as const,
  });
  payloads.set(expression, Object.freeze(payload));
  return expression;
}

/** Retrieves an owned payload or reports programmer misuse. */
export function getCompiledPayload(value: unknown): CompiledPayload {
  if (typeof value !== 'object' || value === null) {
    throw new BlendScriptApiError(
      'BS_INVALID_COMPILED_EXPRESSION',
      'Expected a compiled expression created by this package instance.'
    );
  }
  const payload = payloads.get(value);
  if (!payload) {
    throw new BlendScriptApiError(
      'BS_INVALID_COMPILED_EXPRESSION',
      'Expected a compiled expression created by this package instance.'
    );
  }
  return payload;
}
