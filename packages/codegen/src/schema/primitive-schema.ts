import { SchemaContainer } from './schema-container.js';
import { SchemaObject } from './schema-object.js';

export abstract class PrimitiveSchema extends SchemaObject {
  constructor(container: SchemaContainer) {
    super(container);
    this.setData({ primitive: true });
  }

  protected abstract enumValue(value: any): string;

  enum(values: string[] | number[]) {
    this._data.tsType = ['(', values.map(v => this.enumValue(v)).join(' | '), ')'].join(' ');
    return this;
  }
}

/** Rejects a length bound that is not a non-negative integer. */
function assertLengthBound(value: number, label: 'minLength' | 'maxLength') {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

export class StringSchema extends PrimitiveSchema {
  protected enumValue(value: any) {
    return `'${value}'`;
  }
  constructor(container: SchemaContainer) {
    super(container);
    this.setData({
      tsType: 'string',
      zodType: 'string',
    });
  }

  /**
   * Attaches a regular-expression constraint to the string.
   *
   * The source string is stored, so generated output is deterministic. A `RegExp` may be
   * supplied without flags; flagged expressions are rejected because flags cannot be represented
   * in the schema model or the OpenAPI output.
   *
   * @param value - Regular-expression source or an unflagged `RegExp` whose `source` is used
   * @returns This schema for chaining
   * @throws {Error} When the pattern is empty, is not a valid regular expression, or a `RegExp`
   * carries flags
   * @memberof StringSchema
   */
  pattern(value: string | RegExp) {
    if (typeof value !== 'string' && value.flags !== '') {
      throw new Error(
        'RegExp flags are not supported; pass an unflagged RegExp or a source string.'
      );
    }
    const source = typeof value === 'string' ? value : value.source;
    if (source.length === 0) {
      throw new Error('String pattern must not be empty.');
    }
    try {
      new RegExp(source);
    } catch {
      throw new Error(
        `Invalid pattern for schema ${this.getNamedScoped() || '(unnamed)'}: ${source}`
      );
    }
    this.setData({ pattern: source });
    return this;
  }

  /**
   * Sets the minimum accepted string length.
   *
   * @param value - Non-negative integer length
   * @returns This schema for chaining
   * @throws {Error} When the value is not a non-negative integer or exceeds an existing maximum
   * @memberof StringSchema
   */
  minLength(value: number) {
    assertLengthBound(value, 'minLength');
    const maximum = this.getData().maxLength;
    if (maximum !== undefined && value > maximum) {
      throw new Error(`minLength ${value} must not exceed maxLength ${maximum}.`);
    }
    this.setData({ minLength: value });
    return this;
  }

  /**
   * Sets the maximum accepted string length.
   *
   * @param value - Non-negative integer length
   * @returns This schema for chaining
   * @throws {Error} When the value is not a non-negative integer or is below an existing minimum
   * @memberof StringSchema
   */
  maxLength(value: number) {
    assertLengthBound(value, 'maxLength');
    const minimum = this.getData().minLength;
    if (minimum !== undefined && value < minimum) {
      throw new Error(`maxLength ${value} must not be below minLength ${minimum}.`);
    }
    this.setData({ maxLength: value });
    return this;
  }
}

export class NumberSchema extends PrimitiveSchema {
  protected enumValue(value: any) {
    return value;
  }
  constructor(container: SchemaContainer) {
    super(container);
    this.setData({
      tsType: 'number',
      zodType: 'number',
    });
  }
}

/**
 * Schema object for PostgreSQL `bytea` values.
 *
 * `pg` returns a Node `Buffer`, so the generated TypeScript uses `Buffer` and the generated Zod
 * expression checks the runtime type with `z.instanceof(Buffer)`. Consumers that need a different
 * binary representation can override the column through a `ColumnMapper`.
 */
export class BinarySchema extends PrimitiveSchema {
  protected enumValue(value: any) {
    return value;
  }

  constructor(container: SchemaContainer) {
    super(container);
    this.setData({
      tsType: 'Buffer',
      zodType: 'any',
      zodExpression: 'z.instanceof(Buffer)',
    });
  }
}

export class BigIntSchema extends PrimitiveSchema {
  protected enumValue(value: any) {
    return value;
  }

  constructor(container: SchemaContainer) {
    super(container);
    this.setData({
      tsType: 'BigInt',
      zodType: 'number',
    });
  }
}
