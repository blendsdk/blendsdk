import { DataObjectSchema } from './dataobject-schema.js';
import { RelationSchema } from './relation-schema.js';

export class ColumnSchema<RelationType extends RelationSchema<any>> extends DataObjectSchema {
  protected relation: RelationType;

  constructor(name: string, relation: RelationType) {
    super(name);
    this.relation = relation;
  }
}
