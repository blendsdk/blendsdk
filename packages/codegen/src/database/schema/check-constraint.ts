import { ConstraintBase } from './constraint-base.js';
import { TableSchema } from './table-schema.js';

export class CheckConstraint extends ConstraintBase {
  protected _rule: string;
  constructor(table: TableSchema, rule: string) {
    super(table);
    this._rule = rule;
  }

  getRule() {
    return this._rule;
  }
}
