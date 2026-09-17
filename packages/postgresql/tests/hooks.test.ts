import { describe, expect, test } from 'vitest';
import { PostgreSQLDatabase } from '../src/database.js';
import { connectionConfig } from './params.js';

interface TestUser {
  id?: number;
  name: string;
  email: string;
  password_hash?: string;
  age?: number;
  active?: boolean;
  created_at?: Date;
  updated_at?: Date;
  metadata?: Record<string, any>;
}

interface UserFilter {
  id?: number;
  email?: string;
  active?: boolean;
}

describe('Statement Hooks - onBeforeQuery', () => {
  test('transforms parameter values before query execution', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_before_hook (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert with beforeQuery hook that hashes password_hash value
      const insertedRecord = await transactionDb
        .insert<TestUser>('test_before_hook')
        .values({
          name: 'Hook Test User',
          email: 'hook@example.com',
          password_hash: 'plaintext123', // This will be transformed to hashed version
        })
        .beforeQuery((params: any) => {
          // Transform password_hash value to hashed version
          if (params.password_hash) {
            params.password_hash = `bcrypt_${params.password_hash}`;
          }
          return params;
        })
        .returning('*')
        .executeReturnSingle();

      return insertedRecord;
    });

    expect(result).toMatchObject({
      name: 'Hook Test User',
      email: 'hook@example.com',
      password_hash: 'bcrypt_plaintext123',
    });
    expect(result?.id).toBeDefined();
    expect(result?.created_at).toBeDefined();

    await db.disconnect();
  });

  test('converts TypeScript values to database format', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table with specific data types
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_type_conversion (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          metadata JSONB,
          tags TEXT[],
          active BOOLEAN,
          created_date DATE
        )
      `);

      // Insert with beforeQuery hook that converts values
      const insertedRecord = await transactionDb
        .insert<any>('test_type_conversion')
        .values({
          name: 'Type Test',
          metadata: { settings: { theme: 'dark' } },
          tags: ['tag1', 'tag2'],
          active: 'true', // String that will be converted to boolean
          created_date: 1672531200000, // Timestamp that will be converted to date string
        })
        .beforeQuery((params: any) => {
          const converted = { ...params };

          // Convert string 'true'/'false' to boolean
          if (typeof converted.active === 'string') {
            converted.active = converted.active === 'true';
          }

          // Convert timestamp to date string
          if (typeof converted.created_date === 'number') {
            converted.created_date = new Date(converted.created_date).toISOString().split('T')[0];
          }

          return converted;
        })
        .returning('*')
        .executeReturnSingle();

      return insertedRecord;
    });

    expect(result).toMatchObject({
      name: 'Type Test',
      metadata: { settings: { theme: 'dark' } },
      tags: ['tag1', 'tag2'],
      active: true,
      created_date: expect.any(Date), // PostgreSQL returns dates as Date objects
    });
    expect(result?.id).toBeDefined();

    await db.disconnect();
  });

  test('handles complex parameter value transformations', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_complex_transform (
          id SERIAL PRIMARY KEY,
          metadata JSONB,
          numeric_value DECIMAL(10,2),
          text_array TEXT[]
        )
      `);

      // Insert with complex value transformations
      const insertedRecord = await transactionDb
        .insert<any>('test_complex_transform')
        .values({
          metadata: { rawData: 'needs processing', timestamp: Date.now() },
          numeric_value: '123.456', // String that needs rounding
          text_array: 'item1,item2,item3', // Comma-separated string to convert to array
        })
        .beforeQuery((params: any) => {
          const transformed = { ...params };

          // Process metadata
          if (transformed.metadata && transformed.metadata.rawData) {
            transformed.metadata = {
              ...transformed.metadata,
              processedData: transformed.metadata.rawData.toUpperCase(),
              processedAt: new Date(transformed.metadata.timestamp).toISOString(),
            };
            delete transformed.metadata.rawData;
            delete transformed.metadata.timestamp;
          }

          // Round numeric value
          if (typeof transformed.numeric_value === 'string') {
            transformed.numeric_value =
              Math.round(parseFloat(transformed.numeric_value) * 100) / 100;
          }

          // Convert comma-separated string to array
          if (typeof transformed.text_array === 'string') {
            transformed.text_array = transformed.text_array.split(',');
          }

          return transformed;
        })
        .returning('*')
        .executeReturnSingle();

      return insertedRecord;
    });

    expect(result).toMatchObject({
      metadata: {
        processedData: 'NEEDS PROCESSING',
        processedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/),
      },
      numeric_value: '123.46', // Rounded and returned as string by PostgreSQL
      text_array: ['item1', 'item2', 'item3'],
    });
    expect(result?.id).toBeDefined();

    await db.disconnect();
  });

  test('beforeQuery hook works with update operations', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert initial data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_before_hook (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert initial data
      await transactionDb.executeQuery(
        'INSERT INTO test_update_before_hook (name, email, password_hash) VALUES (:name, :email, :password_hash)',
        { name: 'Update Test', email: 'update@example.com', password_hash: 'old_hash' }
      );

      // Update with beforeQuery hook that transforms password_hash value
      const updatedRecord = await transactionDb
        .update<TestUser, UserFilter>('test_update_before_hook')
        .values({
          name: 'Updated Name',
          password_hash: 'newpassword123', // Will be transformed to hashed version
        })
        .filter({ email: 'update@example.com' })
        .beforeQuery((params: any) => {
          // Transform password_hash value to hashed version (v_ prefix for UPDATE values)
          if (params.v_password_hash) {
            params.v_password_hash = `bcrypt_${params.v_password_hash}`;
          }
          return params;
        })
        .returning('*')
        .executeReturnSingle();

      return updatedRecord;
    });

    expect(result).toMatchObject({
      name: 'Updated Name',
      email: 'update@example.com',
      password_hash: 'bcrypt_newpassword123',
    });
    expect(result?.id).toBeDefined();

    await db.disconnect();
  });

  test('beforeQuery hook works with filter parameter transformations', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table and insert test data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_filter_transform (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          status VARCHAR(20) DEFAULT 'active'
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_filter_transform (name, email) VALUES (:name, :email)',
        { name: 'Filter Test', email: 'filter@example.com' }
      );

      // Delete with beforeQuery hook that transforms filter parameter values
      const deletedRecord = await transactionDb
        .delete<UserFilter>('test_filter_transform')
        .filter({ email: 'FILTER@EXAMPLE.COM' }) // Uppercase email that will be normalized
        .beforeQuery((params: any) => {
          // Normalize email filter to lowercase (expression parameters use p1, p2, etc.)
          if (params.p1) {
            params.p1 = params.p1.toLowerCase();
          }
          return params;
        })
        .returning('*')
        .executeReturnSingle();

      return deletedRecord;
    });

    expect(result).toMatchObject({
      name: 'Filter Test',
      email: 'filter@example.com',
      status: 'active',
    });
    expect(result?.id).toBeDefined();

    await db.disconnect();
  });

  test('handles null and undefined values in beforeQuery', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_null_before_hook (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          email VARCHAR(100),
          age INTEGER
        )
      `);

      // Insert with beforeQuery hook that handles null/undefined
      const insertedRecord = await transactionDb
        .insert<any>('test_null_before_hook')
        .values({
          name: 'Null Test',
          email: null,
          age: undefined,
        })
        .beforeQuery((params: any) => {
          const processed = { ...params };

          // Convert undefined to null for database consistency
          Object.keys(processed).forEach(key => {
            if (processed[key] === undefined) {
              processed[key] = null;
            }
          });

          return processed;
        })
        .returning('*')
        .executeReturnSingle();

      return insertedRecord;
    });

    expect(result).toMatchObject({
      name: 'Null Test',
      email: null,
      age: null,
    });
    expect(result?.id).toBeDefined();

    await db.disconnect();
  });
});

describe('Statement Hooks - onAfterQuery', () => {
  test('removes sensitive information from query results', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table with sensitive data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_after_hook (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          api_key VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data with sensitive information
      await transactionDb.executeQuery(
        'INSERT INTO test_after_hook (name, email, password_hash, api_key) VALUES (:name, :email, :password_hash, :api_key)',
        {
          name: 'Sensitive Test',
          email: 'sensitive@example.com',
          password_hash: 'hashed_secret123',
          api_key: 'secret_api_key_xyz',
        }
      );

      // Query with afterQuery hook that removes sensitive data
      const safeRecord = await transactionDb
        .delete<UserFilter>('test_after_hook')
        .filter({ email: 'sensitive@example.com' })
        .afterQuery((records: any[]) => {
          // Remove sensitive fields from all records
          return records.map(record => {
            const safe = { ...record };
            delete safe.password_hash;
            delete safe.api_key;
            return safe;
          });
        })
        .returning('*')
        .executeReturnSingle();

      return safeRecord;
    });

    expect(result).toMatchObject({
      name: 'Sensitive Test',
      email: 'sensitive@example.com',
    });
    expect(result?.id).toBeDefined();
    expect((result as any)?.created_at).toBeDefined();
    // Sensitive fields should be removed
    expect(result).not.toHaveProperty('password_hash');
    expect(result).not.toHaveProperty('api_key');

    await db.disconnect();
  });

  test('transforms database field values to TypeScript format', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table with database-specific values
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_value_transform (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          active BOOLEAN DEFAULT true,
          created_date DATE,
          metadata JSONB
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_value_transform (name, email, active, created_date, metadata) VALUES (:name, :email, :active, :created_date, :metadata)',
        {
          name: 'Transform Test',
          email: 'transform@example.com',
          active: true,
          created_date: '2023-01-01',
          metadata: { settings: { theme: 'light' } },
        }
      );

      // Query with afterQuery hook that transforms field values
      const transformedRecord = await transactionDb
        .delete<UserFilter>('test_value_transform')
        .filter({ email: 'transform@example.com' })
        .afterQuery((records: any[]) => {
          // Transform database values to TypeScript format
          return records.map(record => {
            const transformed = { ...record };

            // Convert date string to Date object
            if (transformed.created_date) {
              transformed.created_date = new Date(transformed.created_date);
            }

            // Add computed properties
            if (transformed.name && transformed.email) {
              transformed.displayName = `${transformed.name} <${transformed.email}>`;
            }

            // Transform boolean to string representation
            if (typeof transformed.active === 'boolean') {
              transformed.status = transformed.active ? 'ACTIVE' : 'INACTIVE';
            }

            return transformed;
          });
        })
        .returning('*')
        .executeReturnSingle();

      return transformedRecord;
    });

    expect(result).toMatchObject({
      name: 'Transform Test',
      email: 'transform@example.com',
      active: true,
      created_date: expect.any(Date),
      metadata: { settings: { theme: 'light' } },
      displayName: 'Transform Test <transform@example.com>',
      status: 'ACTIVE',
    });
    expect(result?.id).toBeDefined();

    await db.disconnect();
  });

  test('filters out sensitive fields from multiple records', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table with sensitive data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_multiple_sensitive (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          secret_token VARCHAR(255),
          public_info VARCHAR(100)
        )
      `);

      // Insert multiple records with sensitive data
      await transactionDb.executeQuery(
        `INSERT INTO test_multiple_sensitive (name, email, password_hash, secret_token, public_info) VALUES 
         (:name1, :email1, :password_hash1, :secret_token1, :public_info1),
         (:name2, :email2, :password_hash2, :secret_token2, :public_info2)`,
        {
          name1: 'User 1',
          email1: 'user1@example.com',
          password_hash1: 'hash1',
          secret_token1: 'token1',
          public_info1: 'info1',
          name2: 'User 2',
          email2: 'user2@example.com',
          password_hash2: 'hash2',
          secret_token2: 'token2',
          public_info2: 'info2',
        }
      );

      // Query all records with afterQuery hook that removes sensitive data
      const safeRecords = await transactionDb
        .delete<{}>('test_multiple_sensitive')
        .filter({}) // Delete all records
        .afterQuery((records: any[]) => {
          // Remove sensitive fields from all records
          return records.map(record => {
            const safe = { ...record };
            delete safe.password_hash;
            delete safe.secret_token;
            return safe;
          });
        })
        .returning('*')
        .executeReturnAll();

      return safeRecords;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    result.forEach((record, index) => {
      expect(record).toMatchObject({
        name: `User ${index + 1}`,
        email: `user${index + 1}@example.com`,
        public_info: `info${index + 1}`,
      });
      expect(record).toHaveProperty('id');
      // Sensitive fields should be removed
      expect(record).not.toHaveProperty('password_hash');
      expect(record).not.toHaveProperty('secret_token');
    });

    await db.disconnect();
  });

  test('applies conditional filtering based on user context', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table with role-based sensitive data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_role_filtering (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          salary DECIMAL(10,2),
          ssn VARCHAR(11),
          role VARCHAR(20) DEFAULT 'user'
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_role_filtering (name, email, salary, ssn, role) VALUES (:name, :email, :salary, :ssn, :role)',
        {
          name: 'Role Test',
          email: 'role@example.com',
          salary: 75000.0,
          ssn: '123-45-6789',
          role: 'employee',
        }
      );

      // Simulate admin user accessing the data (sees all fields)
      const adminResult = await transactionDb
        .delete<UserFilter>('test_role_filtering')
        .filter({ email: 'role@example.com' })
        .afterQuery((records: any[]) => {
          // Admin can see all fields
          const userRole = 'admin';
          return records.map(record => {
            if (userRole === 'admin') {
              return record; // Admin sees everything
            } else {
              // Regular users don't see sensitive data
              const filtered = { ...record };
              delete filtered.salary;
              delete filtered.ssn;
              return filtered;
            }
          });
        })
        .returning('*')
        .executeReturnSingle();

      return { adminResult };
    });

    // Admin should see all fields including sensitive ones
    expect(result.adminResult).toMatchObject({
      name: 'Role Test',
      email: 'role@example.com',
      salary: '75000.00',
      ssn: '123-45-6789',
      role: 'employee',
    });

    await db.disconnect();
  });

  test('transforms complex data structures in results', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table with complex data
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_complex_after_hook (
          id SERIAL PRIMARY KEY,
          raw_data JSONB,
          computed_field TEXT,
          timestamp_field TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert test data
      await transactionDb.executeQuery(
        'INSERT INTO test_complex_after_hook (raw_data, computed_field) VALUES (:raw_data, :computed_field)',
        {
          raw_data: {
            user: { name: 'Complex Test', preferences: { theme: 'dark', lang: 'en' } },
            metadata: { version: 1, internal: 'secret_data' },
          },
          computed_field: 'some_computed_value',
        }
      );

      // Query with afterQuery hook that transforms and filters data
      const transformedRecord = await transactionDb
        .delete<{}>('test_complex_after_hook')
        .filter({})
        .afterQuery((records: any[]) => {
          return records.map(record => {
            const transformed = { ...record };

            // Transform complex JSON data
            if (transformed.raw_data) {
              const data = transformed.raw_data;

              // Extract user info and remove internal metadata
              transformed.user = data.user;
              transformed.version = data.metadata?.version;

              // Remove raw_data and don't expose internal secrets
              delete transformed.raw_data;
            }

            // Transform computed field
            if (transformed.computed_field) {
              transformed.computedValue = transformed.computed_field.toUpperCase();
              delete transformed.computed_field;
            }

            // Format timestamp
            if (transformed.timestamp_field) {
              transformed.createdAt = new Date(transformed.timestamp_field).toISOString();
              delete transformed.timestamp_field;
            }

            return transformed;
          });
        })
        .returning('*')
        .executeReturnSingle();

      return transformedRecord;
    });

    expect(result).toMatchObject({
      user: {
        name: 'Complex Test',
        preferences: { theme: 'dark', lang: 'en' },
      },
      version: 1,
      computedValue: 'SOME_COMPUTED_VALUE',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/),
    });
    expect((result as any)?.id).toBeDefined();
    // Raw and computed fields should be transformed
    expect(result).not.toHaveProperty('raw_data');
    expect(result).not.toHaveProperty('computed_field');
    expect(result).not.toHaveProperty('timestamp_field');

    await db.disconnect();
  });

  test('handles empty result sets gracefully', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_empty_after_hook (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          sensitive_data VARCHAR(255)
        )
      `);

      // Query non-existent data with afterQuery hook using a valid column
      const emptyResult = await transactionDb
        .delete<{ name?: string }>('test_empty_after_hook')
        .filter({ name: 'nonexistent' })
        .beforeQuery((params: any) => {
          // Transform name parameter (even though it won't match anything) - expression parameters use p1, p2, etc.
          if (params.p1) {
            params.p1 = params.p1.toLowerCase();
          }
          return params;
        })
        .afterQuery((records: any[]) => {
          // This should handle empty arrays gracefully
          return records.map(record => {
            const safe = { ...record };
            delete safe.sensitive_data;
            return safe;
          });
        })
        .returning('*')
        .executeReturnAll();

      return emptyResult;
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);

    await db.disconnect();
  });
});

describe('Statement Hooks - Combined Usage', () => {
  test('uses both beforeQuery and afterQuery hooks together', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_combined_hooks (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          role VARCHAR(20) DEFAULT 'user',
          created_at TIMESTAMP DEFAULT NOW()
        )
      `);

      // Insert with combined hooks
      const processedRecord = await transactionDb
        .insert<TestUser>('test_combined_hooks')
        .values({
          name: 'Combined Test',
          email: 'COMBINED@EXAMPLE.COM', // Uppercase email
          password_hash: 'plaintext123', // Will be hashed
          role: 'admin',
        } as any)
        .beforeQuery((params: any) => {
          // Transform parameter values
          const transformed = { ...params };

          // Normalize email to lowercase
          if (transformed.email) {
            transformed.email = transformed.email.toLowerCase();
          }

          // Hash password
          if (transformed.password_hash) {
            transformed.password_hash = `bcrypt_${transformed.password_hash}`;
          }

          return transformed;
        })
        .afterQuery((records: any[]) => {
          // Transform results and remove sensitive data
          return records.map(record => {
            const safe = { ...record };

            // Add computed display name
            if (safe.name && safe.email) {
              safe.displayName = `${safe.name} (${safe.role})`;
            }

            // Remove sensitive data
            delete safe.password_hash;

            return safe;
          });
        })
        .returning('*')
        .executeReturnSingle();

      return processedRecord;
    });

    expect(result).toMatchObject({
      name: 'Combined Test',
      email: 'combined@example.com', // Should be normalized to lowercase
      role: 'admin',
      displayName: 'Combined Test (admin)',
    });
    expect(result?.id).toBeDefined();
    expect(result?.created_at).toBeDefined();
    // Sensitive fields should be removed
    expect(result).not.toHaveProperty('password_hash');

    await db.disconnect();
  });

  test('hooks work with update operations and value transformations', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_update_combined_hooks (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          last_login TIMESTAMP,
          preferences JSONB
        )
      `);

      // Insert initial data
      await transactionDb.executeQuery(
        'INSERT INTO test_update_combined_hooks (name, email, password_hash) VALUES (:name, :email, :password_hash)',
        {
          name: 'Update Hook Test',
          email: 'updatehook@example.com',
          password_hash: 'old_hash',
        }
      );

      // Update with combined hooks
      const updatedRecord = await transactionDb
        .update<TestUser, UserFilter>('test_update_combined_hooks')
        .values({
          name: 'Updated Hook Test',
          password_hash: 'newpassword456', // Will be hashed
          last_login: '2023-06-01T10:30:00Z', // ISO string that will be converted
          preferences: { theme: 'dark', notifications: true },
        } as any)
        .filter({ email: 'updatehook@example.com' })
        .beforeQuery((params: any) => {
          const transformed = { ...params };

          // Hash password (v_ prefix for UPDATE values)
          if (transformed.v_password_hash) {
            transformed.v_password_hash = `bcrypt_${transformed.v_password_hash}`;
          }

          // Convert ISO string to proper timestamp (v_ prefix for UPDATE values)
          if (transformed.v_last_login) {
            transformed.v_last_login = new Date(transformed.v_last_login);
          }

          return transformed;
        })
        .afterQuery((records: any[]) => {
          // Transform results and remove sensitive data
          return records.map(record => {
            const safe = { ...record };

            // Format last_login for display
            if (safe.last_login) {
              safe.lastLoginFormatted = new Date(safe.last_login).toLocaleDateString();
            }

            // Remove sensitive data
            delete safe.password_hash;

            return safe;
          });
        })
        .returning('*')
        .executeReturnSingle();

      return updatedRecord;
    });

    expect(result).toMatchObject({
      name: 'Updated Hook Test',
      email: 'updatehook@example.com',
      last_login: expect.any(Date), // PostgreSQL returns timestamps as Date objects
      preferences: { theme: 'dark', notifications: true },
      lastLoginFormatted: expect.any(String),
    });
    expect(result?.id).toBeDefined();
    // Sensitive fields should be removed
    expect(result).not.toHaveProperty('password_hash');

    await db.disconnect();
  });

  test('hooks work with transactions and rollback scenarios', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    // Test that hooks work even when transaction is rolled back
    await expect(async () => {
      await db.withTransaction(async transactionDb => {
        // Create test table
        await transactionDb.executeQuery(`
          CREATE TEMP TABLE test_rollback_hooks (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255)
          )
        `);

        // Insert with hooks
        await transactionDb
          .insert<TestUser>('test_rollback_hooks')
          .values({
            name: 'Rollback Test',
            email: 'rollback@example.com',
            password_hash: 'secret123',
          })
          .beforeQuery((params: any) => {
            if (params.password_hash) {
              params.password_hash = `hashed_${params.password_hash}`;
            }
            return params;
          })
          .afterQuery((records: any[]) => {
            return records.map(record => {
              const safe = { ...record };
              delete safe.password_hash;
              return safe;
            });
          })
          .execute();

        // Force an error to trigger rollback
        throw new Error('Intentional rollback');
      });
    }).rejects.toThrow('Intentional rollback');

    await db.disconnect();
  });

  test('hooks handle chaining with multiple operations', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_chaining_hooks (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          status VARCHAR(20) DEFAULT 'active'
        )
      `);

      // Insert with hooks
      await transactionDb
        .insert<TestUser>('test_chaining_hooks')
        .values({
          name: 'Chain Test',
          email: 'chain@example.com',
          password_hash: 'chainpass123',
        })
        .beforeQuery((params: any) => {
          if (params.password_hash) {
            params.password_hash = `hashed_${params.password_hash}`;
          }
          return params;
        })
        .execute();

      // Update with hooks
      await transactionDb
        .update<TestUser, UserFilter>('test_chaining_hooks')
        .values({ name: 'Updated Chain Test' })
        .filter({ email: 'chain@example.com' })
        .execute();

      // Query final result with afterQuery hook
      const finalRecord = await transactionDb
        .delete<UserFilter>('test_chaining_hooks')
        .filter({ email: 'chain@example.com' })
        .afterQuery((records: any[]) => {
          return records.map(record => {
            const safe = { ...record };
            delete safe.password_hash;
            return safe;
          });
        })
        .returning('*')
        .executeReturnSingle();

      return finalRecord;
    });

    expect(result).toMatchObject({
      name: 'Updated Chain Test',
      email: 'chain@example.com',
      status: 'active',
    });
    expect((result as any)?.id).toBeDefined();
    // Sensitive fields should be handled
    expect(result).not.toHaveProperty('password_hash');

    await db.disconnect();
  });
});

