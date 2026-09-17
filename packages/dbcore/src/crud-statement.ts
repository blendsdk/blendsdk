import { Database } from './database.js';
import { Statement } from './statement.js';

/**
 * Abstract base class for CRUD (Create, Read, Update, Delete) statement builders.
 * Extends the Statement class to provide common functionality for INSERT, UPDATE,
 * and DELETE operations, including support for RETURNING clauses and value management.
 * 
 * This class serves as the foundation for all data modification statements,
 * providing shared functionality for handling values and return fields.
 * 
 * @export
 * @abstract
 * @class CrudStatement
 * @extends {Statement<TableType>}
 * @template TableType - The type representing the table structure this statement operates on
 */
export abstract class CrudStatement<TableType> extends Statement<TableType> {
  /**
   * Array of field names to return after the operation completes.
   * Used to construct the RETURNING clause in SQL statements.
   * Can contain specific field names or '*' to return all fields.
   * 
   * @protected
   * @type {string[]}
   * @memberof CrudStatement
   */
  protected _returning: string[];

  /**
   * Object containing the values to be inserted or updated.
   * Keys represent column names and values represent the data to be stored.
   * 
   * @protected
   * @type {Partial<TableType>}
   * @memberof CrudStatement
   */
  protected _values: Partial<TableType>;

  /**
   * Creates an instance of CrudStatement.
   * Initializes the statement with a table name and database connection,
   * and sets up empty arrays/objects for returning fields and values.
   * 
   * @param {string} tableName - The name of the table this statement operates on
   * @param {Database} db - The database instance to execute queries against
   * @memberof CrudStatement
   */
  constructor(
    protected tableName: string,
    db: Database
  ) {
    super(db);
    this._returning = [];
    this._values = {};
  }

  /**
   * Specifies which fields should be returned after the operation completes.
   * Adds a RETURNING clause to the SQL statement, which is useful for getting
   * auto-generated values (like IDs) or confirming the final state of modified records.
   * 
   * @param {(keyof TableType)[] | '*'} fields - Array of field names to return, or '*' for all fields
   * @return {this} The statement instance for method chaining
   * @memberof CrudStatement
   * 
   * @example
   * // Return specific fields
   * statement.returning(['id', 'created_at'])
   * 
   * @example
   * // Return all fields
   * statement.returning('*')
   */
  returning(fields: (keyof TableType)[] | '*'): this {
    const fld = fields === '*' ? ['*'] : (fields as string[]);
    this._returning = fld;
    return this;
  }
}
