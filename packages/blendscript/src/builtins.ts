import { MAX_STRING_LENGTH } from './limits.js';
import { parseFiniteDecimal } from './number-parsing.js';
import type { ExpressionFieldType, ExpressionValue, ExpressionValueType } from './types.js';

/** Static signature shared by analysis and the v1 evaluator. */
export interface BuiltinDefinition {
  /** Canonical lowercase name used by the parser and evaluator. */
  readonly name: string;
  /** Static parameter types checked left-to-right by the analyzer. */
  readonly parameters: readonly ExpressionFieldType[];
  /** Concrete result type returned after successful evaluation. */
  readonly resultType: Exclude<ExpressionValueType, 'null'>;
  /** Whether successful evaluation can return null. */
  readonly resultNullable: boolean;
  /** Whether a null argument is handled by the built-in instead of rejected. */
  readonly acceptsRuntimeNull: boolean;
}

const definitions = [
  {
    name: 'isempty',
    parameters: ['string'],
    resultType: 'boolean',
    resultNullable: false,
    acceptsRuntimeNull: true,
  },
  {
    name: 'isblank',
    parameters: ['string'],
    resultType: 'boolean',
    resultNullable: false,
    acceptsRuntimeNull: true,
  },
  {
    name: 'contains',
    parameters: ['string', 'string'],
    resultType: 'boolean',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'startswith',
    parameters: ['string', 'string'],
    resultType: 'boolean',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'endswith',
    parameters: ['string', 'string'],
    resultType: 'boolean',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'equalsignorecase',
    parameters: ['string', 'string'],
    resultType: 'boolean',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'trim',
    parameters: ['string'],
    resultType: 'string',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'lower',
    parameters: ['string'],
    resultType: 'string',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'upper',
    parameters: ['string'],
    resultType: 'string',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'length',
    parameters: ['string'],
    resultType: 'number',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
  {
    name: 'trynumber',
    parameters: ['scalar'],
    resultType: 'number',
    resultNullable: true,
    acceptsRuntimeNull: true,
  },
  {
    name: 'text',
    parameters: ['scalar'],
    resultType: 'string',
    resultNullable: false,
    acceptsRuntimeNull: false,
  },
] as const satisfies readonly BuiltinDefinition[];

/** The closed v1 built-in table. There is intentionally no registration API. */
export const BUILTINS: ReadonlyMap<string, BuiltinDefinition> = new Map(
  definitions.map(definition => [definition.name, Object.freeze(definition)])
);

/** Returns whether an authored name is one of the fixed case-insensitive built-ins. */
export function isBuiltinName(name: string): boolean {
  return BUILTINS.has(name.toLowerCase());
}

/** Looks up one canonical lowercase built-in name. */
export function getBuiltin(name: string): BuiltinDefinition | undefined {
  return BUILTINS.get(name.toLowerCase());
}

/** Runtime hooks that keep work and failures owned by the active call node. */
export interface BuiltinRuntimeContext {
  readonly charge: (amount: number) => void;
  readonly failNull: () => never;
  readonly failStringLimit: () => never;
}

function requiredString(value: ExpressionValue, context: BuiltinRuntimeContext): string {
  if (value === null) return context.failNull();
  if (typeof value !== 'string')
    throw new Error('Analyzer allowed a non-string built-in argument.');
  return value;
}

function requiredScalar(value: ExpressionValue, context: BuiltinRuntimeContext): string | number {
  if (value === null) return context.failNull();
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('Analyzer allowed a non-scalar built-in argument.');
  }
  return value;
}

function checkedDerived(value: string, context: BuiltinRuntimeContext): string {
  if (value.length > MAX_STRING_LENGTH) return context.failStringLimit();
  return value;
}

/** Evaluates one fixed built-in after its arguments have been visited left-to-right. */
export function evaluateBuiltin(
  name: string,
  argumentsList: readonly ExpressionValue[],
  context: BuiltinRuntimeContext
): ExpressionValue {
  if (name === 'trynumber') {
    const value = argumentsList[0];
    if (value === null) return null;
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') {
      throw new Error('Analyzer allowed a non-scalar tryNumber argument.');
    }
    context.charge(value.length);
    return parseFiniteDecimal(value);
  }
  if (name === 'text') {
    const value = requiredScalar(argumentsList[0] ?? null, context);
    const result = typeof value === 'string' ? value : String(value);
    context.charge(result.length);
    return checkedDerived(result, context);
  }
  if (name === 'isempty') {
    const value = argumentsList[0];
    return value === null || value === '';
  }
  if (name === 'isblank') {
    const value = argumentsList[0];
    if (value === null) return true;
    const text = requiredString(value, context);
    context.charge(text.length);
    return text.trim().length === 0;
  }
  if (name === 'contains' || name === 'startswith' || name === 'endswith') {
    const value = requiredString(argumentsList[0] ?? null, context);
    const search = requiredString(argumentsList[1] ?? null, context);
    context.charge(value.length + search.length);
    if (name === 'contains') return value.includes(search);
    if (name === 'startswith') return value.startsWith(search);
    return value.endsWith(search);
  }
  if (name === 'equalsignorecase') {
    const left = requiredString(argumentsList[0] ?? null, context);
    const right = requiredString(argumentsList[1] ?? null, context);
    context.charge(left.length + right.length + Math.max(left.length, right.length));
    const loweredLeft = checkedDerived(left.toLowerCase(), context);
    const loweredRight = checkedDerived(right.toLowerCase(), context);
    return loweredLeft === loweredRight;
  }
  const value = requiredString(argumentsList[0] ?? null, context);
  context.charge(value.length);
  if (name === 'trim') return checkedDerived(value.trim(), context);
  if (name === 'lower') return checkedDerived(value.toLowerCase(), context);
  if (name === 'upper') return checkedDerived(value.toUpperCase(), context);
  if (name === 'length') {
    let count = 0;
    for (const _codePoint of value) count += 1;
    return count;
  }
  throw new Error(`Parser produced unsupported built-in ${name}.`);
}
