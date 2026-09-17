# DatabaseSchema & PostgreSQLSchemaGenerator - Missing Features

This document tracks missing PostgreSQL features that should be implemented in the DatabaseSchema and PostgreSQLSchemaGenerator classes.

## High Priority Features

### #1 - Index Support
**Status:** Not Implemented  
**Priority:** High  
**Description:** Add support for creating database indexes

**Required Features:**
- [ ] B-tree indexes (default)
- [ ] GIN indexes (for JSONB, arrays, full-text search)
- [ ] GiST indexes (for geometric data, full-text search)
- [ ] HNSW indexes (for vector similarity search)
- [ ] IVFFlat indexes (for vector similarity search)
- [ ] Partial indexes (with WHERE clause)
- [ ] Expression indexes (on computed expressions)
- [ ] Unique indexes (separate from unique constraints)
- [ ] Concurrent index creation (CREATE INDEX CONCURRENTLY)
- [ ] Multi-column indexes
- [ ] Index storage parameters (fillfactor, etc.)

**API Design:**
```typescript
table.index('idx_name')
  .column('col1', 'col2')
  .method('btree')
  .where('col1 IS NOT NULL')
  .unique();

table.index('idx_vector')
  .column('embedding')
  .method('hnsw')
  .opclass('vector_cosine_ops')
  .with({ m: 16, ef_construction: 64 });
```

---

### #2 - Array Column Types
**Status:** Not Implemented  
**Priority:** High  
**Description:** Support PostgreSQL array types

**Required Features:**
- [ ] Array type definition (e.g., `integer[]`, `text[]`)
- [ ] Multi-dimensional arrays
- [ ] Array size constraints
- [ ] Array default values
- [ ] GIN indexes for arrays

**API Design:**
```typescript
table.integerArray('tags');
table.textArray('categories', 2); // 2-dimensional
table.array('custom_col', 'integer'); // Generic array method
```

---

### #3 - Generated Columns
**Status:** ✅ IMPLEMENTED  
**Priority:** High  
**Description:** Support GENERATED columns (computed columns)

**Required Features:**
- [x] GENERATED ALWAYS AS (expression) STORED
- [ ] GENERATED ALWAYS AS (expression) VIRTUAL (PostgreSQL only supports STORED)
- [x] Expression validation (throws error for VIRTUAL)
- [x] Dependencies on other columns
- [x] Automatic clearing of DEFAULT when generated() is called
- [x] Support for nullable generated columns
- [x] Support for comments on generated columns
- [x] Complex expressions (arithmetic, string, conditional, functions)

**API Design:**
```typescript
table.integer('price');
table.integer('quantity');
table.decimal('total', 10, 2)
  .generated('price * quantity'); // Defaults to STORED

// String concatenation
table.varchar('first_name', 50);
table.varchar('last_name', 50);
table.varchar('full_name', 100)
  .generated("first_name || ' ' || last_name");

// Conditional expressions
table.decimal('price', 10, 2);
table.varchar('price_category', 20)
  .generated("CASE WHEN price > 100 THEN 'expensive' ELSE 'cheap' END");
```

