import { describe, expect, it } from 'vitest';

import {
  BlendScriptApiError,
  compileExpression,
  evaluateExpression,
  validateExpression,
} from '../../src/index.js';

function expectApiError(action: () => unknown, code: string): void {
  expect(action).toThrowError(BlendScriptApiError);
  try {
    action();
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

const schemaApis = [validateExpression, compileExpression] as const;

describe('BlendScript programmer-owned input boundary', () => {
  it.each(['__proto__', 'prototype', 'constructor'])(
    'should reject dangerous schema key %s',
    key => {
      const schema = Object.create(null) as Record<string, object>;
      Object.defineProperty(schema, key, {
        value: { type: 'string' },
        enumerable: true,
        configurable: true,
      });

      for (const api of schemaApis) {
        expectApiError(() => api('TRUE', { schema }), 'BS_INVALID_SCHEMA');
      }
    }
  );

  it('should reject non-string source and invalid option containers', () => {
    for (const api of schemaApis) {
      expectApiError(() => api(1 as never, { schema: {} }), 'BS_INVALID_ARGUMENT');
      for (const options of [
        null,
        [],
        {},
        { schema: {}, unknown: true },
        Object.create({ schema: {} }),
      ]) {
        expectApiError(() => api('TRUE', options as never), 'BS_INVALID_OPTIONS');
      }
      for (const expectedResult of ['date', 'scalar', 1, null, undefined]) {
        expectApiError(
          () => api('TRUE', { schema: {}, expectedResult } as never),
          'BS_INVALID_OPTIONS'
        );
      }
    }
  });

  it('should reject hostile schema maps without invoking schema accessors', () => {
    for (const schema of [[], new (class Schema {})(), Object.create({ A: { type: 'string' } })]) {
      for (const api of schemaApis) {
        expectApiError(() => api('TRUE', { schema } as never), 'BS_INVALID_SCHEMA');
      }
    }

    let getterRuns = 0;
    const accessorSchema = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorSchema, 'A', {
      get() {
        getterRuns += 1;
        return { type: 'string' };
      },
      enumerable: true,
    });
    const symbolSchema = Object.create(null) as Record<PropertyKey, unknown>;
    symbolSchema[Symbol('A')] = { type: 'string' };
    for (const schema of [accessorSchema, symbolSchema]) {
      for (const api of schemaApis) {
        expectApiError(() => api('TRUE', { schema } as never), 'BS_INVALID_SCHEMA');
      }
    }
    expect(getterRuns).toBe(0);
  });

  it('should reject inherited, accessor, symbol, and class-based programmer data without invoking getters', () => {
    let getterRuns = 0;
    const options = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(options, 'schema', {
      get() {
        getterRuns += 1;
        return {};
      },
      enumerable: true,
    });
    expectApiError(() => validateExpression('TRUE', options as never), 'BS_INVALID_OPTIONS');
    expect(getterRuns).toBe(0);

    const symbolic = { schema: {} } as Record<PropertyKey, unknown>;
    symbolic[Symbol('extra')] = true;
    expectApiError(() => validateExpression('TRUE', symbolic as never), 'BS_INVALID_OPTIONS');

    class Options {
      public schema = {};
    }
    expectApiError(() => validateExpression('TRUE', new Options() as never), 'BS_INVALID_OPTIONS');
  });

  it('should validate every schema descriptor through own data properties', () => {
    expectApiError(
      () => validateExpression('TRUE', { schema: { A: {} as never } }),
      'BS_INVALID_SCHEMA'
    );

    let getterRuns = 0;
    const accessorDescriptor = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(accessorDescriptor, 'type', {
      get() {
        getterRuns += 1;
        return 'string';
      },
      enumerable: true,
    });
    const unknownDescriptor = { type: 'string', extra: true };
    const symbolDescriptor = { type: 'string' } as Record<PropertyKey, unknown>;
    symbolDescriptor[Symbol('extra')] = true;
    const hostileDescriptors = [
      [],
      new (class Descriptor {
        public type = 'string';
      })(),
      Object.create({ type: 'string' }),
      accessorDescriptor,
      unknownDescriptor,
      symbolDescriptor,
    ];
    for (const descriptor of hostileDescriptors) {
      for (const api of schemaApis) {
        expectApiError(
          () => api('TRUE', { schema: { A: descriptor } } as never),
          'BS_INVALID_SCHEMA'
        );
      }
    }
    expect(getterRuns).toBe(0);
    expectApiError(
      () => validateExpression('TRUE', { schema: { A: { type: 'date' } as never } }),
      'BS_INVALID_SCHEMA'
    );
    expectApiError(
      () =>
        validateExpression('TRUE', { schema: { A: { type: 'string', nullable: 'yes' } as never } }),
      'BS_INVALID_SCHEMA'
    );
  });

  it('should enforce schema key and field-count boundaries inclusively', () => {
    const key256 = 'A'.repeat(256);
    expect(
      validateExpression(`[${key256}] == "x"`, { schema: { [key256]: { type: 'string' } } })
    ).toMatchObject({
      ok: true,
    });
    expectApiError(
      () => validateExpression('TRUE', { schema: { ['A'.repeat(257)]: { type: 'string' } } }),
      'BS_INVALID_SCHEMA'
    );

    const schema1024 = Object.fromEntries(
      Array.from({ length: 1_024 }, (_, index) => [`F${index}`, { type: 'boolean' }])
    );
    expect(compileExpression('TRUE', { schema: schema1024 as never })).toMatchObject({ ok: true });

    const schema1025 = { ...schema1024, F1024: { type: 'boolean' } };
    expectApiError(
      () => compileExpression('TRUE', { schema: schema1025 as never }),
      'BS_SCHEMA_FIELD_LIMIT_EXCEEDED'
    );
  });
});

describe('BlendScript runtime record boundary', () => {
  const compilation = compileExpression('Name == "Blend"', {
    schema: { Name: { type: 'string' }, Unused: { type: 'boolean' } },
  });
  if (!compilation.ok) throw new Error('Test expression must compile.');

  it('should reject invalid record containers as programmer errors', () => {
    for (const data of [null, [], new (class RecordValue {})(), Object.create({ Name: 'Blend' })]) {
      expectApiError(
        () => evaluateExpression(compilation.expression, data as never),
        'BS_INVALID_ARGUMENT'
      );
    }
  });

  it('should reject a declared accessor without invoking it', () => {
    let getterRuns = 0;
    const data = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(data, 'Name', {
      get() {
        getterRuns += 1;
        return 'Blend';
      },
      enumerable: true,
    });
    Object.defineProperty(data, 'Unused', { value: true, enumerable: true });
    expect(evaluateExpression(compilation.expression, data as never)).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_RUNTIME_TYPE_MISMATCH', field: 'Name' },
    });
    expect(getterRuns).toBe(0);
  });

  it('should require own declared fields and preserve captured schema order', () => {
    expect(evaluateExpression(compilation.expression, {})).toMatchObject({
      ok: false,
      diagnostic: { code: 'BS_MISSING_FIELD', field: 'Name' },
    });
  });

  it('should ignore undeclared extras without reading them and never mutate records', () => {
    let getterRuns = 0;
    const data = { Name: 'Blend', Unused: true } as Record<PropertyKey, unknown>;
    Object.defineProperty(data, 'Extra', {
      get() {
        getterRuns += 1;
        return 'secret';
      },
      enumerable: true,
    });
    data[Symbol('extra')] = 'secret';
    Object.freeze(data);
    expect(evaluateExpression(compilation.expression, data as never)).toEqual({
      ok: true,
      value: true,
    });
    expect(getterRuns).toBe(0);
    expect(Object.isFrozen(data)).toBe(true);
  });
});
