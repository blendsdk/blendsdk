import { DeleteStatement } from './delete-statement.js';
import { FromStatement } from './from-statement.js';
import { InsertStatement } from './insert-statement.js';
import { UpdateStatement } from './update-statement.js';

/**
 * Handler function type for transforming query parameters before query execution.
 * Allows modification of parameter objects before the query is sent to the database.
 * 
 * @export
 * @callback QueryParamHandler
 * @param {Record<string, any>} params - The parameter object to transform
 * @return {Record<string, any>} The transformed parameter object
 */
export type QueryParamHandler = (params: Record<string, any>) => Record<string, any>;

/**
 * Handler function type for transforming query result rows after execution.
 * Allows modification of result data before it is returned to the caller.
 * 
 * @export
 * @callback QueryResultHandler
 * @param {any[]} rows - The result rows array to transform
 * @return {any[]} The transformed rows array
 */
export type QueryResultHandler = (rows: any[]) => any[];

/**
 * Configuration options for executing database queries.
 * Provides hooks for parameter transformation at different stages of query execution.
 * 
 * @export
 * @interface ExecuteQueryOptions
 */
export interface ExecuteQueryOptions {
  /**
   * Handler function called before query execution to transform parameters.
   * Useful for parameter validation, sanitization, or transformation.
   * 
   * @type {QueryParamHandler}
   * @memberof ExecuteQueryOptions
   */
  beforeQuery?: QueryParamHandler;

  /**
   * Handler function called after query execution to transform result rows.
   * Receives the raw result rows array and returns a transformed version.
   * Useful for data transformation, field mapping, or post-processing of returned records.
   * 
   * @type {QueryResultHandler}
   * @memberof ExecuteQueryOptions
   */
  afterQuery?: QueryResultHandler;
}

/**
 * Configuration settings for establishing a database connection.
 * Contains all necessary connection parameters for database initialization.
 * 
 * @export
 * @interface DatabaseConfig
 */
export interface DatabaseConfig {
  /**
   * The hostname or IP address of the database server.
   * 
   * @type {string}
   * @memberof DatabaseConfig
   */
  host?: string;

  /**
   * The name of the database to connect to.
   * 
   * @type {string}
   * @memberof DatabaseConfig
   */
  database?: string;

  /**
   * The port number on which the database server is listening.
   * Can be provided as a string or number.
   * 
   * @type {(string | number)}
   * @memberof DatabaseConfig
   */
  port?: string | number;

  /**
   * The username for database authentication.
   * 
   * @type {string}
   * @memberof DatabaseConfig
   */
  user?: string;

  /**
   * The password for database authentication.
   * 
   * @type {string}
   * @memberof DatabaseConfig
   */
  pass?: string;
}

/**
 * Represents the result of a database query execution.
 * Contains both the returned records and metadata about the query execution.
 * 
 * @export
 * @interface QueryResult
 * @template T - The type of records returned by the query
 */
export interface QueryResult<T> {
  /**
   * Array of records returned by the query.
   * Each record is of type T as specified by the generic parameter.
   * 
   * @type {T[]}
   * @memberof QueryResult
   */
  records: T[];

  /**
   * The number of rows affected or returned by the query.
   * For SELECT queries, this is the number of rows returned.
   * For INSERT/UPDATE/DELETE queries, this is the number of rows affected.
   * 
   * @type {number}
   * @memberof QueryResult
   */
  rowCount: number;
}

/**
 * Abstract base class for database implementations.
 * Provides a unified interface for database operations including connection management,
 * query execution, and CRUD statement builders. Concrete implementations must provide
 * database-specific logic for connection handling and query execution.
 * 
 * This class serves as the foundation for all database adapters in the system,
 * ensuring consistent API across different database backends (PostgreSQL, MySQL, etc.).
 * 
 * @export
 * @abstract
 * @class Database
 */
export abstract class Database {
  /**
   * Creates an instance of Database with the provided configuration.
   * Stores the configuration for later use during connection establishment.
   * 
   * @param {DatabaseConfig} config - The database connection configuration
   * @memberof Database
   */
  constructor(protected config: DatabaseConfig) {
    // Config is automatically assigned via TypeScript parameter property
  }

  /**
   * Establishes a connection to the database using the provided configuration.
   * Must be implemented by concrete database classes to handle database-specific
   * connection logic.
   * 
   * @abstract
   * @return {Promise<any>} Promise resolving to the database connection object
   * @memberof Database
   */
  abstract connect(): Promise<any>;

