import { CrudStatement } from './crud-statement.js';
import { Database } from './database.js';
import type { CompileResult, QueryBuilder } from '@blendsdk/expression';
import { query } from '@blendsdk/expression';

/**
 * Abstract statement builder that adds filtering capabilities to CRUD statements.
 * Provides shared filter logic used by both UPDATE and DELETE operations,
 * including simple key-value filters and complex expression-based filters.
 *
 * This class eliminates code duplication between UpdateStatement and DeleteStatement
 * by centralizing the `_expressionBuilder`, `filter()`, and `filterByExpression()` methods.
 *
 * @export
 * @abstract
 * @class FilterableStatement
 * @extends {CrudStatement<TableType>}
 * @template TableType - The type representing the table structure this statement operates on
 * @template FilterType - The type representing the filter criteria structure
 */
export abstract class FilterableStatement<TableType, FilterType> extends CrudStatement<TableType> {
  /**
   * Expression builder function for constructing complex WHERE clauses.
   * This is the primary mechanism for filtering records in UPDATE/DELETE operations.
   *
   * @protected
   * @type {((q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>) | undefined}
   * @memberof FilterableStatement
   */
  protected _expressionBuilder?: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>;

  /**
   * Cached compiled expression result to avoid double compilation.
   * The expression builder is invoked once and the result is reused
   * by both buildQuery() and buildParameters() in concrete implementations.
   *
   * @protected
   * @type {CompileResult | undefined}
   * @memberof FilterableStatement
   */
  protected _compiledExpression?: CompileResult;

  /**
   * Creates an instance of FilterableStatement.
   * Initializes the statement with a table name and database connection.
   *
   * @param {string} tableName - The name of the table this statement operates on
   * @param {Database} db - The database instance to execute queries against
   * @memberof FilterableStatement
   */
  constructor(tableName: string, db: Database) {
    super(tableName, db);
  }

  /**
   * Compiles the expression builder and caches the result.
   * If no expression builder is set, returns null.
   * Subsequent calls return the cached result without recompilation.
   *
   * This method is used by concrete statement implementations (e.g., PostgreSQL)
   * to generate WHERE clause SQL and parameters from the expression builder.
   *
   * @protected
   * @returns {CompileResult | null} The compiled expression result, or null if no filter is set
   * @memberof FilterableStatement
   */
  protected getCompiledExpression(): CompileResult | null {
    if (!this._expressionBuilder) return null;
    if (!this._compiledExpression) {
      const expr = query<FilterType>();
      const result = this._expressionBuilder(expr);
      this._compiledExpression = result.compile();
    }
    return this._compiledExpression;
  }

  /**
   * Sets the filter criteria for selecting which records to modify.
   * Accepts a partial object where keys represent column names and values
   * represent the criteria. Only records matching all specified criteria will be affected.
   *
   * This method internally converts the key-value pairs to an expression builder
   * using equality comparisons. Multiple filters are combined with AND logic.
   * Can be chained with filterByExpression() to add additional conditions.
   *
   * @param {Partial<FilterType>} values - Object containing filter column names and criteria values
   * @return {this} The statement instance for method chaining
   * @memberof FilterableStatement
   *
   * @example
   * // Filter by a single criterion
   * statement.filter({ id: 123 })
   *
   * @example
   * // Filter by multiple criteria (combined with AND)
   * statement.filter({ status: 'pending', active: true })
   *
   * @example
   * // Chain with filterByExpression for complex conditions
   * statement
   *   .filter({ active: true })
   *   .filterByExpression(q => q.where('age').greaterThan(18))
   */
  filter(values: Partial<FilterType>): this {
    // Convert filter object to expression builder
    const newBuilder = (q: QueryBuilder<FilterType>) => {
      let builder = q;
      const keys = Object.keys(values) as (keyof FilterType)[];

      if (keys.length === 0) return builder;

      // First condition uses where()
      const firstKey = keys[0];
      builder = builder.where(firstKey).equals(values[firstKey]!);

      // Subsequent conditions use and()
      for (let i = 1; i < keys.length; i++) {
        const key = keys[i];
        builder = builder.and(key).equals(values[key]!);
      }

      return builder;
    };

    // Merge with existing expression builder using AND
    if (this._expressionBuilder) {
      const existingBuilder = this._expressionBuilder;
      this._expressionBuilder = (q) => {
        const existing = existingBuilder(q);
        return newBuilder(existing);
      };
    } else {
      this._expressionBuilder = newBuilder;
    }

    return this;
  }

  /**
   * Sets a complex filter expression for selecting which records to modify.
   * Provides full access to the expression builder API for constructing
   * sophisticated WHERE clauses with logical operators, comparisons, and more.
   *
   * Can be chained with filter() to combine simple and complex conditions.
   * Multiple calls to filterByExpression() are merged with AND logic.
   *
   * @param {(q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>} builder - Expression builder function
   * @return {this} The statement instance for method chaining
   * @memberof FilterableStatement
   *
   * @example
   * // Filter with complex conditions
   * statement.filterByExpression(q =>
   *   q.where('age').greaterThan(65)
   *    .or('status').equals('inactive')
   * )
   *
   * @example
   * // Chain with simple filter
   * statement
   *   .filter({ active: true })
   *   .filterByExpression(q => q.where('last_login').lessThan(cutoffDate))
   *
   * @example
   * // Complex nested conditions
   * statement.filterByExpression(q =>
   *   q.where('category').equals('archived')
   *    .and(sub =>
   *      sub.where('created_at').lessThan(oldDate)
   *         .or('updated_at').isNull()
   *    )
   * )
   */
  filterByExpression(builder: (q: QueryBuilder<FilterType>) => QueryBuilder<FilterType>): this {
    // Merge with existing expression builder using AND
    if (this._expressionBuilder) {
      const existingBuilder = this._expressionBuilder;
      this._expressionBuilder = (q) => {
        const existing = existingBuilder(q);
        return builder(existing);
      };
    } else {
      this._expressionBuilder = builder;
    }

    return this;
  }
}
