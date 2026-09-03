import { Database, ExecuteQueryOptions, QueryResult } from './database.js';

/**
 * Abstract base class for all SQL statement builders.
 * Provides common functionality for building and executing database queries,
 * including parameter handling, query execution, and result processing.
 * 
 * This class implements the builder pattern, allowing for fluent method chaining
 * when constructing database queries. Concrete implementations must provide
 * the specific query building logic for their statement type.
 * 
 * @export
 * @abstract
 * @class Statement
 * @template TableType - The type representing the table structure this statement operates on
 */
export abstract class Statement<TableType = any> {
  /**
   * Handler function to transform parameters before query execution.
   * Set via the beforeQuery() method to enable parameter preprocessing.
   * 
   * @protected
   * @type {((params: any) => any) | null}
   * @memberof Statement
   */
  protected _beforeQuery: ((params: any) => any) | null;

  /**
   * Handler function to transform result rows after query execution.
   * Set via the afterQuery() method to enable result postprocessing
   * (e.g., data transformation, filtering, or augmenting returned records).
   * 
   * @protected
   * @type {((rows: any) => any) | null}
   * @memberof Statement
   */
  protected _afterQuery: ((rows: any) => any) | null;

  /**
   * Creates an instance of Statement.
   * Initializes the statement with a database connection and sets up
   * parameter transformation handlers to null.
   * 
   * @param {Database} db - The database instance to execute queries against
   * @memberof Statement
   */
  constructor(protected db: Database) {
    this._beforeQuery = null;
    this._afterQuery = null;
  }

  /**
   * Builds the SQL query string for this statement.
   * Must be implemented by concrete statement classes to generate
   * the appropriate SQL syntax for their operation type.
   * 
   * @protected
   * @abstract
   * @return {string} The SQL query string
   * @memberof Statement
   */
  protected abstract buildQuery(): string;

  /**
   * Builds the parameter object for this statement's query.
   * Must be implemented by concrete statement classes to provide
   * the parameters needed for their specific query.
   * 
   * @protected
   * @abstract
   * @return {any} The parameters object for the query
   * @memberof Statement
   */
  protected abstract buildParameters(): any;

  /**
   * Executes the statement and returns the query result.
   * Builds the query and parameters, applies any registered parameter handlers,
   * and executes the query through the database connection.
   * 
   * @template R - The type of QueryResult expected, defaults to QueryResult<any>
   * @return {Promise<R | null>} Promise resolving to the query result or null
   * @memberof Statement
   */
  execute<R extends QueryResult<any> = QueryResult<any>>(): Promise<R | null> {
    const options: ExecuteQueryOptions = {};
    if (this._beforeQuery) {
      options.beforeQuery = this._beforeQuery;
    }
    if (this._afterQuery) {
      options.afterQuery = this._afterQuery;
    }

    return this.db.executeQuery(
      this.buildQuery(),
      this.buildParameters(),
      options
    ) as Promise<R | null>;
  }

  /**
   * Executes the statement and returns the first record from the result.
   * Useful for queries expected to return a single row, such as SELECT with LIMIT 1
   * or queries filtering by unique identifiers.
   * 
   * @return {Promise<Partial<TableType> | null>} Promise resolving to the first record or null if no records found
   * @memberof Statement
   */
  async executeReturnSingle(): Promise<Partial<TableType> | null> {
    const result = await this.execute();
    return result?.records[0] || null;
  }

  /**
   * Executes the statement and returns all records from the result.
   * Returns an empty array if no records are found.
   * 
   * @return {Promise<Partial<TableType>[]>} Promise resolving to an array of all records
   * @memberof Statement
   */
  async executeReturnAll(): Promise<Partial<TableType>[]> {
    const result = await this.execute();
    return (result?.records || []) as Partial<TableType>[];
  }

  /**
   * Executes the statement and returns the number of affected rows.
   * Useful for INSERT, UPDATE, and DELETE operations where you need to know
   * how many rows were modified.
   * 
   * @return {Promise<number>} Promise resolving to the count of affected rows
   * @memberof Statement
   */
  async executeReturnCount(): Promise<number> {
    const result = await this.execute();
    return result?.rowCount || 0;
  }

  /**
   * Registers a handler to transform parameters before query execution.
   * The handler receives the parameters object and must return a transformed version.
   * Useful for parameter validation, sanitization, or transformation before the query runs.
   * 
   * @template T - The type of the parameters object
   * @param {(params: T) => T} handler - The transformation function to apply before query execution
   * @return {this} The statement instance for method chaining
   * @memberof Statement
   */
  beforeQuery<T>(handler: (params: T) => T): this {
    this._beforeQuery = handler;
    return this;
  }

  /**
   * Registers a handler to transform result rows after query execution.
   * The handler receives the query result rows array and must return a transformed version.
   * Useful for data transformation, field mapping, or post-processing of returned records.
   * 
   * @template T - The type of the result rows array
   * @param {(rows: T) => T} handler - The transformation function to apply to result rows
   * @return {this} The statement instance for method chaining
   * @memberof Statement
   *
   * @example
   * // Convert all date strings to Date objects
   * statement.afterQuery((rows) =>
   *   rows.map(row => ({ ...row, created_at: new Date(row.created_at) }))
   * )
   */
  afterQuery<T>(handler: (rows: T) => T): this {
    this._afterQuery = handler;
    return this;
  }
}
