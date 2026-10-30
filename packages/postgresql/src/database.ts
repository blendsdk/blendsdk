import { AsyncLocalStorage } from 'node:async_hooks';
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
 * PostgreSQL transaction isolation levels accepted by {@link PostgreSQLDatabase.withTransaction}.
 *
 * The value is validated against this allowlist before it is rendered into SQL, so a caller can
 * never inject arbitrary text through the isolation option.
 *
 * @export
 * @type {TransactionIsolation}
 */
export type TransactionIsolation = 'read committed' | 'repeatable read' | 'serializable';

/**
 * Optional settings for one PostgreSQL transaction.
 *
 * @export
 * @interface TransactionOptions
 */
export interface TransactionOptions {
  /**
   * Isolation level for the transaction. Omit it to use PostgreSQL's default
   * (`read committed`).
   *
   * @type {TransactionIsolation}
   */
  isolation?: TransactionIsolation;
}

/**
 * Internal state carried through one transaction's async call chain.
 *
 * The `active` flag closes the context as soon as the callback settles. Detached tasks that
 * outlive the callback keep the async-local store, so they must be rejected instead of sending
 * SQL on a client that has already been returned to the pool.
 */
interface TransactionContext {
  /** Client that owns the transaction; cleared when the context closes. */
  client: PoolClient | null;
  /** True only while the transaction callback may still issue statements. */
  active: boolean;
}

/** SQL spelling for each accepted isolation level. */
const TRANSACTION_ISOLATION_SQL: Record<TransactionIsolation, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

