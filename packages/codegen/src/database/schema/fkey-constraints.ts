import { ConstraintBase } from './constraint-base.js';
import { TableColumnSchema } from './table-column-schema.js';
import { TableSchema } from './table-schema.js';
import { ReferentialAction } from './types.js';

export class ForeignKeyConstraint extends ConstraintBase {
  protected refTable: TableSchema;
  protected refColumns: TableColumnSchema[];
  protected _onUpdate: ReferentialAction;
  protected _onDelete: ReferentialAction;

  constructor(table: TableSchema, refTable: TableSchema) {
    super(table);
    this.refTable = refTable;
    this.refColumns = [];
    this._onUpdate = 'CASCADE';
    this._onDelete = 'RESTRICT';
  }

  onUpdate(action: ReferentialAction | undefined) {
    if (action) {
      this._onUpdate = action;
    }
    return this;
  }

  onDelete(action: ReferentialAction | undefined) {
    if (action) {
      this._onDelete = action;
    }
    return this;
  }

  to(...column: string[]) {
    (column || []).forEach(name => {
      const col = this.refTable.findColumn(name);
      if (col) {
        this.refColumns.push(col);
      } else {
        throw new Error(`Column ${name} does not exit in ${this.refTable.getName()}`);
      }
    });
    return this;
  }

  from(...column: string[]) {
    super.column(...column);
    return this;
  }

  column(...column: string[]): this {
    throw new Error('Use the from() and to()');
  }

  getRefTable() {
    return this.refTable;
  }

  getRefColumns() {
    return this.refColumns;
  }

  getOnDelete() {
    return this._onDelete;
  }

  getOnUpdate() {
    return this._onUpdate;
  }
}
