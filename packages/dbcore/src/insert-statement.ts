import { CrudStatement } from './crud-statement.js';
import { Database } from './database.js';

/**
 * Abstract statement builder for INSERT operations.
 * Extends CrudStatement to provide functionality for inserting new records into database tables.
 * Concrete database implementations must extend this class to provide database-specific
 * INSERT query construction and parameter handling.
 * 
 * This class provides a fluent interface for building INSERT statements with support
 * for RETURNING clauses to retrieve inserted data.
 * 
 * @export
 * @abstract
 * @class InsertStatement
 * @extends {CrudStatement<TableType>}
 * @template TableType - The type representing the table structure for insertion
 */
export abstract class InsertStatement<TableType> extends CrudStatement<TableType> {
  /**
   * Creates an instance of InsertStatement.
   * Initializes the statement with a table name and database connection.
   * 
   * @param {string} tableName - The name of the table to insert into
   * @param {Database} db - The database instance to execute queries against
   * @memberof InsertStatement
   */
  constructor(tableName: string, db: Database) {
    super(tableName, db);
  }

  /**
   * Sets the values to be inserted into the table.
   * Accepts a partial object where keys represent column names and values
   * represent the data to be inserted. Only the specified columns will be
   * included in the INSERT statement.
   * 
   * @param {Partial<TableType>} values - Object containing column names and values to insert
   * @return {this} The statement instance for method chaining
   * @memberof InsertStatement
   * 
   * @example
   * // Insert a new user record
   * statement.values({
   *   name: 'John Doe',
   *   email: 'john@example.com',
   *   age: 30
   * })
   */
  values(values: Partial<TableType>): this {
    this._values = values;
    return this;
  }
}
