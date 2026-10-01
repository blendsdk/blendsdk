import { SchemaContainer } from './schema-container.js';

export interface SchemaObjectData {
  description?: string[];
  primitive?: boolean;
  tsType?: string;
  optional?: boolean;
  nullable?: boolean;
  partial?: boolean;
  arrayed?: boolean;
  parent?: SchemaObject;
  rendered?: boolean;
  ref?: SchemaObject;
  recordOf?: boolean;
  declType?: string;
  metadata?: Record<string, any>;
  zodType?: string;
}

export abstract class SchemaObject {
  protected _name: string | undefined;
  protected _scope: string | undefined;
  protected _container: SchemaContainer;
  protected _data: SchemaObjectData;

  constructor(container: SchemaContainer) {
    this._container = container;
    this._data = {
      metadata: {},
    };
  }

  reset() {
    this.setData({
      rendered: false,
    });
  }

  metadata(data: Record<string, any>) {
    this._data.metadata = { ...this._data.metadata, ...data };
  }

  setData(data: SchemaObjectData) {
    this._data = { ...this._data, ...data };
  }

  hasParent() {
    return this._data.parent !== undefined;
  }

  isRendered() {
    return this._data.rendered === true;
  }

  arrayed() {
    this.setData({
      arrayed: true,
    });
    return this;
  }

  description(text: string | string[] | undefined, prefix?: boolean) {
    if (text) {
      const descr = this._data.description || [];
      const txt: string[] = Array.isArray(text) ? text : [text];
      this._data.description = prefix ? [...txt, ...descr] : [...descr, ...txt];
    }
    return this;
  }

  recordSet() {
    this.setData({
      recordOf: true,
    });
    return this;
  }

  partial() {
    this.setData({
      partial: true,
    });
    return this;
  }

  nullable() {
    this.setData({
      nullable: true,
    });
    return this;
  }

  optional() {
    this.setData({
      optional: true,
    });
    return this;
  }

  named(value: string) {
    this._container.assert(value, this._scope);
    this._name = value;
    return this;
  }

  scope(value?: string) {
    this._container.assert(this._name!, value);
    this._scope = value;
    return this;
  }

  getData() {
    return this._data;
  }

  getNamedScoped() {
    return [this._scope, this._name].filter(Boolean).join('.');
  }

  getName() {
    return this._name;
  }

  getScope() {
    return this._scope;
  }
}
