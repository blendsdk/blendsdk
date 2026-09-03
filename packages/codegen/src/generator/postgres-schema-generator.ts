import { DatabaseSchema } from '../database/schema/database-schema.js';
import { TableColumnSchema } from '../database/schema/table-column-schema.js';
import { TableSchema } from '../database/schema/table-schema.js';

const TAB = (count?: number) => `\t`.repeat(count || 1);
const LINE = (...parts: any[]) =>
  parts
    .map(p => p?.toString())
    .filter(Boolean)
    .join(' ');

export interface GenerateOptions {
  dropBeforeCreate?: boolean;
}

export interface GeneratedDDL {
  schema: string; // extensions + schemas + tables + constraints + comments
  indexes: string; // all indexes
  views: string; // all views (regular and materialized)
  all: string; // schema + indexes + views (everything combined)
}

export class PostgreSQLSchemaGenerator {
  protected db: DatabaseSchema;

  constructor(db: DatabaseSchema) {
    this.db = db;
  }

  protected renderExtensions(): string {
    const extensions = Array.from(new Set(this.db.getExtensions()));
    const lines = extensions.map(name => `CREATE EXTENSION IF NOT EXISTS "${name}";`);
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected dropTablesSQL(): string {
    const tables = this.db.getTables();
    const lines = tables.map(t => `DROP TABLE IF EXISTS ${t.getName()} CASCADE;`);
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected renderColumns(table: TableSchema) {
    const lines: string[] = [];
    const columns = table.getColumns();

    columns.forEach(col => {
      const def = col.getDefault();
      const isGenerated = col.isGenerated();
      const isIdentity = col.isIdentity();
      const identityClause = isIdentity ? this.renderIdentityClause(col) : undefined;

      lines.push(
        LINE(
          //
          TAB(),
          col.getName(),
          col.getType(),
          col.getSize() || col.getScale()
            ? `(${[col.getSize(), col.getScale()].filter(Boolean).join(',')})`
            : undefined,
          !isGenerated && !isIdentity && !col.getNullable() ? 'NOT NULL' : undefined,
          isGenerated
            ? `GENERATED ALWAYS AS (${col.getGeneratedExpression()}) STORED`
            : identityClause
              ? identityClause
              : def
                ? `DEFAULT ${def}`
                : undefined
        )
      );
    });

    return lines.join(`,\n`);
  }

  protected renderIdentityClause(col: TableColumnSchema): string {
    const generation = col.getIdentityGeneration();
    const options = col.getIdentityOptions();

    let clause = `GENERATED ${generation} AS IDENTITY`;

    if (options && Object.keys(options).length > 0) {
      const opts: string[] = [];
      if (options.start !== undefined) opts.push(`START WITH ${options.start}`);
      if (options.increment !== undefined) opts.push(`INCREMENT BY ${options.increment}`);
      if (options.minValue !== undefined) opts.push(`MINVALUE ${options.minValue}`);
      if (options.maxValue !== undefined) opts.push(`MAXVALUE ${options.maxValue}`);
      if (options.cache !== undefined) opts.push(`CACHE ${options.cache}`);
      if (options.cycle === true) opts.push('CYCLE');

      if (opts.length > 0) {
        clause += ` (${opts.join(' ')})`;
      }
    }

    return clause;
  }

  protected renderTablesSQL(): string {
    const tables = this.db.getTables();
    const lines: string[] = [];
    tables.forEach(table => {
      lines.push(`CREATE TABLE ${table.getName()} (`);
      lines.push(this.renderColumns(table));
      lines.push(');');
      lines.push('');
    });
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected renderPrimaryKey(table: TableSchema) {
    const lines: string[] = [];
    if (table.primaryKey().hasColumns()) {
      lines.push(
        LINE(
          TAB(),
          'ADD CONSTRAINT',
          this.constraintName(table, 'pkey', table.primaryKey().getColumns() as TableColumnSchema[]),
          'PRIMARY KEY',
          LINE(
            '(',
            table
              .primaryKey()
              .getColumns()
              .map(c => c.getName())
              .join(','),
            ')'
          )
        )
      );
    }
    return lines.join(' ');
  }

  protected renderForeignKeyConstraints(table: TableSchema) {
    const lines: string[] = [];
    const constraints = table.getForeignKeyConstrains();
    if (constraints.length !== 0) {
      constraints.forEach((fk, idx) => {
        lines.push(
          LINE(
            TAB(),
            'ADD CONSTRAINT',
            this.constraintName(
              table,
              ['fk', idx].filter(Boolean).join('_'),
              fk.getColumns() as TableColumnSchema[]
            ),
            'FOREIGN KEY',
            '(',
            fk
              .getColumns()
              .map(c => c.getName())
              .join(', '),
            ')',
            'REFERENCES',
            fk.getRefTable().getName(),
            '(',
            fk
              .getRefColumns()
              .map((c: TableColumnSchema) => c.getName())
              .join(', '),
            ')',
            fk.getOnDelete() ? `ON DELETE ${fk.getOnDelete()}` : undefined,
            fk.getOnUpdate() ? `ON UPDATE ${fk.getOnUpdate()}` : undefined
          )
        );
      });
    }
    return lines;
  }

  protected renderUniqueConstraints(table: TableSchema) {
    const lines: string[] = [];
    const constraints = table.getUniqueConstraints();
    if (constraints.length !== 0) {
      constraints.forEach((uc, idx) => {
        lines.push(
          LINE(
            TAB(),
            'ADD CONSTRAINT',
            this.constraintName(
              table,
              ['unique', idx].filter(Boolean).join('_'),
              uc.getColumns() as TableColumnSchema[]
            ),
            'UNIQUE',
            '(',
            uc
              .getColumns()
              .map(c => c.getName())
              .join(', '),
            ')'
          )
        );
      });
    }
    return lines;
  }

  protected renderCheckConstraints(table: TableSchema) {
    const lines: string[] = [];
    const constraints = table.getCheckConstraints();
    if (constraints.length !== 0) {
      constraints.forEach((check, idx) => {
        lines.push(
          LINE(
            TAB(),
            'ADD CONSTRAINT',
            this.constraintName(
              table,
              ['check', idx].filter(Boolean).join('_'),
              check.getColumns() as TableColumnSchema[]
            ),
            'CHECK',
            '(',
            check.getRule(),
            ')'
          )
        );
      });
    }
    return lines;
  }

  protected renderConstraintsSQL(): string {
    const tables = this.db.getTables();
    const lines: string[] = [];
    tables.forEach(table => {
      const constraints = [
        this.renderPrimaryKey(table),
        ...this.renderCheckConstraints(table),
        ...this.renderUniqueConstraints(table),
        ...this.renderForeignKeyConstraints(table),
      ].filter(Boolean);
      if (constraints.length !== 0) {
        lines.push(`ALTER TABLE ${table.getName()}`);
        lines.push(constraints.join(`,\n`));
        lines.push(';');
      }
    });
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected constraintName(table: TableSchema, postfix: string, columns: TableColumnSchema[]) {
    return [table.getName(false), ...columns.map(c => c.getName()), postfix]
      .join('_')
      .toLocaleLowerCase();
  }

  protected dropSchemasSQL(): string {
    const tables = this.db.getTables();
    const schemas = Array.from(new Set(tables.map(t => t.getScope()))).filter(
      s => s !== this.db.getDefaultSchema()
    );
    const lines = schemas.map(t => `DROP SCHEMA IF EXISTS ${t} CASCADE;`);
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected createSchemasSQL(): string {
    const tables = this.db.getTables();
    const schemas = Array.from(new Set(tables.map(t => t.getScope()))).filter(
      s => s !== this.db.getDefaultSchema()
    );
    const lines = schemas.map(t => `CREATE SCHEMA IF NOT EXISTS ${t};`);
    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected escapeComment(comment: string): string {
    // Escape single quotes by doubling them for PostgreSQL
    return comment.replace(/'/g, "''");
  }

  protected renderCommentsSQL(): string {
    const tables = this.db.getTables();
    const lines: string[] = [];

    tables.forEach(table => {
      // Table comment
      const tableComment = table.getComment();
      if (tableComment) {
        lines.push(`COMMENT ON TABLE ${table.getName()} IS '${this.escapeComment(tableComment)}';`);
      }

      // Column comments
      table.getColumns().forEach(col => {
        const colComment = col.getComment();
        if (colComment) {
          lines.push(
            `COMMENT ON COLUMN ${table.getName()}.${col.getName()} IS '${this.escapeComment(colComment)}';`
          );
        }
      });
    });

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected renderViewCommentsSQL(): string {
    const views = this.db.getViews();
    const lines: string[] = [];

    views.forEach(view => {
      const viewComment = view.getComment();
      if (viewComment) {
        const viewType = view.isMaterialized() ? 'MATERIALIZED VIEW' : 'VIEW';
        lines.push(
          `COMMENT ON ${viewType} ${view.getName()} IS '${this.escapeComment(viewComment)}';`
        );
      }
    });

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected renderIndexesSQL(): string {
    const tables = this.db.getTables();
    const lines: string[] = [];

    tables.forEach(table => {
      const indexes = table.getIndexes();
      indexes.forEach((idx, i) => {
        const parts: string[] = [];

        // CREATE [UNIQUE] INDEX [CONCURRENTLY]
        parts.push('CREATE');
        if (idx.isUnique()) parts.push('UNIQUE');
        parts.push('INDEX');
        if (idx.getConcurrent()) parts.push('CONCURRENTLY');

        // Index name (auto-generated if not provided)
        const indexName = idx.getIndexName() || this.generateIndexName(table, idx, i);
        parts.push(indexName);

        // ON table
        parts.push('ON', table.getName());

        // USING method
        if (idx.getMethod()) {
          parts.push('USING', idx.getMethod()!.toUpperCase());
        }

        // Columns or expression
        if (idx.getExpression()) {
          parts.push(`(${idx.getExpression()})`);
        } else {
          const columns = idx
            .getColumns()
            .map(c => c.getName())
            .join(', ');
          parts.push(`(${columns})`);
        }

        // INCLUDE columns
        if (idx.getInclude()?.length) {
          parts.push(`INCLUDE (${idx.getInclude()!.join(', ')})`);
        }

        // WITH storage parameters
        if (idx.getStorageParams()) {
          const params = Object.entries(idx.getStorageParams()!)
            .map(([k, v]) => `${k} = ${v}`)
            .join(', ');
          parts.push(`WITH (${params})`);
        }

        // TABLESPACE
        if (idx.getTablespace()) {
          parts.push('TABLESPACE', idx.getTablespace()!);
        }

        // WHERE clause
        if (idx.getWhere()) {
          parts.push('WHERE', idx.getWhere()!);
        }

        lines.push(parts.join(' ') + ';');
      });
    });

    return lines.length > 0 ? lines.join('\n') + '\n' : '';
  }

  protected generateIndexName(table: TableSchema, idx: any, position: number): string {
    const parts: string[] = [table.getName(false)];

    // Add 'expr' prefix for expression indexes
    if (idx.getExpression()) {
      parts.push('expr');
    }

    // Add column names
    if (idx.getColumns().length > 0) {
      parts.push(...idx.getColumns().map((c: any) => c.getName()));
    }

    // Add index type suffix
    if (idx.isUnique()) {
      parts.push('key');
    } else {
      parts.push('idx');
    }

    // Add position only if > 0
    if (position > 0) {
      parts.push(position.toString());
    }

    return parts.join('_').toLowerCase();
  }

  protected renderViewsSQL(): string {
    const views = this.db.getViews();
    if (views.length === 0) {
      return '';
    }

    const lines: string[] = [];

    // Drop all views first (both regular and materialized)
    lines.push(
      ...views.map(v => {
        if (v.isMaterialized()) {
          return `DROP MATERIALIZED VIEW IF EXISTS ${v.getName()} CASCADE;`;
        }
        return `DROP VIEW IF EXISTS ${v.getName()} CASCADE;`;
      })
    );

    // Create views (CREATE OR REPLACE only works for regular views, not materialized)
    lines.push(
      ...views.map(v => {
        if (v.isMaterialized()) {
          return `CREATE MATERIALIZED VIEW ${v.getName()} AS ${v.getSource()};`;
        }
        return `CREATE OR REPLACE VIEW ${v.getName()} AS ${v.getSource()};`;
      })
    );

    return lines.join('\n') + '\n';
  }

  /**
   * Generate DDL statements grouped by logical sections
   * @param params Generation options
   * @returns Object containing schema, indexes, views, and all DDL statements
   */
  generateGrouped(params?: GenerateOptions): GeneratedDDL {
    const { dropBeforeCreate = true } = params || {};

    // Build schema group (extensions + schemas + tables + constraints + comments)
    const schemaParts: string[] = [];
    schemaParts.push(this.renderExtensions());
    if (dropBeforeCreate) {
      schemaParts.push(this.dropSchemasSQL());
      schemaParts.push(this.dropTablesSQL());
    }
    schemaParts.push(this.createSchemasSQL());
    schemaParts.push(this.renderTablesSQL());
    schemaParts.push(this.renderConstraintsSQL());
    schemaParts.push(this.renderCommentsSQL());

    // Build indexes group
    const indexes = this.renderIndexesSQL();

    // Build views group (views + view comments)
    const viewsParts: string[] = [];
    viewsParts.push(this.renderViewsSQL());
    viewsParts.push(this.renderViewCommentsSQL());

    const schema = schemaParts.filter(s => s.length > 0).join('\n');
    const views = viewsParts.filter(s => s.length > 0).join('\n');
    const all = [schema, indexes, views].filter(s => s.length > 0).join('\n');

    return { schema, indexes, views, all };
  }

  /**
   * Generate complete DDL as a single string (backward compatible)
   * @param params Generation options
   * @returns Complete DDL as a single string
   */
  generate(params?: GenerateOptions): string {
    return this.generateGrouped(params).all;
  }
}
