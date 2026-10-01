import { DeleteStatement } from '@blendsdk/dbcore';

/**
 * Provides PostgreSQL-specific implementation for DELETE statement construction.
 * Builds parameterized DELETE queries with WHERE clauses and RETURNING support.
 * Extends the base DeleteStatement class with PostgreSQL syntax.
 *
 * @export
 * @class PostgreSQLDeleteStatement
 * @template FilterType - The type representing the filter criteria for the WHERE clause
 * @extends {DeleteStatement<FilterType>}
 */
export class PostgreSQLDeleteStatement<FilterType> extends DeleteStatement<FilterType> {
  /**
   * Constructs the PostgreSQL DELETE query string with WHERE and RETURNING clauses.
   * Uses cached compiled expression for complex WHERE conditions with parameterized queries.
   * Supports optional RETURNING clause to retrieve deleted row data.
   *
   * @protected
   * @return {string} The complete DELETE query string
   * @memberof PostgreSQLDeleteStatement
   */
  protected buildQuery(): string {
    let queryStr = `DELETE FROM ${this.tableName}`;

    // Build WHERE clause from cached compiled expression
    const compiled = this.getCompiledExpression();
    if (compiled?.sql) {
      queryStr += ` WHERE ${compiled.sql}`;
    }

    // Add RETURNING clause if specified to retrieve deleted row data
    if (this._returning.length > 0) {
      queryStr += ` RETURNING ${this._returning.join(', ')}`;
    }

    return queryStr.trim();
  }

  /**
   * Builds the parameter object for the DELETE query.
   * Uses cached compiled expression to generate parameters with proper naming.
   * Returns an object mapping parameter names to their values for query execution.
   *
   * @protected
   * @return {Object} Object containing named parameters for the WHERE clause
   * @memberof PostgreSQLDeleteStatement
   */
  protected buildParameters() {
    const params: { [key: string]: any } = {};

    // Get parameters from cached compiled expression
    const compiled = this.getCompiledExpression();
    if (compiled) {
      Object.assign(params, compiled.params);
    }

    return params;
  }
}
