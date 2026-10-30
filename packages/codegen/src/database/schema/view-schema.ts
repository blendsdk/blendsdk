import { DataObjectSchema } from './dataobject-schema.js';

export class ViewSchema extends DataObjectSchema {
  protected _source: string | undefined;
  protected _materialized: boolean | undefined;
  protected _scope: string | undefined;

  as(source: string) {
    this._source = source;
    return this;
  }

  materialized(state: boolean) {
    this._materialized = state === false ? false : true;
    return this;
  }

  isMaterialized() {
    return this._materialized === true;
  }

  getSource() {
    return this._source;
  }

  scope(name: string) {
    this._scope = name;
    return this;
  }

  getName(scope?: boolean): string {
    scope = scope ?? true;
    return scope ? `${this._scope}.${this.name}` : this.name;
  }

  getScope() {
    return this._scope;
  }
}
