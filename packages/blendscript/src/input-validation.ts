import type { SchemaEntry } from './analyzer.js';
import { recordDiagnostic } from './diagnostics.js';
import { BlendScriptApiError } from './errors.js';
import { MAX_FIELD_NAME_LENGTH, MAX_SCHEMA_FIELDS, MAX_STRING_LENGTH } from './limits.js';
import type {
  ExpressionFieldType,
  ExpressionValue,
  ExpressionValueType,
  RecordExpressionDiagnostic,
} from './types.js';

/** Immutable options snapshot used after the programmer-data boundary. */
export interface OptionsSnapshot {
  readonly schema: readonly SchemaEntry[];
  readonly expectedResult?: ExpressionValueType;
}

/** Result of copying all declared record values in captured schema order. */
export type RecordSnapshotResult =
  | Readonly<{ ok: true; values: readonly ExpressionValue[] }>
  | Readonly<{ ok: false; diagnostic: RecordExpressionDiagnostic }>;

function isOrdinaryObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(object: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
  return descriptor.value;
}

function throwOptions(message: string): never {
  throw new BlendScriptApiError('BS_INVALID_OPTIONS', message);
}

function throwSchema(message: string): never {
  throw new BlendScriptApiError('BS_INVALID_SCHEMA', message);
}

function isExpressionValueType(value: unknown): value is ExpressionValueType {
  return value === 'string' || value === 'number' || value === 'boolean' || value === 'null';
}

function validateFieldDescriptor(
  value: unknown,
  fieldName: string
): Readonly<{ type: ExpressionFieldType; nullable: boolean }> {
  if (!isOrdinaryObject(value))
    throwSchema(
      `Schema field ${JSON.stringify(fieldName)} must use an ordinary object descriptor.`
    );
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || (key !== 'type' && key !== 'nullable')) {
      throwSchema(
        `Schema field ${JSON.stringify(fieldName)} contains an unsupported descriptor member.`
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throwSchema(`Schema field ${JSON.stringify(fieldName)} cannot use accessor properties.`);
    }
  }
  if (!keys.includes('type'))
    throwSchema(`Schema field ${JSON.stringify(fieldName)} requires a type.`);
  const type = ownDataValue(value, 'type');
  if (type !== 'string' && type !== 'number' && type !== 'boolean' && type !== 'scalar') {
    throwSchema(
      `Schema field ${JSON.stringify(fieldName)} type must be string, number, boolean, or scalar.`
    );
  }
  const nullableValue = keys.includes('nullable') ? ownDataValue(value, 'nullable') : false;
  if (typeof nullableValue !== 'boolean') {
    throwSchema(
      `Schema field ${JSON.stringify(fieldName)} nullable must be Boolean when provided.`
    );
  }
  return Object.freeze({ type, nullable: nullableValue });
}

