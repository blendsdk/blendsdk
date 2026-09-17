import { AnySchema } from './any-schema.js';
import { BooleanSchema } from './boolean-schema.js';
import { DateSchema } from './date-schema.js';
import { ObjectProps, ObjectSchema } from './object-schema.js';
import { BigIntSchema, NumberSchema, StringSchema } from './primitive-schema.js';
import { ReferenceSchema } from './ref-schema.js';
import { SchemaContainer } from './schema-container.js';
import { SchemaObject } from './schema-object.js';

export class SchemaScope {
  protected _scope: string | undefined;
  protected _container: SchemaContainer;

  constructor(container: SchemaContainer, name?: string) {
    this._scope = name;
    this._container = container;
  }

  bigint() {
    const o = new BigIntSchema(this._container);
    o.scope(this._scope);
    this._container.add(o);
    return o;
  }

  number() {
    const o = new NumberSchema(this._container);
    o.scope(this._scope);
    this._container.add(o);
    return o;
  }

  string() {
    const o = new StringSchema(this._container);
    o.scope(this._scope);
    this._container.add(o);
    return o;
  }

  date() {
    const o = new DateSchema(this._container);
    o.scope(this._scope);
    this._container.add(o);
    return o;
  }

  boolean() {
    const o = new BooleanSchema(this._container);
    o.scope(this._scope);
    this._container.add(o);
    return o;
  }

  ref(obj: SchemaObject) {
    const o = new ReferenceSchema(this._container, obj);
    o.scope(this._scope);
    this._container.add(o);
    return o;
  }

  object(properties: ObjectProps) {
    const o = new ObjectSchema(this._container);
    o.scope(this._scope);
    o.properties(properties);
    this._container.add(o);
    return o;
  }

  any() {
    const o = new AnySchema(this._container);
    o.scope(this._scope);
    this._container.add(o);
    return o;
  }

  find(name: string) {
    return this._container.find(this._scope!, name);
  }
}
