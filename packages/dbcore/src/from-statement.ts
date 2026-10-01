import { CompileResult } from '@blendsdk/expression';
import { Database } from './database.js';
import { Statement } from './statement.js';

/**
 * Statement builder for SELECT queries with FROM clauses.
 * Provides a fluent interface for constructing SELECT statements with column selection,
 * WHERE clauses, and parameter binding. Supports both simple column lists and
 * aliased column expressions.
 *
 * This class enables type-safe query construction for retrieving data from database tables,
 * with support for filtering via expression compilation results.
 *
 * @export
 * @class FromStatement
 * @extends {Statement<TableType>}
 * @template TableType - The type representing the table structure being queried
 */
export class FromStatement<TableType> extends Statement<TableType> {
  /**
   * Array of column names or expressions to select.
   * Can include simple column names, aliased expressions, or '*' for all columns.
   *
   * @protected
   * @type {string[]}
   * @memberof FromStatement
   */
  protected _selectColumns: string[];

  /**
   * Object containing named parameters for the query.
   * These parameters are used in the WHERE clause for safe parameterized queries.
   *
   * @protected
   * @type {Record<string, any>}
   * @memberof FromStatement
   */
  protected _parameters: Record<string, any> = {};

  /**
   * The WHERE clause string for filtering results.
   * Generated from expression compilation or left empty for unfiltered queries.
   *
   * @protected
   * @type {string}
   * @memberof FromStatement
   */
  protected _whereClause: string = '';

  /**
   * Builds the parameters object for the query.
   * Returns the stored parameters that will be used in the WHERE clause.
   *
   * @protected
   * @return {Record<string, any>} The parameters object for query execution
   * @memberof FromStatement
   */
  protected buildParameters() {
    return this._parameters;
  }

  /**
   * Creates an instance of FromStatement.
   * Initializes the statement with a table name and database connection,
   * and sets up an empty array for select columns.
   *
   * @param {string} tableName - The name of the table to select from
   * @param {Database} db - The database instance to execute queries against
   * @memberof FromStatement
   */
  constructor(
    protected tableName: string,
    db: Database
  ) {
    super(db);
    this._selectColumns = [];
  }

  /**
   * Specifies which columns to select in the query.
   * Accepts an array of column names, an object mapping aliases to expressions,
   * or defaults to '*' for all columns if not specified.
   *
   * When an object is provided, keys become column aliases and values are the expressions.
   * For example, { total: 'price * quantity' } becomes "price * quantity AS total".
   *
   * @param {string[] | Record<string, any>} [columns] - Columns to select, or undefined for all columns
   * @return {this} The statement instance for method chaining
   * @memberof FromStatement
   *
   * @example
   * // Select specific columns
   * statement.select(['id', 'name', 'email'])
   *
   * @example
   * // Select all columns
   * statement.select()
   *
   * @example
   * // Select with aliases
   * statement.select({ fullName: 'first_name || \' \' || last_name', total: 'price * quantity' })
   */
  select(columns?: string[] | Record<string, any>): this {
    // normalize columns
    columns = columns || ['*'];

    if (Array.isArray(columns)) {
      this._selectColumns = columns;
    } else if (typeof columns === 'object') {
      // convert object to array of "key AS val"
      this._selectColumns = Object.entries(columns)
        .map(([key, val]) => {
          return `${val} AS ${key}`;
        })
        .filter(Boolean) as string[];
    } else {
      this._selectColumns = ['*'];
    }
    return this;
  }

  /**
   * Applies a WHERE clause filter using a compiled expression result.
   * The expression result contains both the WHERE clause string and the associated
   * parameters, which are stored for use during query execution.
   *
   * This method is typically used with the expression builder from @blendsdk/expression
   * to create type-safe, parameterized WHERE clauses.
   *
   * @param {CompileResult} filter - The compiled expression containing WHERE clause and parameters
   * @return {this} The statement instance for method chaining
   * @memberof FromStatement
   *
   * @example
   * // Using with expression builder
   * const filter = expr.compile(t => t.age.gt(18).and(t.status.eq('active')));
   * statement.byExpression(filter);
   */
  byExpression(filter: CompileResult): this {
    const { sql, params } = filter;
    this._whereClause = `WHERE ${sql}`;
    this._parameters = params;
    return this;
  }

  /**
   * Builds the complete SELECT query string.
   * Combines the SELECT clause, FROM clause, and optional WHERE clause
   * into a complete SQL query string.
   *
   * @protected
   * @return {string} The complete SQL query string
   * @memberof FromStatement
   */
  protected buildQuery(): string {
    const whereClause = this._whereClause ? ` ${this._whereClause}` : '';
    return `SELECT ${this._selectColumns.join(', ')} FROM ${this.tableName}${whereClause}`.trim();
  }
}
