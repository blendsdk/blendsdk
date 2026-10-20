import { SchemaContainer } from './schema-container.js';
import { SchemaObject } from './schema-object.js';

export class DateSchema extends SchemaObject {
  constructor(container: SchemaContainer) {
    super(container);
    this.setData({
      primitive: true,
      tsType: 'Date',
      zodType: 'date',
    });
  }
}
