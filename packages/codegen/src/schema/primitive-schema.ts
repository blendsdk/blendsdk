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
