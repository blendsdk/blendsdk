import { SchemaObject } from './schema-object.js';
import { SchemaScope } from './schema-scope.js';

export class SchemaContainer {
  protected objects: SchemaObject[];
  protected index: Record<string, boolean>;

  constructor() {
    this.objects = [];
    this.index = {};
  }

  getAll() {
    return this.objects;
  }

  clear() {
    this.objects = [];
    this.index = {};
    return this;
  }

  /**
   * Finds one registered schema object by scope and name.
   *
   * The default schema is represented by an `undefined` scope, so callers may omit it.
   *
   * @param scope - Schema scope, or `undefined` for the default schema
   * @param name - Schema object name
   * @returns The matching object, or `undefined`
   * @memberof SchemaContainer
   */
  find(scope: string | undefined, name: string) {
    return this.objects.find(o => o.getScope() === scope && o.getName() === name);
  }

  add(obj: SchemaObject) {
    this.assert(obj.getName()!, obj.getScope());
    this.objects.push(obj);
  }

  assert(name: string, scope: string | undefined) {
    const id = `${scope || ''}${name}`;
    const exists = name ? this.index[id] : false;
    if (exists && name) {
      throw Error(`Schema object already exists ${scope ? `${scope}.` : ''}${name}`);
    }
    if (!exists && name) {
      this.index[id] = true;
    }
  }

  scope(name?: string) {
    return new SchemaScope(this, name);
  }
}
