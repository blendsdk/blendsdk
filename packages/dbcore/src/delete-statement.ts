import { FilterableStatement } from './filterable-statement.js';
import { Database } from './database.js';

/**
 * Abstract statement builder for DELETE operations.
 * Extends FilterableStatement to provide functionality for deleting records from database tables.
 * Concrete database implementations must extend this class to provide database-specific
 * DELETE query construction and parameter handling.
 *
 * This class provides a fluent interface for building DELETE statements with support
 * for filtering which records to delete and RETURNING clauses to retrieve deleted data.
 *
 * @export
 * @abstract
 * @class DeleteStatement
 * @extends {FilterableStatement<FilterType, FilterType>}
 * @template FilterType - The type representing the filter criteria structure
 */
export abstract class DeleteStatement<FilterType> extends FilterableStatement<
  FilterType,
  FilterType
> {
  /**
   * Creates an instance of DeleteStatement.
   * Initializes the statement with a table name and database connection.
   *
   * @param {string} tableName - The name of the table to delete from
   * @param {Database} db - The database instance to execute queries against
   * @memberof DeleteStatement
   */
  constructor(tableName: string, db: Database) {
    super(tableName, db);
  }
}
