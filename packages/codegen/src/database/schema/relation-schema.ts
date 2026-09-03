import { ColumnSchema } from './column-schema.js';
import { DatabaseSchema } from './database-schema.js';
import { DataObjectSchema } from './dataobject-schema.js';

export class RelationSchema<ColumnType extends ColumnSchema<any>> extends DataObjectSchema {
  protected columns: ColumnType[];
  protected database: DatabaseSchema;
  protected _scope: string | undefined;

  constructor(name: string, database: DatabaseSchema) {
    super(name);
    this.columns = [];
    this.database = database;
  }

  scope(name: string) {
    this._scope = name;
    return this;
  }

  getName(scope?: boolean): string {
    scope = scope ?? true;
    return scope ? `${this._scope}.${this.name}` : this.name;
  }

  getScope() {
    return this._scope;
  }

  findColumn(name: string) {
    return this.columns.find(n => n.getName() === name);
  }

  getColumns() {
    return this.columns;
  }

  getDatabase() {
    return this.database;
  }
}
