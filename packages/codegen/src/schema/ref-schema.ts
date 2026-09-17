import { SchemaContainer } from './schema-container.js';
import { SchemaObject } from './schema-object.js';

export class ReferenceSchema extends SchemaObject {
  constructor(container: SchemaContainer, refSchema: SchemaObject) {
    super(container);
    this.setData({
      primitive: true,
      ref: refSchema,
    });
  }
}
