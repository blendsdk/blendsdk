import { SchemaContainer } from './schema-container.js';
import { SchemaObject } from './schema-object.js';

export class AnySchema extends SchemaObject {
  constructor(container: SchemaContainer) {
    super(container);
    this.setData({
      primitive: true,
      tsType: 'any',
      zodType: 'any',
    });
  }
}
