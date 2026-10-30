import { ColumnSchema } from './column-schema.js';
import { DataObjectSchema } from './dataobject-schema.js';
import { TableSchema } from './table-schema.js';

export class ConstraintBase extends DataObjectSchema {
  protected columns: ColumnSchema<TableSchema>[];
  protected table: TableSchema;

  constructor(table: TableSchema) {
    super('');
    this.table = table;
    this.columns = [];
  }

  column(...column: string[]) {
    (column || []).forEach(name => {
      const col = this.table.findColumn(name);
      if (col) {
        this.columns.push(col);
      } else {
        throw new Error(`Column ${name} does not exit in ${this.table.getName()}`);
      }
    });
    return this;
  }

  hasColumns() {
    return this.columns.length !== 0;
  }

  getTable() {
    return this.table;
  }

  getColumns() {
    return this.columns;
  }
}
