# Connection Pool Management

This document describes the enhanced connection pool management features added to the PostgreSQL database package.

## Overview

The PostgreSQL database class now includes robust connection pool management features to prevent connection leaks and ensure graceful shutdown. All new features are **100% backward compatible** - existing code will continue to work without any changes.

## New Features

### 1. Pool Configuration

You can now configure the connection pool behavior with optional settings:

```typescript
import { PostgreSQLDatabase, PostgreSQLConfig } from '@blendsdk/postgresql';

const config: PostgreSQLConfig = {
  host: 'localhost',
  port: '5432',
  user: 'myuser',
  pass: 'mypassword',
  database: 'mydb',
  // Optional pool configuration
  poolConfig: {
    max: 20,                      // Maximum number of clients (default: 10)
    idleTimeoutMillis: 60000,     // Close idle connections after 60s (default: 30000)
    connectionTimeoutMillis: 5000 // Timeout when acquiring connection (default: 0)
  }
};

const db = new PostgreSQLDatabase(config);
```

### 2. Enhanced disconnect() with Timeout Protection

The `disconnect()` method now includes timeout protection to prevent hanging on unreleased connections:

```typescript
// Use default 10-second timeout
await db.disconnect();

// Or specify custom timeout
await db.disconnect(5000); // 5 seconds
```

**How it works:**
- Attempts graceful shutdown first
- If timeout is exceeded, warns about unreleased clients
- Forces connection closure to prevent hanging
- Throws error after forcing closure (so you know there was an issue)

### 3. Shutdown Protection

The database now prevents new operations during shutdown:

```typescript
const disconnectPromise = db.disconnect();

// These will throw errors:
await db.executeQuery('SELECT 1'); 
// Error: Cannot execute query: database is shutting down

await db.withTransaction(async (txDb) => { ... });
// Error: Cannot start transaction: database is shutting down
```

### 4. Graceful Shutdown Handlers (Opt-in)

Automatically handle SIGINT/SIGTERM signals for clean shutdown:

```typescript
const config: PostgreSQLConfig = {
  // ... other config
  enableGracefulShutdown: true  // Opt-in feature
};

const db = new PostgreSQLDatabase(config);

// Now Ctrl+C or kill signals will:
// 1. Log shutdown message
// 2. Call disconnect()
// 3. Exit cleanly
```

### 5. Improved Error Handling

Better error handling in transactions and queries:

```typescript
// Transaction errors are handled gracefully
try {
  await db.withTransaction(async (txDb) => {
    await txDb.executeQuery('SELECT 1');
    throw new Error('Something went wrong');
  });
} catch (error) {
  // Transaction is automatically rolled back
  // Client is properly released
  // You can continue using the database
}

// Same for query errors
try {
  await db.executeQuery('INVALID SQL');
} catch (error) {
  // Client is properly released
  // You can continue using the database
}
```

## Backward Compatibility

All new features are **completely backward compatible**:

- Existing code works without any changes
- All new configuration options are optional
- Default behavior is preserved
- `disconnect()` can still be called without parameters
- No breaking changes to any existing APIs

## Usage Examples

### Basic Usage (No Changes Required)

```typescript
// Your existing code continues to work exactly as before
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: '5432',
  user: 'myuser',
  pass: 'mypassword',
  database: 'mydb'
});

await db.executeQuery('SELECT * FROM users');
await db.disconnect();
```

### With Pool Configuration

```typescript
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: '5432',
  user: 'myuser',
  pass: 'mypassword',
  database: 'mydb',
  poolConfig: {
    max: 50,                   // Support more concurrent connections
    idleTimeoutMillis: 30000,  // Close idle connections faster
    connectionTimeoutMillis: 3000 // Fail fast if pool is exhausted
  }
});
```

### With Graceful Shutdown

```typescript
const db = new PostgreSQLDatabase({
  host: 'localhost',
  port: '5432',
  user: 'myuser',
  pass: 'mypassword',
  database: 'mydb',
  enableGracefulShutdown: true  // Handle SIGINT/SIGTERM
});

// Your application will now shut down cleanly when:
// - User presses Ctrl+C
// - Process receives SIGTERM (e.g., from Docker, Kubernetes)
// - Process receives SIGINT
```

### With Custom Disconnect Timeout

```typescript
// Give more time for long-running queries to complete
await db.disconnect(30000); // 30 seconds

// Or fail fast in development
await db.disconnect(1000); // 1 second
```

## Best Practices

1. **Always call disconnect()** when your application shuts down
2. **Use poolConfig** to tune for your workload:
   - High traffic: increase `max`
   - Memory constrained: decrease `max` and `idleTimeoutMillis`
   - Fast failure: set `connectionTimeoutMillis`
3. **Enable graceful shutdown** in production applications
4. **Set appropriate disconnect timeout** based on your query patterns
5. **Monitor for timeout warnings** - they indicate connection leaks

## Troubleshooting

### "Disconnect timeout exceeded" Warning

This warning indicates that some database clients were not properly released. Common causes:

1. **Forgotten client release in error handling**
   - Solution: Use try/finally blocks or the improved error handling

2. **Long-running queries**
   - Solution: Increase disconnect timeout or cancel queries before shutdown

3. **Connection leaks in application code**
   - Solution: Review code for unreleased connections

### Connection Pool Exhausted

If you see connection timeout errors:

1. Increase `poolConfig.max`
2. Decrease `poolConfig.idleTimeoutMillis`
3. Review application for connection leaks
4. Consider connection pooling at application level

## Migration Guide

No migration needed! All existing code continues to work. To adopt new features:

1. **Add pool configuration** (optional):
   ```typescript
   poolConfig: { max: 20 }
   ```

2. **Enable graceful shutdown** (recommended for production):
   ```typescript
   enableGracefulShutdown: true
   ```

3. **Update disconnect calls** (optional):
   ```typescript
   await db.disconnect(15000); // with timeout
   ```

## Technical Details

### Connection Lifecycle

1. **Acquisition**: Connections are acquired from the pool on demand
2. **Usage**: Used for queries or transactions
3. **Release**: Automatically released after use (even on errors)
4. **Idle Management**: Idle connections are closed based on `idleTimeoutMillis`
5. **Shutdown**: All connections are closed during disconnect

### Error Recovery

The implementation ensures proper cleanup in all error scenarios:

- Query errors: Client is released, can continue using database
- Transaction errors: Automatic rollback, client released
- Connection errors: Logged, client marked as failed
- Shutdown errors: Forced closure, warnings logged

### Thread Safety

The PostgreSQL client library (pg) handles connection pool thread safety internally. This implementation adds additional safety:

- Shutdown flag prevents new operations during disconnect
- Transaction client is properly managed per-instance
- Error handlers ensure cleanup even in exceptional cases