describe('Statement Hooks - Error Handling', () => {
  test('handles errors in beforeQuery hook gracefully', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    await expect(async () => {
      await db.withTransaction(async transactionDb => {
        // Create test table
        await transactionDb.executeQuery(`
          CREATE TEMP TABLE test_before_error (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL
          )
        `);

        // Insert with beforeQuery hook that throws error
        await transactionDb
          .insert<any>('test_before_error')
          .values({ name: 'Error Test' })
          .beforeQuery((params: any) => {
            throw new Error('BeforeQuery hook error');
          })
          .execute();
      });
    }).rejects.toThrow('BeforeQuery hook error');

    await db.disconnect();
  });

  test('handles errors in afterQuery hook gracefully', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    await expect(async () => {
      await db.withTransaction(async transactionDb => {
        // Create test table and insert data
        await transactionDb.executeQuery(`
          CREATE TEMP TABLE test_after_error (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL
          )
        `);

        await transactionDb.executeQuery('INSERT INTO test_after_error (name) VALUES (:name)', {
          name: 'After Error Test',
        });

        // Query with afterQuery hook that throws error
        await transactionDb
          .delete<{}>('test_after_error')
          .filter({})
          .afterQuery((records: any[]) => {
            throw new Error('AfterQuery hook error');
          })
          .returning('*')
          .executeReturnSingle();
      });
    }).rejects.toThrow('AfterQuery hook error');

    await db.disconnect();
  });

  test('validates hook return types', async () => {
    const db = new PostgreSQLDatabase(connectionConfig);

    const result = await db.withTransaction(async transactionDb => {
      // Create test table
      await transactionDb.executeQuery(`
        CREATE TEMP TABLE test_hook_validation (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100) NOT NULL,
          email VARCHAR(100) UNIQUE NOT NULL
        )
      `);

      // Insert with hooks that return proper types
      const validRecord = await transactionDb
        .insert<TestUser>('test_hook_validation')
        .values({ name: 'Validation Test', email: 'validation@example.com' })
        .beforeQuery((params: any) => {
          // Must return an object
          expect(typeof params).toBe('object');
          expect(params).not.toBeNull();
          return params;
        })
        .afterQuery((records: any[]) => {
          // Must return an array
          expect(Array.isArray(records)).toBe(true);
          return records;
        })
        .returning('*')
        .executeReturnSingle();

      return validRecord;
    });

    expect(result).toMatchObject({
      name: 'Validation Test',
      email: 'validation@example.com',
    });

    await db.disconnect();
  });
});
