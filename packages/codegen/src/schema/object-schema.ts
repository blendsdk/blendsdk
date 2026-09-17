import { SchemaContainer } from './schema-container.js';
import { SchemaObject } from './schema-object.js';

export type ObjectProps = Record<string, SchemaObject>;

export class ObjectSchema extends SchemaObject {
  protected props: ObjectProps;
  constructor(container: SchemaContainer) {
    super(container);
    this.props = {};
    this.setData({
      primitive: false,
      tsType: 'object',
      zodType: 'object',
    });
  }

  properties(props: ObjectProps) {
    this.props = { ...this.props, ...props };
    Object.values(this.props).forEach(p => p.setData({ parent: this }));
  }

  getProperties() {
    return this.props;
  }
}