  /**
   * Closes the database connection and releases associated resources.
   * Must be implemented by concrete database classes to handle proper cleanup
   * and connection termination.
   * 
   * @abstract
   * @param {number} [timeoutMs] - Optional maximum time in milliseconds to wait for graceful shutdown
   * @return {Promise<void>} Promise resolving when disconnection is complete
   * @memberof Database
   */
  abstract disconnect(timeoutMs?: number): Promise<void>;

  /**
   * Executes a SQL query without parameters.
   * 
   * @abstract
   * @template R - The type of records expected in the query result
   * @param {string} query - The SQL query string to execute
   * @return {Promise<QueryResult<R> | null>} Promise resolving to query results or null
   * @memberof Database
   */
  abstract executeQuery<R>(query: string): Promise<QueryResult<R> | null>;

  /**
   * Executes a SQL query with parameterized values.
   * 
   * @abstract
   * @template R - The type of records expected in the query result
   * @param {string} query - The SQL query string to execute
   * @param {Record<string, any>} [params] - Optional parameters for the query
   * @return {Promise<QueryResult<R> | null>} Promise resolving to query results or null
   * @memberof Database
   */
  abstract executeQuery<R>(
    query: string,
    params?: Record<string, any>
  ): Promise<QueryResult<R> | null>;

  /**
   * Executes a SQL query with parameterized values and execution options.
   * Provides hooks for parameter transformation before and after query execution.
   * 
   * @abstract
   * @template R - The type of records expected in the query result
   * @param {string} query - The SQL query string to execute
   * @param {Record<string, any>} params - Parameters for the query
   * @param {ExecuteQueryOptions} [options] - Optional execution configuration
   * @return {Promise<QueryResult<R> | null>} Promise resolving to query results or null
   * @memberof Database
   */
  abstract executeQuery<R>(
    query: string,
    params: Record<string, any>,
    options?: ExecuteQueryOptions
  ): Promise<QueryResult<R> | null>;

  /**
   * Executes a function within a database transaction.
   * Ensures that all operations within the function are executed atomically.
   * If the function throws an error, the transaction is rolled back.
   * If the function completes successfully, the transaction is committed.
   * 
   * @abstract
   * @template T - The return type of the transaction function
   * @param {(db: this) => Promise<T>} fn - The function to execute within the transaction
   * @return {Promise<T>} Promise resolving to the function's return value
   * @memberof Database
   */
  abstract withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T>;

  /**
   * Creates an INSERT statement builder for the specified table.
   * Must be implemented by concrete database classes to provide database-specific
   * INSERT statement construction.
   * 
   * @abstract
   * @template T - The type representing the table structure
   * @param {string} tableName - The name of the table to insert into
   * @return {InsertStatement<T>} An INSERT statement builder instance
   * @memberof Database
   */
  abstract insert<T>(tableName: string): InsertStatement<T>;

  /**
   * Creates an UPDATE statement builder for the specified table.
   * Must be implemented by concrete database classes to provide database-specific
   * UPDATE statement construction.
   * 
   * @abstract
   * @template T - The type representing the table structure
   * @template F - The type representing the filter criteria structure
   * @param {string} tableName - The name of the table to update
   * @return {UpdateStatement<T, F>} An UPDATE statement builder instance
   * @memberof Database
   */
  abstract update<T, F>(tableName: string): UpdateStatement<T, F>;

  /**
   * Creates a DELETE statement builder for the specified table.
   * Must be implemented by concrete database classes to provide database-specific
   * DELETE statement construction.
   * 
   * @abstract
   * @template F - The type representing the filter criteria structure
   * @param {string} tableName - The name of the table to delete from
   * @return {DeleteStatement<F>} A DELETE statement builder instance
   * @memberof Database
   */
  abstract delete<F>(tableName: string): DeleteStatement<F>;

  /**
   * Selects all records from the specified table.
   * Returns a FromStatement configured to select all columns.
   * 
   * @template T - The type representing the table structure
   * @param {string} tableName - The name of the table to select from
   * @return {FromStatement<T>} A FROM statement builder configured to select all columns
   * @memberof Database
   */
  selectAll<T>(tableName: string): FromStatement<T> {
    return this.from<T>(tableName).select();
  }

  /**
   * Creates a SELECT statement builder for the specified table.
   * Provides a fluent interface for constructing SELECT queries with various clauses.
   * 
   * @template T - The type representing the table structure
   * @param {string} tableName - The name of the table to select from
   * @return {FromStatement<T>} A FROM statement builder instance
   * @memberof Database
   */
  from<T>(tableName: string): FromStatement<T> {
    return new FromStatement<T>(tableName, this);
  }
}
