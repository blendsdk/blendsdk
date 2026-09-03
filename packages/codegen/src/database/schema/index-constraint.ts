import { ConstraintBase } from './constraint-base.js';
import { TableSchema } from './table-schema.js';

export type IndexMethod =
  | 'btree' // Default, good for equality and range queries
  | 'hash' // Only equality comparisons
  | 'gist' // Generalized Search Tree (geometric, full-text)
  | 'gin' // Generalized Inverted Index (arrays, jsonb, full-text)
  | 'brin' // Block Range Index (very large tables)
  | 'spgist' // Space-partitioned GIST (non-balanced structures)
  | 'bloom'; // Bloom filter (multi-column equality)

export class IndexConstraint extends ConstraintBase {
  protected _unique: boolean = false;
  protected _method?: IndexMethod;
  protected _where?: string;
  protected _name?: string;
  protected _concurrent: boolean = false;
  protected _include?: string[];
  protected _expression?: string;
  protected _storageParams?: Record<string, string | number>;
  protected _tablespace?: string;

  constructor(table: TableSchema) {
    super(table);
  }

  unique() {
    this._unique = true;
    return this;
  }

  using(method: IndexMethod) {
    this._method = method;
    return this;
  }

  where(condition: string) {
    this._where = condition;
    return this;
  }

  indexName(name: string) {
    this._name = name;
    return this;
  }

  concurrent() {
    this._concurrent = true;
    return this;
  }

  include(...columns: string[]) {
    this._include = columns;
    return this;
  }

  expression(expr: string) {
    this._expression = expr;
    return this;
  }

  with(params: Record<string, string | number>) {
    this._storageParams = params;
    return this;
  }

  tablespace(name: string) {
    this._tablespace = name;
    return this;
  }

  isUnique() {
    return this._unique;
  }

  getMethod() {
    return this._method;
  }

  getWhere() {
    return this._where;
  }

  getIndexName() {
    return this._name;
  }

  getConcurrent() {
    return this._concurrent;
  }

  getInclude() {
    return this._include;
  }

  getExpression() {
    return this._expression;
  }

  getStorageParams() {
    return this._storageParams;
  }

  getTablespace() {
    return this._tablespace;
  }
}
