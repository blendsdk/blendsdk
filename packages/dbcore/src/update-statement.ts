import { FilterableStatement } from './filterable-statement.js';
import { Database } from './database.js';

/**
 * Abstract statement builder for UPDATE operations.
 * Extends FilterableStatement to provide functionality for updating existing records in database tables.
 * Concrete database implementations must extend this class to provide database-specific
 * UPDATE query construction and parameter handling.
 *
 * This class provides a fluent interface for building UPDATE statements with support
 * for filtering which records to update and RETURNING clauses to retrieve updated data.
 *
 * @export
 * @abstract
 * @class UpdateStatement
 * @extends {FilterableStatement<TableType, FilterType>}
 * @template TableType - The type representing the table structure for updates
 * @template FilterType - The type representing the filter criteria structure
 */
export abstract class UpdateStatement<TableType, FilterType> extends FilterableStatement<
  TableType,
  FilterType
> {
  /**
   * Creates an instance of UpdateStatement.
   * Initializes the statement with a table name and database connection.
   *
   * @param {string} tableName - The name of the table to update
   * @param {Database} db - The database instance to execute queries against
   * @memberof UpdateStatement
   */
  constructor(tableName: string, db: Database) {
    super(tableName, db);
  }

  /**
   * Sets the values to be updated in the table.
   * Accepts a partial object where keys represent column names and values
   * represent the new data. Only the specified columns will be updated.
   *
   * @param {Partial<TableType>} values - Object containing column names and new values
   * @return {this} The statement instance for method chaining
   * @memberof UpdateStatement
   *
   * @example
   * // Update user fields
   * statement.values({
   *   name: 'Jane Doe',
   *   email: 'jane@example.com',
   *   updated_at: new Date()
   * })
   */
  values(values: Partial<TableType>): this {
    this._values = values;
    return this;
  }
}
