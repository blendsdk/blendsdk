import { InsertStatement } from '@blendsdk/dbcore';

/**
 * Provides PostgreSQL-specific implementation for INSERT statement construction.
 * Builds parameterized INSERT queries with VALUES and optional RETURNING clauses.
 * Extends the base InsertStatement class with PostgreSQL syntax.
 *
 * @export
 * @class PostgreSQLInsertStatement
 * @template TableType - The type representing the table structure for type-safe insertions
 * @extends {InsertStatement<TableType>}
 */
export class PostgreSQLInsertStatement<TableType> extends InsertStatement<TableType> {
  /**
   * Constructs the PostgreSQL INSERT query string with VALUES and RETURNING clauses.
   * Generates parameterized query with named parameters matching column names.
   * Supports optional RETURNING clause to retrieve inserted row data.
   *
   * @protected
   * @return {string} The complete INSERT query string
   * @memberof PostgreSQLInsertStatement
   */
  protected buildQuery(): string {
    const keys = Object.keys(this._values);

    // Validate that values are provided — empty INSERT is invalid SQL
    if (keys.length === 0) {
      throw new Error(
        `Cannot build INSERT statement for table "${this.tableName}": no values provided. ` +
          'Call .values() with at least one column before executing.'
      );
    }

    // Build the INSERT query with column names and parameterized values
    // Format: INSERT INTO table (col1, col2) VALUES (:col1, :col2) RETURNING col1, col2
    return `INSERT INTO ${this.tableName} (${keys.join(', ')}) VALUES (${keys
      .map(key => `:${key}`)
      .join(', ')}) ${this._returning.length ? `RETURNING ${this._returning.join(', ')}` : ''}`.trim();
  }

  /**
   * Builds the parameter object for the INSERT query.
   * Returns the values object directly as parameters are already properly named.
   * Each key in the values object corresponds to a column name and parameter.
   *
   * @protected
   * @return {Object} Object containing named parameters matching the values to insert
   * @memberof PostgreSQLInsertStatement
   */
  protected buildParameters() {
    return this._values;
  }
}
