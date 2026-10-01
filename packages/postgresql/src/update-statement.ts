import { UpdateStatement } from '@blendsdk/dbcore';

/**
 * Provides PostgreSQL-specific implementation for UPDATE statement construction.
 * Builds parameterized UPDATE queries with SET, WHERE, and RETURNING clauses.
 * Extends the base UpdateStatement class with PostgreSQL syntax.
 *
 * @export
 * @class PostgreSQLUpdateStatement
 * @template TableType - The type representing the table structure for type-safe updates
 * @template FilterType - The type representing the filter criteria for the WHERE clause
 * @extends {UpdateStatement<TableType, FilterType>}
 */
export class PostgreSQLUpdateStatement<TableType, FilterType> extends UpdateStatement<
  TableType,
  FilterType
> {
  /**
   * Constructs the PostgreSQL UPDATE query string with SET, WHERE, and RETURNING clauses.
   * Generates parameterized query with named parameters for values (prefixed with 'v_')
   * and uses expression builder for complex WHERE conditions.
   * Supports optional RETURNING clause to retrieve updated row data.
   *
   * @protected
   * @return {string} The complete UPDATE query string
   * @memberof PostgreSQLUpdateStatement
   */
  protected buildQuery(): string {
    const keys = Object.keys(this._values);

    // Validate that values are provided — empty SET clause is invalid SQL
    if (keys.length === 0) {
      throw new Error(
        `Cannot build UPDATE statement for table "${this.tableName}": no values provided. ` +
          'Call .values() with at least one column before executing.'
      );
    }

    let queryStr = `UPDATE ${this.tableName} SET `;
    const setClauses: string[] = [];

    // Build SET clause from values to update
    // Each value key becomes a parameterized assignment with 'v_' prefix (e.g., column = :v_column)
    Object.keys(this._values).forEach(key => {
      setClauses.push(`${key} = :v_${key}`);
    });

    // Append SET clause with comma-separated assignments
    queryStr += setClauses.join(', ');

    // Build WHERE clause from cached compiled expression
    const compiled = this.getCompiledExpression();
    if (compiled?.sql) {
      queryStr += ` WHERE ${compiled.sql}`;
    }

    // Add RETURNING clause if specified to retrieve updated row data
    if (this._returning.length > 0) {
      queryStr += ` RETURNING ${this._returning.join(', ')}`;
    }

    return queryStr.trim();
  }

  /**
   * Builds the parameter object for the UPDATE query.
   * Combines value parameters (prefixed with 'v_') and expression parameters.
   * Returns an object mapping parameter names to their values for query execution.
   *
   * @protected
   * @return {Object} Object containing named parameters for both values and WHERE clause
   * @memberof PostgreSQLUpdateStatement
   */
  protected buildParameters() {
    const params: { [key: string]: any } = {};

    // Add values parameters with 'v_' prefix (columns to update)
    // This prevents conflicts with expression parameters
    Object.keys(this._values).forEach(key => {
      params[`v_${key}`] = (this._values as any)[key];
    });

    // Get parameters from cached compiled expression
    const compiled = this.getCompiledExpression();
    if (compiled) {
      Object.assign(params, compiled.params);
    }

    return params;
  }
}
