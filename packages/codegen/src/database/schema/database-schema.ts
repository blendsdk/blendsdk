import { DataObjectSchema } from './dataobject-schema.js';
import { TableSchema } from './table-schema.js';
import { ViewSchema } from './view-schema.js';

export type MakeTable = (t: TableSchema) => void;

export class DatabaseSchema extends DataObjectSchema {
  protected tables: TableSchema[];
  protected views: ViewSchema[];
  protected extensions: string[];
  protected defaultScope: string;

  constructor(name: string, defaultScope?: string) {
    super(name);
    this.tables = [];
    this.defaultScope = defaultScope || 'public';
    this.extensions = [];
    this.views = [];
  }

  extension(...extension: string[]) {
    this.extensions.push(...extension);
    return this;
  }

  table(name: string, builder?: MakeTable) {
    const tbl = new TableSchema(name, this);
    tbl.scope(this.defaultScope);

    if (builder) {
      builder(tbl);
    }

    this.tables.push(tbl);
    return tbl;
  }

  view(name: string) {
    const view = new ViewSchema(name);
    view.scope(this.defaultScope);
    this.views.push(view);
    return view;
  }

  getExtensions() {
    return this.extensions.filter(Boolean);
  }

  getTables() {
    return this.tables;
  }

  getViews() {
    return this.views;
  }

  getDefaultSchema() {
    return this.defaultScope;
  }
}
