import {
  Database,
  DatabaseConfig,
  DeleteStatement,
  ExecuteQueryOptions,
  InsertStatement,
  QueryResult,
  UpdateStatement,
} from '@blendsdk/dbcore';
import { FieldDef, Pool, PoolClient } from 'pg';
import { AnyParams, pg as named } from 'yesql';
import { PostgreSQLDeleteStatement } from './delete-statement.js';
import { PostgreSQLInsertStatement } from './insert-statement.js';
import { PostgreSQLUpdateStatement } from './update-statement.js';

/**
 * Configuration options for the PostgreSQL connection pool.
 * All properties are optional and have sensible defaults.
 *
 * @export
 * @interface PoolConfig
 */
export interface PoolConfig {
  /**
   * Maximum number of clients in the pool (default: 10)
   * @type {number}
   */
  max?: number;
  /**
   * Number of milliseconds a client must sit idle before being closed (default: 30000)
   * @type {number}
   */
  idleTimeoutMillis?: number;
  /**
   * Number of milliseconds to wait before timing out when connecting a new client (default: 0 - no timeout)
   * @type {number}
   */
  connectionTimeoutMillis?: number;
}

/**
 * Defines the configuration options for PostgreSQL database connections.
 * Extends the base DatabaseConfig with PostgreSQL-specific settings.
 *
 * @export
 * @interface PostgreSQLConfig
 * @extends {DatabaseConfig}
 */
export interface PostgreSQLConfig extends DatabaseConfig {
  /**
   * Optional pool configuration for connection management
   * @type {PoolConfig}
   */
  poolConfig?: PoolConfig;
  /**
   * Enable automatic graceful shutdown handlers for SIGINT/SIGTERM (default: false).
   *
   * **⚠️ WARNING:** Do NOT enable this when the database is managed by a WebApplication
   * (from `@blendsdk/webafx`), which has its own shutdown handling via SIGTERM/SIGINT.
   * Enabling both will cause signal handler conflicts and unpredictable shutdown behavior.
   * Only enable this for standalone database usage outside of the web framework.
   *
   * @type {boolean}
   */
  enableGracefulShutdown?: boolean;
}

/**
 * Represents the result of a PostgreSQL query execution.
 * Extends the base QueryResult with PostgreSQL-specific field definitions.
 *
 * @export
 * @interface PostgreSQLQueryResult
 * @template T - The type of records returned by the query
 * @extends {QueryResult<T>}
 */
export interface PostgreSQLQueryResult<T> extends QueryResult<T> {
  /**
   * Array of field definitions describing the structure of returned columns
   * @type {FieldDef[]}
   */
  fields: FieldDef[];
}

/**
 * Provides PostgreSQL database connectivity and query execution capabilities.
 * Manages connection pooling, transactions, and statement creation for PostgreSQL databases.
 * Extends the base Database class with PostgreSQL-specific implementations.
 *
 * @export
 * @class PostgreSQLDatabase
 * @extends {Database}
 */
export class PostgreSQLDatabase extends Database {
  /**
   * The PostgreSQL connection pool for managing database connections
   * @protected
   * @type {Pool}
   * @memberof PostgreSQLDatabase
   */
  protected pool: Pool;

  /**
   * The current transaction client, null when no transaction is active
   * @protected
   * @type {(PoolClient | null)}
   * @memberof PostgreSQLDatabase
   */
  protected transactionClient: PoolClient | null = null;

  /**
   * Flag to prevent new connections during shutdown
   * @protected
   * @type {boolean}
   * @memberof PostgreSQLDatabase
   */
  protected isShuttingDown: boolean = false;

  /**
   * Creates an instance of PostgreSQLDatabase.
   * Initializes the connection pool with the provided configuration settings.
   *
   * @param {PostgreSQLConfig} config - The database configuration including host, port, credentials, and database name
   * @memberof PostgreSQLDatabase
   */
  constructor(config: PostgreSQLConfig) {
    super(config);
    const { database, host, pass, port, user, poolConfig } = this.config as PostgreSQLConfig;

    // Initialize the PostgreSQL connection pool with configuration parameters
    this.pool = new Pool({
      database,
      host,
      password: pass,
      port: port ? Number(port) : undefined,
      user,
      // Apply optional pool configuration with sensible defaults
      max: poolConfig?.max,
      idleTimeoutMillis: poolConfig?.idleTimeoutMillis,
      connectionTimeoutMillis: poolConfig?.connectionTimeoutMillis,
    });

    // Register graceful shutdown handlers if enabled
    if (config.enableGracefulShutdown) {
      this.registerShutdownHandlers();
    }
  }

