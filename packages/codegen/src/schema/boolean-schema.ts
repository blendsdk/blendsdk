import { SchemaContainer } from './schema-container.js';
import { SchemaObject } from './schema-object.js';

export class BooleanSchema extends SchemaObject {
  constructor(container: SchemaContainer) {
    super(container);
    this.setData({
      primitive: true,
      tsType: 'boolean',
      zodType:'boolean'
    });
  }
}
