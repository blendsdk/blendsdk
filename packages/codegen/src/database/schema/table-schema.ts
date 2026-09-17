import { CheckConstraint } from './check-constraint.js';
import { DatabaseSchema } from './database-schema.js';
import { ForeignKeyConstraint } from './fkey-constraints.js';
import { IndexConstraint } from './index-constraint.js';
import { PrimaryKeyConstraint } from './primarykey-constraint.js';
import { RelationSchema } from './relation-schema.js';
import { TableColumnSchema } from './table-column-schema.js';
import { UniqueConstraint } from './unique-constraint.js';

export class TableSchema extends RelationSchema<TableColumnSchema> {
  protected _primaryKey: PrimaryKeyConstraint | undefined;
  protected _checkConstraints: CheckConstraint[];
  protected _uniqueConstraints: UniqueConstraint[];
  protected _foreignKeys: ForeignKeyConstraint[];
  protected _indexes: IndexConstraint[];

  constructor(name: string, database: DatabaseSchema) {
    super(name, database);
    this._checkConstraints = [];
    this._uniqueConstraints = [];
    this._foreignKeys = [];
    this._indexes = [];
  }

  foreignKeyConstraint(toTable: TableSchema) {
    const fKey = new ForeignKeyConstraint(this, toTable);
    this._foreignKeys.push(fKey);
    return fKey;
  }

  uniqueConstraint() {
    const uc = new UniqueConstraint(this);
    this._uniqueConstraints.push(uc);
    return uc;
  }

  checkConstraint(rule: string) {
    const check = new CheckConstraint(this, rule);
    this._checkConstraints.push(check);
    return this;
  }

  index() {
    const idx = new IndexConstraint(this);
    this._indexes.push(idx);
    return idx;
  }

  getForeignKeyConstrains() {
    return this._foreignKeys;
  }

  getCheckConstraints() {
    return this._checkConstraints;
  }

  getUniqueConstraints() {
    return this._uniqueConstraints;
  }

  getIndexes() {
    return this._indexes;
  }

  primaryKey() {
    if (!this._primaryKey) {
      this._primaryKey = new PrimaryKeyConstraint(this);
    }
    return this._primaryKey;
  }

  /**
   * Returns the configured primary key without creating one as a read side effect.
   *
   * Snapshot normalization uses this accessor so inspecting a schema never changes the public
   * authoring model.
   */
  getPrimaryKey(): PrimaryKeyConstraint | undefined {
    return this._primaryKey;
  }

  integer(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('integer');
    this.columns.push(col);
    return col;
  }

  varchar(name: string, size?: number) {
    const col = new TableColumnSchema(name, this);
    col.type('varchar');
    if (size !== undefined) {
      col.size(size);
    }
    this.columns.push(col);
    return col;
  }

  serial(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('serial');
    this.columns.push(col);
    return col;
  }

  bigserial(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('bigserial');
    this.columns.push(col);
    return col;
  }

  smallint(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('smallint');
    this.columns.push(col);
    return col;
  }

  bigint(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('bigint');
    this.columns.push(col);
    return col;
  }

  decimal(name: string, size?: number, scale?: number) {
    const col = new TableColumnSchema(name, this);
    col.type('decimal');
    if (size !== undefined) {
      col.size(size);
    }
    if (scale !== undefined) {
      col.scale(scale);
    }
    this.columns.push(col);
    return col;
  }

  numeric(name: string, size?: number, scale?: number) {
    const col = new TableColumnSchema(name, this);
    col.type('numeric');
    if (size !== undefined) {
      col.size(size);
    }
    if (scale !== undefined) {
      col.scale(scale);
    }
    this.columns.push(col);
    return col;
  }

  real(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('real');
    this.columns.push(col);
    return col;
  }

  doublePrecision(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('double precision');
    this.columns.push(col);
    return col;
  }

  char(name: string, size?: number) {
    const col = new TableColumnSchema(name, this);
    col.type('char');
    if (size !== undefined) {
      col.size(size);
    }
    this.columns.push(col);
    return col;
  }

  text(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('text');
    this.columns.push(col);
    return col;
  }

  boolean(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('boolean');
    this.columns.push(col);
    return col;
  }

  date(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('date');
    this.columns.push(col);
    return col;
  }

  time(name: string, size?: number) {
    const col = new TableColumnSchema(name, this);
    col.type('time');
    if (size !== undefined) {
      col.size(size);
    }
    this.columns.push(col);
    return col;
  }

  timestamp(name: string, size?: number) {
    const col = new TableColumnSchema(name, this);
    col.type('timestamp');
    if (size !== undefined) {
      col.size(size);
    }
    this.columns.push(col);
    return col;
  }

  timestamptz(name: string, size?: number) {
    const col = new TableColumnSchema(name, this);
    col.type('timestamptz');
    if (size !== undefined) {
      col.size(size);
    }
    this.columns.push(col);
    return col;
  }

  json(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('json');
    this.columns.push(col);
    return col;
  }

  jsonb(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('jsonb');
    this.columns.push(col);
    return col;
  }

  uuid(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('uuid');
    this.columns.push(col);
    return col;
  }

  vector(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('vector');
    this.columns.push(col);
    return col;
  }

  tsvector(name: string) {
    const col = new TableColumnSchema(name, this);
    col.type('tsvector');
    this.columns.push(col);
    return col;
  }
}