  /**
   * Executes a function within a database transaction context.
   * Automatically handles BEGIN, COMMIT, and ROLLBACK operations.
   * Ensures proper cleanup of transaction resources in all scenarios.
   *
   * @template T - The return type of the transaction function
   * @param {(db: this) => Promise<T>} fn - The function to execute within the transaction context
   * @return {Promise<T>} Promise resolving to the result of the transaction function
   * @throws {Error} When the transaction function fails, triggers automatic ROLLBACK
   * @memberof PostgreSQLDatabase
   */
  async withTransaction<T>(fn: (db: this) => Promise<T>): Promise<T> {
    // Prevent new transactions during shutdown
    if (this.isShuttingDown) {
      throw new Error('Cannot start transaction: database is shutting down');
    }

    // Acquire a client connection if not already in a transaction
    if (!this.transactionClient) {
      this.transactionClient = await this.connect();
    }

    let committed = false;
    try {
      // Begin the transaction
      await this.transactionClient?.query('BEGIN');
      // Execute the provided function within the transaction context
      const result = await fn(this);
      // Commit the transaction if successful
      await this.transactionClient?.query('COMMIT');
      committed = true;
      return result;
    } catch (error) {
      // Rollback the transaction on any error (only if not yet committed)
      if (this.transactionClient && !committed) {
        try {
          await this.transactionClient.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Error during transaction rollback:', rollbackError);
        }
      }
      throw error;
    } finally {
      // Always release the client connection and reset transaction state
      if (this.transactionClient) {
        try {
          this.transactionClient.release();
        } catch (releaseError) {
          console.error('Error releasing transaction client:', releaseError);
        }
        this.transactionClient = null;
      }
    }
  }

  /**
   * Acquires a client connection from the connection pool.
   * Used internally for transaction management and query execution.
   *
   * @return {Promise<PoolClient>} Promise resolving to a PostgreSQL client connection
   * @memberof PostgreSQLDatabase
   */
  connect(): Promise<PoolClient> {
    return this.pool.connect();
  }