/** True when an untrusted value is one of the accepted isolation levels. */
function isTransactionIsolation(value: unknown): value is TransactionIsolation {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(TRANSACTION_ISOLATION_SQL, value)
  );
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
   * The transaction client for the current async call chain.
   *
   * Async-local storage keeps transactions isolated when one database instance is shared by
   * concurrent requests: each `withTransaction()` call runs its callback inside its own context,
   * so one request can never read, commit, roll back, or release another request's client.
   *
   * @protected
   * @type {AsyncLocalStorage<TransactionContext>}
   * @memberof PostgreSQLDatabase
   */
  protected readonly transactionContext = new AsyncLocalStorage<TransactionContext>();

  /**
   * Read-only compatibility accessor for the active transaction client.
   *
   * The shared mutable field was removed so concurrent requests cannot overwrite each other.
   * Subclasses that only read the former field keep working inside a transaction callback; the
   * accessor returns `null` outside one. Assigning to it is no longer supported.
   *
   * @deprecated Read the client from the active transaction context instead. This accessor exists
   * only for source compatibility with subclasses that read the former protected field.
   * @protected
   * @type {(PoolClient | null)}
   * @memberof PostgreSQLDatabase
   */
  protected get transactionClient(): PoolClient | null {
    const context = this.transactionContext.getStore();
    return context?.active && !this.isShuttingDown ? context.client : null;
  }

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
   * Executes a function within an isolated database transaction.
   *
   * Each call acquires its own pooled client and runs the callback inside an async-local
   * transaction context. Statements built from the callback argument (`tx`) therefore use that
   * client, while queries started outside the callback keep their own client. Automatically
   * handles BEGIN, COMMIT, and ROLLBACK and always returns the client to the pool exactly once.
   *
   * Nested calls on the same async call chain fail fast. PostgreSQL does not support nested
   * `BEGIN` blocks, and silently reusing the outer transaction would hide the mistake.
   *
   * Do not retain the callback argument after the callback settles. The transaction client is
   * returned to the pool at that point; a later call on the same handle runs as a new,
   * independent operation rather than joining the finished transaction.
   *
   * @template T - The return type of the transaction function
   * @param {(db: this) => Promise<T>} fn - The function to execute within the transaction context
   * @param {TransactionOptions} [options] - Optional isolation level for this transaction
   * @return {Promise<T>} Promise resolving to the result of the transaction function
   * @throws {Error} When the database is shutting down, a transaction is already active on the
   * same call chain, the isolation level is unsupported, or the callback fails
   * @memberof PostgreSQLDatabase
   *
   * @example
   * ```ts
   * await db.withTransaction(
   *   async (tx) => {
   *     await tx.executeQuery('INSERT INTO audit_events (message) VALUES (:message)', {
   *       message: 'created',
   *     });
   *   },
   *   { isolation: 'serializable' }
   * );
   * ```
   */
  async withTransaction<T>(fn: (db: this) => Promise<T>, options?: TransactionOptions): Promise<T> {
    // Prevent new transactions during shutdown
    if (this.isShuttingDown) {
      throw new Error('Cannot start transaction: database is shutting down');
    }

    const existingContext = this.transactionContext.getStore();
    if (existingContext) {
      throw new Error(
        existingContext.active
          ? 'Cannot start a nested transaction: a transaction is already active on this database handle.'
          : 'Cannot start a transaction from a completed transaction context.'
      );
    }

    if (
      options !== undefined &&
      (typeof options !== 'object' || options === null || Array.isArray(options))
    ) {
      throw new Error('Transaction options must be an object.');
    }
    const isolation = options?.isolation;
    if (isolation !== undefined && !isTransactionIsolation(isolation)) {
      throw new Error(
        'Unsupported transaction isolation level. Use "read committed", "repeatable read", or "serializable".'
      );
    }

    const client = await this.connect();
    const begin = isolation
      ? `BEGIN ISOLATION LEVEL ${TRANSACTION_ISOLATION_SQL[isolation]}`
      : 'BEGIN';
    let begun = false;
    let destroyClient = false;

    try {
      await client.query(begin);
      begun = true;
      const context: TransactionContext = { client, active: true };
      let result: T;
      try {
        result = await this.transactionContext.run(context, () => fn(this));
      } finally {
        // Detached tasks keep this async-local store after the callback settles.
        // Closing the context makes them fail instead of using a released client.
        context.active = false;
        context.client = null;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // Roll back only after a successful BEGIN. A failed BEGIN leaves no transaction to undo.
      if (begun) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection state is unknown; the pool must destroy it, not reuse it.
          destroyClient = true;
          console.error('Error during transaction rollback:', rollbackError);
        }
      } else {
        destroyClient = true;
      }
      throw error;
    } finally {
      try {
        client.release(destroyClient);
      } catch (releaseError) {
        console.error('Error releasing transaction client:', releaseError);
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
    const timeoutPromise = new Promise<void>(resolve => {
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
      await Promise.race([this.pool.end().then(() => clearTimeout(timeoutHandle)), timeoutPromise]);
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
    options = options || {};
    params = params || {};

    // Prevent new queries during shutdown
    if (this.isShuttingDown) {
      throw new Error('Cannot execute query: database is shutting down');
    }

    // Queries started inside a transaction callback use that transaction's client.
    // Queries started anywhere else acquire a client that only this call owns, so
    // concurrent requests can never share (or release) each other's connection.
    const transactionContext = this.transactionContext.getStore();
    if (transactionContext) {
      if (!transactionContext.active || !transactionContext.client) {
        throw new Error(
          'Cannot execute a query after the transaction has completed. Do not use the transaction handle outside its callback.'
        );
      }
      return this.executeOnClient<R>(transactionContext.client, query, params, options);
    }

    const client = await this.connect();
    try {
      return await this.executeOnClient<R>(client, query, params, options);
    } finally {
      try {
        client.release();
      } catch (releaseError) {
        console.error('Error releasing query client:', releaseError);
      }
    }
  }

  /**
   * Executes one parameterized query on a specific pooled client.
   *
   * The caller owns the client lifecycle. This helper only applies the query hooks, converts
   * named parameters to PostgreSQL positional parameters, and normalizes the driver result.
   *
   * @template R - The record shape returned to the caller
   * @param {PoolClient} client - Client that must execute this query
   * @param {string} query - SQL text with optional named parameters
   * @param {Record<string, any>} params - Named parameter values
   * @param {ExecuteQueryOptions} options - Query hooks
   * @return {Promise<PostgreSQLQueryResult<R>>} Normalized query result
   * @memberof PostgreSQLDatabase
   */
  protected async executeOnClient<R>(
    client: PoolClient,
    query: string,
    params: Record<string, any>,
    options: ExecuteQueryOptions
  ): Promise<PostgreSQLQueryResult<R>> {
    let queryParams = params;

    // Apply beforeQuery hook if provided to transform parameters
    if (options.beforeQuery) {
      queryParams = options.beforeQuery(queryParams);
    }

    // Convert named parameters to positional parameters for PostgreSQL
    const { text, values } = named(query)(queryParams as AnyParams);

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
