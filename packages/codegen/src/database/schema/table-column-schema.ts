import { ColumnSchema } from './column-schema.js';
import { TableSchema } from './table-schema.js';
import { ColumnType, ReferentialAction } from './types.js';

export class TableColumnSchema extends ColumnSchema<TableSchema> {
  protected _type: ColumnType | undefined;
  protected _nullable: boolean | undefined;
  protected _default: string | boolean | number | undefined;
  protected _size: number | undefined;
  protected _scale: number | undefined;
  protected _generatedExpression: string | undefined;
  protected _generatedStored: boolean = true;
  protected _identityGeneration: 'ALWAYS' | 'BY DEFAULT' | undefined;
  protected _identityOptions:
    | {
        start?: number;
        increment?: number;
        minValue?: number;
        maxValue?: number;
        cache?: number;
        cycle?: boolean;
      }
    | undefined;

  references(
    toTable: TableSchema,
    column: string,
    onUpdate?: ReferentialAction,
    onDelete?: ReferentialAction
  ) {
    const fKey = this.relation.foreignKeyConstraint(toTable);
    fKey.from(this.getName());
    fKey.to(column).onUpdate(onUpdate).onDelete(onDelete);
    return this;
  }

  scale(value: number) {
    this._scale = value;
  }

  size(value: number) {
    this._size = value;
  }

  unique() {
    const uc = this.relation.uniqueConstraint();
    uc.column(this.getName());
    return this;
  }

  check(rule: string) {
    this.relation.checkConstraint(rule);
    return this;
  }

  primaryKey() {
    this.relation.primaryKey().column(this.name);
    this.unique();
    this._nullable = false;
    return this;
  }

  default(value: string | boolean | number | undefined, quote?: boolean) {
    this._default = quote ? `'${value}'` : value;
    return this;
  }

  nullable() {
    this._nullable = true;
    return this;
  }

  type(type: ColumnType) {
    this._type = type;
    return this;
  }

  getDefault() {
    return this._default;
  }

  getNullable() {
    return this._nullable === true;
  }

  getType() {
    return this._type;
  }

  getSize() {
    return this._size;
  }

  getScale() {
    return this._scale;
  }

  generated(expression: string, stored: 'STORED' | 'VIRTUAL' = 'STORED') {
    if (stored === 'VIRTUAL') {
      throw new Error('PostgreSQL only supports STORED generated columns');
    }
    this._generatedExpression = expression;
    this._generatedStored = true;
    this._default = undefined; // Generated columns cannot have default values
    return this;
  }

  getGeneratedExpression(): string | undefined {
    return this._generatedExpression;
  }

  isGenerated(): boolean {
    return this._generatedExpression !== undefined;
  }

  isGeneratedStored(): boolean {
    return this._generatedStored;
  }

  identity(
    generationOrFunction?: 'ALWAYS' | 'BY DEFAULT' | 'v4' | 'v7' | string,
    options?: {
      start?: number;
      increment?: number;
      minValue?: number;
      maxValue?: number;
      cache?: number;
      cycle?: boolean;
    }
  ) {
    // Special handling for UUID type
    if (this._type === 'uuid') {
      return this.handleUuidIdentity(generationOrFunction);
    }

    // Integer identity validation
    if (!['smallint', 'integer', 'bigint'].includes(this._type || '')) {
      throw new Error('IDENTITY columns must be integer or uuid types');
    }

    // Validate mutual exclusivity
    if (this._generatedExpression) {
      throw new Error('Column cannot be both IDENTITY and GENERATED');
    }

    // Set identity properties
    this._identityGeneration = (generationOrFunction as 'ALWAYS' | 'BY DEFAULT') || 'ALWAYS';
    this._identityOptions = options;
    this._default = undefined; // Identity columns cannot have DEFAULT

    return this;
  }

  protected handleUuidIdentity(generator?: string) {
    let uuidFunction: string;

    switch (generator) {
      case 'v4':
        uuidFunction = 'uuid_generate_v4()';
        this.relation.getDatabase().extension('uuid-ossp');
        break;

      case 'v7':
        uuidFunction = 'uuid_generate_v7()';
        this.relation.getDatabase().extension('pg_uuidv7');
        break;

      case undefined:
      case 'ALWAYS':
      case 'BY DEFAULT':
        // Default to gen_random_uuid() (built-in PostgreSQL 13+)
        uuidFunction = 'gen_random_uuid()';
        break;

      default:
        // Custom function provided
        uuidFunction = generator;
    }

    this._default = uuidFunction;
    return this;
  }

  getIdentityGeneration() {
    return this._identityGeneration;
  }

  getIdentityOptions() {
    return this._identityOptions;
  }

  isIdentity() {
    return this._identityGeneration !== undefined;
  }
}