**Implementation:**
- Added `generated()` method to TableColumnSchema class
- Added `getGeneratedExpression()`, `isGenerated()`, `isGeneratedStored()` getter methods
- PostgreSQLSchemaGenerator renders `GENERATED ALWAYS AS (expression) STORED` syntax
- Generated columns do not have NOT NULL clause (it's implicit)
- Mutual exclusivity with DEFAULT values enforced
- Throws error if VIRTUAL is specified (PostgreSQL limitation)

**Tests:**
- 23 unit tests (generated-columns.test.ts)
- 8 integration tests (generated-columns-integration.test.ts)
- All tests passing ✅

**PostgreSQL Constraints:**
- ✅ Can reference other columns in same table
- ✅ Can be indexed
- ✅ Can be nullable
- ✅ Can have comments
- ❌ Cannot have DEFAULT values (enforced by clearing `_default`)
- ❌ Cannot reference other generated columns (PostgreSQL 12-14 limitation)
- ❌ Expression must be immutable (no NOW(), RANDOM(), etc.)
- ❌ Cannot use subqueries

---

### #4 - Table and Column Comments
**Status:** ✅ IMPLEMENTED  
**Priority:** High  
**Description:** Add documentation support via SQL comments

**Required Features:**
- [x] COMMENT ON TABLE
- [x] COMMENT ON COLUMN
- [x] Comment escaping (single quotes)
- [x] Multi-line comments
- [x] Special character support
- [x] Cross-schema comments
- [x] Comment chaining with other modifiers

**API Design:**
```typescript
table.comment('Stores user information');
table.varchar('email').comment('User email address');
```

**Implementation:**
- Added `comment()` method to DataObjectSchema base class (returns `this` for chaining)
- All schema objects (DatabaseSchema, TableSchema, TableColumnSchema) inherit `getComment()`
- PostgreSQLSchemaGenerator.renderComments() generates COMMENT ON TABLE/COLUMN statements
- Proper escaping of single quotes (doubled for PostgreSQL)
- Comments rendered after constraints in generated SQL

**Tests:**
- 20 unit tests (comments.test.ts)
- 6 integration tests (comments-integration.test.ts)
- All tests passing ✅

---

## Medium Priority Features

### #5 - View Support
**Status:** Not Implemented  
**Priority:** Medium  
**Description:** Support database views

**Required Features:**
- [ ] CREATE VIEW
- [ ] CREATE MATERIALIZED VIEW
- [ ] View dependencies
- [ ] REFRESH MATERIALIZED VIEW
- [ ] View with CHECK OPTION

**API Design:**
```typescript
schema.view('active_users')
  .as('SELECT * FROM users WHERE active = true');

schema.materializedView('user_stats')
  .as('SELECT user_id, COUNT(*) FROM orders GROUP BY user_id');
```

---

### #6 - Custom Enum Types
**Status:** Not Implemented  
**Priority:** Medium  
**Description:** Support PostgreSQL ENUM types

**Required Features:**
- [ ] CREATE TYPE ... AS ENUM
- [ ] Enum value definition
- [ ] Enum column usage
- [ ] ALTER TYPE ... ADD VALUE

**API Design:**
```typescript
schema.enum('user_status', ['active', 'inactive', 'suspended']);
table.enum('status', 'user_status');
```

---

### #7 - Deferrable Constraints
**Status:** Not Implemented  
**Priority:** Medium  
**Description:** Support deferrable constraints for complex transactions

**Required Features:**
- [ ] DEFERRABLE
- [ ] NOT DEFERRABLE
- [ ] INITIALLY DEFERRED
- [ ] INITIALLY IMMEDIATE

**API Design:**
```typescript
table.foreignKeyConstraint(parent)
  .from('parent_id')
  .to('id')
  .deferrable('INITIALLY DEFERRED');
```

---

### #8 - Migration Support (ALTER TABLE)
**Status:** Not Implemented  
**Priority:** Medium  
**Description:** Support schema migrations with ALTER TABLE

**Required Features:**
- [ ] ADD COLUMN
- [ ] DROP COLUMN
- [ ] ALTER COLUMN TYPE
- [ ] ALTER COLUMN SET DEFAULT
- [ ] ALTER COLUMN DROP DEFAULT
- [ ] ALTER COLUMN SET NOT NULL
- [ ] ALTER COLUMN DROP NOT NULL
- [ ] RENAME COLUMN
- [ ] RENAME TABLE
- [ ] ADD CONSTRAINT
- [ ] DROP CONSTRAINT

**API Design:**
```typescript
migration.alterTable('users')
  .addColumn(t => t.varchar('phone', 20))
  .dropColumn('old_field')
  .renameColumn('name', 'full_name');
```

---

### #9 - Identity Columns
**Status:** ✅ IMPLEMENTED  
**Priority:** Medium  
**Description:** Modern alternative to SERIAL with UUID support

**Required Features:**
- [x] GENERATED ALWAYS AS IDENTITY
- [x] GENERATED BY DEFAULT AS IDENTITY
- [x] Sequence options (START, INCREMENT, MINVALUE, MAXVALUE, CACHE, CYCLE)
- [x] UUID identity with gen_random_uuid() (built-in PostgreSQL 13+)
- [x] UUID identity with uuid_generate_v4() (uuid-ossp extension)
- [x] UUID identity with uuid_generate_v7() (pg_uuidv7 extension)
- [x] Custom UUID function support
- [x] Automatic extension management for UUID generators
- [x] Mutual exclusivity with DEFAULT and GENERATED columns
- [x] Support for smallint, integer, bigint, and uuid types

**API Design:**
```typescript
// Integer identity
table.integer('id').identity('ALWAYS');
table.bigint('id').identity('BY DEFAULT', { start: 1000, increment: 1 });

// UUID identity (auto-manages extensions)
table.uuid('id').identity();           // Uses gen_random_uuid()
table.uuid('id').identity('v4');       // Uses uuid_generate_v4() + adds uuid-ossp extension
table.uuid('id').identity('v7');       // Uses uuid_generate_v7() + adds pg_uuidv7 extension
table.uuid('id').identity('custom()'); // Custom function
```

**Implementation:**
- Added `.identity()` method to TableColumnSchema with type-aware behavior
- Integer types use `GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY` syntax
- UUID types use `DEFAULT {uuid_function}()` syntax
- Automatic extension registration via `this.relation.getDatabase().extension()`
- PostgreSQLSchemaGenerator renders identity clauses with all sequence options
- Validates mutual exclusivity with GENERATED columns
- Clears DEFAULT value when identity is set

**Tests:**
- 37 unit tests (identity-columns.test.ts)
- 16 integration tests (identity-columns-integration.test.ts)
- All tests passing ✅

**PostgreSQL Features:**
- ✅ ALWAYS prevents manual value insertion
- ✅ BY DEFAULT allows manual value insertion
- ✅ Sequence options (START, INCREMENT, MIN/MAX, CACHE, CYCLE)
- ✅ UUID v4 (random UUIDs)
- ✅ UUID v7 (time-ordered UUIDs)
- ✅ Works with primary keys, unique constraints, comments
- ✅ Cross-schema support
- ✅ Automatic sequence creation and ownership

---

### #10 - Sequence Management
**Status:** Not Implemented  
**Priority:** Medium  
**Description:** Custom sequence creation and management

**Required Features:**
- [ ] CREATE SEQUENCE
- [ ] Sequence options (START, INCREMENT, MINVALUE, MAXVALUE, CYCLE, CACHE)
- [ ] ALTER SEQUENCE
- [ ] DROP SEQUENCE

**API Design:**
```typescript
schema.sequence('order_number_seq')
  .start(1000)
  .increment(1)
  .cache(20);
```

---

## Low Priority Features

### #11 - Advanced PostgreSQL Types
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Support specialized PostgreSQL types

**Required Features:**
- [ ] Range types (int4range, int8range, numrange, tsrange, tstzrange, daterange)
- [ ] Geometric types (point, line, lseg, box, path, polygon, circle)
- [ ] Network types (inet, cidr, macaddr, macaddr8)
- [ ] Bit string types (bit, bit varying)
- [ ] XML type
- [ ] Money type
- [ ] Composite types (custom row types)
- [ ] Domain types (constrained base types)

---

### #12 - Triggers
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Support trigger creation

**Required Features:**
- [ ] CREATE TRIGGER
- [ ] BEFORE/AFTER triggers
- [ ] INSERT/UPDATE/DELETE events
- [ ] FOR EACH ROW/STATEMENT
- [ ] Trigger functions
- [ ] WHEN conditions

---

### #13 - Functions and Procedures
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Support stored procedures and functions

**Required Features:**
- [ ] CREATE FUNCTION
- [ ] CREATE PROCEDURE
- [ ] Function parameters
- [ ] Return types
- [ ] Language specification (SQL, PL/pgSQL)
- [ ] Function body

---

### #14 - Table Inheritance
**Status:** Not Implemented  
**Priority:** Low  
**Description:** PostgreSQL table inheritance

**Required Features:**
- [ ] INHERITS clause
- [ ] Parent table definition
- [ ] Child table definition
- [ ] Inheritance queries

---

### #15 - Table Partitioning
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Table partitioning for large datasets

**Required Features:**
- [ ] PARTITION BY RANGE
- [ ] PARTITION BY LIST
- [ ] PARTITION BY HASH
- [ ] Partition creation
- [ ] Partition bounds
- [ ] Partition management

---

### #16 - Exclusion Constraints
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Advanced constraint type for preventing overlaps

**Required Features:**
- [ ] EXCLUDE USING gist/spgist
- [ ] Operator specification
- [ ] WITH clause for index parameters

**Example:**
```sql
EXCLUDE USING gist (room_id WITH =, during WITH &&)
```

---

### #17 - Row-Level Security
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Fine-grained access control

**Required Features:**
- [ ] ENABLE ROW LEVEL SECURITY
- [ ] CREATE POLICY
- [ ] Policy commands (SELECT, INSERT, UPDATE, DELETE)
- [ ] USING clause
- [ ] WITH CHECK clause

---

### #18 - Grant/Revoke Permissions
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Database permissions management

**Required Features:**
- [ ] GRANT privileges
- [ ] REVOKE privileges
- [ ] Role management
- [ ] Schema permissions
- [ ] Table permissions
- [ ] Column permissions

---

### #19 - Schema Validation
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Validate schema before SQL generation

**Required Features:**
- [ ] Circular dependency detection
- [ ] Reserved keyword checking
- [ ] Naming convention validation
- [ ] Type compatibility checking
- [ ] Constraint validation
- [ ] Foreign key reference validation

---

### #20 - Transaction Wrapping
**Status:** Not Implemented  
**Priority:** Low  
**Description:** Wrap generated SQL in transactions

**Required Features:**
- [ ] BEGIN/COMMIT wrapping
- [ ] ROLLBACK on error
- [ ] Savepoints
- [ ] Transaction isolation levels

---

## Implementation Notes

### Current Capabilities (Implemented ✅)
- All 26 basic PostgreSQL column types
- Size, scale, and precision parameters
- Primary keys (single and composite)
- Foreign keys (single and composite) with all referential actions
- Unique constraints (single and composite)
- Check constraints
- Multi-schema support (via `.scope()`)
- Cross-schema foreign keys
- Extensions (via `.extension()`)
- NOT NULL / nullable columns
- Default values
- DROP TABLE CASCADE
- Proper ON DELETE/ON UPDATE clause generation

### Testing Coverage
- 240 tests passing (68 unit + 10 integration + 162 type tests)
- Comprehensive integration tests against real PostgreSQL
- Multi-schema testing
- Cross-schema foreign key testing
- All referential actions tested
- Composite key testing

---

## Contributing

When implementing new features:
1. Add the feature to the appropriate class (DatabaseSchema, TableSchema, TableColumnSchema)
2. Update PostgreSQLSchemaGenerator to generate the SQL
3. Add comprehensive unit tests
4. Add integration tests that verify against real PostgreSQL
5. Update this TODO.md to mark the feature as complete
6. Update the main README.md with usage examples

---

**Last Updated:** 2025-10-08  
**Total Features Identified:** 20  
**Implemented:** 2/20 ✅  
**High Priority:** 2 remaining (2 complete)  
**Medium Priority:** 6  
**Low Priority:** 10
