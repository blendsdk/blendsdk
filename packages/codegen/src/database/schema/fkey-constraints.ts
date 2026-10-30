import { ConstraintBase } from './constraint-base.js';
import { TableColumnSchema } from './table-column-schema.js';
import { TableSchema } from './table-schema.js';
import { ReferentialAction } from './types.js';

/** Deferrable modes accepted by {@link ForeignKeyConstraint.deferrable}. */
export type ForeignKeyDeferrability = 'DEFERRED' | 'IMMEDIATE';

const FOREIGN_KEY_DEFERRABILITY = new Set<ForeignKeyDeferrability>(['DEFERRED', 'IMMEDIATE']);

export class ForeignKeyConstraint extends ConstraintBase {
  protected refTable: TableSchema;
  protected refColumns: TableColumnSchema[];
  protected _onUpdate: ReferentialAction;
  protected _onDelete: ReferentialAction;
  protected _deferrable = false;
  protected _initiallyDeferred = false;

  constructor(table: TableSchema, refTable: TableSchema) {
    super(table);
    this.refTable = refTable;
    this.refColumns = [];
    this._onUpdate = 'CASCADE';
    this._onDelete = 'RESTRICT';
  }

  /**
   * Marks the constraint `DEFERRABLE` with the requested initial timing.
   *
   * PostgreSQL checks a deferrable constraint at commit time when the mode is `DEFERRED`, or at
   * statement time when it is `IMMEDIATE`. The mode is validated here because the value is
   * rendered into DDL and may come from a JavaScript caller outside TypeScript's type checker.
   *
   * @param mode - `DEFERRED` or `IMMEDIATE`
   * @returns This constraint for chaining
   * @throws {Error} When the mode is not one of the accepted values
   * @memberof ForeignKeyConstraint
   */
  deferrable(mode: ForeignKeyDeferrability) {
    if (!FOREIGN_KEY_DEFERRABILITY.has(mode)) {
      throw new Error(
        `Unsupported foreign key deferrability: ${String(mode)}. Use "DEFERRED" or "IMMEDIATE".`
      );
    }
    this._deferrable = true;
    this._initiallyDeferred = mode === 'DEFERRED';
    return this;
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

  /** True when the constraint is declared `DEFERRABLE`. */
  isDeferrable() {
    return this._deferrable;
  }

  /** True when a deferrable constraint starts `INITIALLY DEFERRED`. */
  isInitiallyDeferred() {
    return this._initiallyDeferred;
  }
}