  /**
   * Closes all connections in the pool and terminates the database connection.
   * Implements timeout protection to prevent hanging on unreleased connections.
   * Should be called when the application is shutting down to ensure clean resource cleanup.
   *
   * @param {number} [timeoutMs=10000] - Maximum time to wait for graceful shutdown in milliseconds
   * @return {Promise<void>} Promise that resolves when all connections are closed
   * @throws {Error} When disconnect times out, after forcing connection closure
   * @memberof PostgreSQLDatabase
   */
  async disconnect(timeoutMs: number = 10000): Promise<void> {
    this.isShuttingDown = true;

    let timeoutHandle: NodeJS.Timeout;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(async () => {
        try {
          await this.forceDisconnect();
          resolve();
        } catch (err) {
          resolve(); // Still resolve to prevent hanging
        }
      }, timeoutMs);
    });

    try {
      await Promise.race([
        this.pool.end().then(() => clearTimeout(timeoutHandle)),
        timeoutPromise,
      ]);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Forcefully closes all connections in the pool without waiting for graceful shutdown.
   * This is a last resort method used when normal disconnect times out.
   * Warning: This may interrupt active queries and transactions.
   *
   * @protected
   * @return {Promise<void>} Promise that resolves when all connections are forcefully closed
   * @memberof PostgreSQLDatabase
   */
  protected async forceDisconnect(): Promise<void> {
    try {
      // Read existing clients (not assign empty array)
      const clients: PoolClient[] = (this.pool as any)._clients || [];

      for (const client of clients) {
        try {
          client.release(true); // Force release even if in transaction
        } catch {
          // Silently ignore release errors
        }
      }

      // Clear the clients array after releasing
      (this.pool as any)._clients = [];
    } catch {
      // Silently ignore any errors
    }
  }

  /**
   * Registers signal handlers for graceful shutdown on SIGINT and SIGTERM.
   * Automatically calls disconnect() when these signals are received.
   * Only registered if enableGracefulShutdown is true in config.
   *
   * @protected
   * @memberof PostgreSQLDatabase
   */
  protected registerShutdownHandlers(): void {
    const shutdownHandler = async (signal: string) => {
      console.log(`Received ${signal}. Closing database connections...`);
      try {
        await this.disconnect();
        console.log('Database connections closed successfully.');
        process.exit(0);
      } catch (error) {
        console.error('Error during graceful shutdown:', error);
        process.exit(1);
      }
    };

    process.on('SIGINT', () => shutdownHandler('SIGINT'));
    process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
  }

  /**
   * Executes a parameterized SQL query against the PostgreSQL database.
   * Handles named parameter substitution, transaction management, and query hooks.
   * Automatically manages connection acquisition and release for non-transactional queries.
   *
   * @template R - The type of records returned by the query
   * @param {string} query - The SQL query string with named parameters (e.g., :paramName)
   * @param {Record<string, any>} [params] - Object containing named parameter values
   * @param {ExecuteQueryOptions} [options] - Optional query execution options including beforeQuery and afterQuery hooks
   * @return {Promise<PostgreSQLQueryResult<R>>} Promise resolving to query results including records, row count, and field definitions
   * @throws {Error} When no database connection is available
   * @memberof PostgreSQLDatabase
   */
  async executeQuery<R>(
    query: string,
    params?: Record<string, any>,
    options?: ExecuteQueryOptions
  ): Promise<PostgreSQLQueryResult<R>> {
    let atomic = false;
    options = options || {};
    params = params || {};

    // Prevent new queries during shutdown
    if (this.isShuttingDown) {
      throw new Error('Cannot execute query: database is shutting down');
    }

    try {
      // Acquire a connection if not in a transaction (atomic operation)
      if (!this.transactionClient) {
        this.transactionClient = await this.connect();
        atomic = true;
      }

      const client = this.transactionClient;
      if (!client) {
        throw new Error('No database connection available.');
      }

      // Apply beforeQuery hook if provided to transform parameters
      if (options.beforeQuery) {
        params = options.beforeQuery(params);
      }

      // Convert named parameters to positional parameters for PostgreSQL
      const { text, values } = named(query as string)(params as AnyParams);

      // Execute the query with positional parameters
      const res = await client.query(text, values);

      // Return empty result set if no rows were affected
      if (res.rowCount === 0) {
        return { records: [], rowCount: 0, fields: [] };
      }

      // Apply afterQuery hook if provided to transform result rows
      if (options.afterQuery) {
        res.rows = options.afterQuery(res.rows as any) as any;
      }

      return {
        records: (res.rows as R[]) || [],
        rowCount: res.rowCount || 0,
        fields: res?.fields || [],
      };
    } finally {
      // Release connection if this was an atomic operation
      if (atomic && this.transactionClient) {
        try {
          this.transactionClient.release();
        } catch (releaseError) {
          console.error('Error releasing query client:', releaseError);
        }
        this.transactionClient = null;
      }
    }
  }

  /**
   * Creates a new INSERT statement builder for the specified table.
   * Provides a fluent interface for constructing INSERT queries.
   *
   * @template T - The type representing the table structure
   * @param {string} tableName - The name of the table to insert into
   * @return {InsertStatement<T>} A new INSERT statement builder instance
   * @memberof PostgreSQLDatabase
   */
  insert<T>(tableName: string): InsertStatement<T> {
    return new PostgreSQLInsertStatement<T>(tableName, this);
  }

  /**
   * Creates a new UPDATE statement builder for the specified table.
   * Provides a fluent interface for constructing UPDATE queries with filtering.
   *
   * @template T - The type representing the table structure
   * @template F - The type representing the filter criteria
   * @param {string} tableName - The name of the table to update
   * @return {UpdateStatement<T, F>} A new UPDATE statement builder instance
   * @memberof PostgreSQLDatabase
   */
  update<T, F>(tableName: string): UpdateStatement<T, F> {
    return new PostgreSQLUpdateStatement<T, F>(tableName, this);
  }

  /**
   * Creates a new DELETE statement builder for the specified table.
   * Provides a fluent interface for constructing DELETE queries with filtering.
   *
   * @template F - The type representing the filter criteria
   * @param {string} tableName - The name of the table to delete from
   * @return {DeleteStatement<F>} A new DELETE statement builder instance
   * @memberof PostgreSQLDatabase
   */
  delete<F>(tableName: string): DeleteStatement<F> {
    return new PostgreSQLDeleteStatement<F>(tableName, this);
  }

}