function validateSchema(value: unknown): readonly SchemaEntry[] {
  if (!isOrdinaryObject(value))
    throwSchema('Expression schema must be a caller-materialized ordinary object.');
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_SCHEMA_FIELDS) {
    throw new BlendScriptApiError(
      'BS_SCHEMA_FIELD_LIMIT_EXCEEDED',
      `Expression schema cannot contain more than ${MAX_SCHEMA_FIELDS} fields.`
    );
  }
  const entries: SchemaEntry[] = [];
  for (const key of keys) {
    if (typeof key !== 'string') throwSchema('Expression schema cannot contain symbol keys.');
    if (key.length === 0 || key.length > MAX_FIELD_NAME_LENGTH) {
      throwSchema(
        `Schema field names must contain 1 to ${MAX_FIELD_NAME_LENGTH} UTF-16 code units.`
      );
    }
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throwSchema(`Schema field ${JSON.stringify(key)} is reserved for safety.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throwSchema(`Schema field ${JSON.stringify(key)} cannot use an accessor property.`);
    }
    const field = validateFieldDescriptor(descriptor.value, key);
    entries.push(
      Object.freeze({
        name: key,
        type: field.type,
        nullable: field.nullable,
        index: entries.length,
      })
    );
  }
  return Object.freeze(entries);
}

/** Validates and snapshots options without invoking caller accessors. */
export function snapshotOptions(value: unknown): OptionsSnapshot {
  if (!isOrdinaryObject(value))
    throwOptions('Expression options must be a caller-materialized ordinary object.');
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key !== 'string' || (key !== 'schema' && key !== 'expectedResult')) {
      throwOptions('Expression options contain an unsupported member.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throwOptions('Expression options cannot use accessor properties.');
    }
  }
  if (!keys.includes('schema')) throwOptions('Expression options require an explicit schema.');
  const schema = validateSchema(ownDataValue(value, 'schema'));
  const hasExpectedResult = keys.includes('expectedResult');
  const expected = hasExpectedResult ? ownDataValue(value, 'expectedResult') : undefined;
  if (hasExpectedResult) {
    if (!isExpressionValueType(expected)) {
      throwOptions('expectedResult must be string, number, boolean, or null when provided.');
    }
    return Object.freeze({ schema, expectedResult: expected });
  }
  return Object.freeze({ schema });
}

/** Validates and snapshots declared record fields without reading undeclared extras. */
export function snapshotRecord(
  value: unknown,
  schema: readonly SchemaEntry[]
): RecordSnapshotResult {
  if (!isOrdinaryObject(value)) {
    throw new BlendScriptApiError(
      'BS_INVALID_ARGUMENT',
      'Evaluation data must be a caller-materialized ordinary object.'
    );
  }
  const values: ExpressionValue[] = [];
  for (const field of schema) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field.name);
    if (!descriptor) {
      return Object.freeze({
        ok: false,
        diagnostic: recordDiagnostic(
          'BS_MISSING_FIELD',
          `Record is missing required field ${JSON.stringify(field.name)}.`,
          field.name
        ),
      });
    }
    if (!Object.hasOwn(descriptor, 'value')) {
      return Object.freeze({
        ok: false,
        diagnostic: recordDiagnostic(
          'BS_RUNTIME_TYPE_MISMATCH',
          `Record field ${JSON.stringify(field.name)} must be an own data property.`,
          field.name
        ),
      });
    }
    const fieldValue: unknown = descriptor.value;
    if (fieldValue === null) {
      if (!field.nullable) {
        return Object.freeze({
          ok: false,
          diagnostic: recordDiagnostic(
            'BS_RUNTIME_TYPE_MISMATCH',
            `Record field ${JSON.stringify(field.name)} cannot be null.`,
            field.name
          ),
        });
      }
      values.push(null);
      continue;
    }
    const matchesType =
      (field.type === 'string' && typeof fieldValue === 'string') ||
      (field.type === 'number' && typeof fieldValue === 'number' && Number.isFinite(fieldValue)) ||
      (field.type === 'boolean' && typeof fieldValue === 'boolean') ||
      (field.type === 'scalar' &&
        (typeof fieldValue === 'string' ||
          (typeof fieldValue === 'number' && Number.isFinite(fieldValue))));
    if (!matchesType) {
      return Object.freeze({
        ok: false,
        diagnostic: recordDiagnostic(
          'BS_RUNTIME_TYPE_MISMATCH',
          `Record field ${JSON.stringify(field.name)} does not match its declared type.`,
          field.name
        ),
      });
    }
    if (typeof fieldValue === 'string' && fieldValue.length > MAX_STRING_LENGTH) {
      return Object.freeze({
        ok: false,
        diagnostic: recordDiagnostic(
          'BS_STRING_VALUE_LIMIT_EXCEEDED',
          `Record field ${JSON.stringify(field.name)} exceeds the string length limit.`,
          field.name
        ),
      });
    }
    if (
      typeof fieldValue === 'string' ||
      typeof fieldValue === 'number' ||
      typeof fieldValue === 'boolean'
    ) {
      values.push(fieldValue);
    } else {
      throw new Error(`Validated field ${field.name} has an impossible runtime type.`);
    }
  }
  return Object.freeze({ ok: true, values: Object.freeze(values) });
}
