/**
 * Supported column data types
 */
export type ColumnType =
  // Numeric types
  | 'serial'
  | 'bigserial'
  | 'smallint'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'numeric'
  | 'real'
  | 'double precision'
  // String types
  | 'varchar'
  | 'char'
  | 'text'
  // Boolean
  | 'boolean'
  // Date/Time
  | 'date'
  | 'time'
  | 'timestamp'
  | 'timestamptz'
  // JSON
  | 'json'
  | 'jsonb'
  // UUID
  | 'uuid'
  // Vector & Search (PostgreSQL specific)
  | 'vector'
  | 'tsvector';

// /**
//  * Hook function type for before generate
//  */
export type BeforeGenerateHook = (table: any, metadata: Record<string, any>) => void;

/**
 * Schema options for DatabaseSchema
 */
export interface DatabaseSchemaOptions {
  defaultSchema?: string;
}

// /**
//  * Database schema builder type definitions
//  * @module dbschema/types
//  */

// /**
//  * Supported column data types
//  */
// export type ColumnType =
//   // Numeric types
//   | 'serial'
//   | 'bigserial'
//   | 'smallint'
//   | 'integer'
//   | 'bigint'
//   | 'decimal'
//   | 'numeric'
//   | 'real'
//   | 'double precision'
//   // String types
//   | 'varchar'
//   | 'char'
//   | 'text'
//   // Boolean
//   | 'boolean'
//   // Date/Time
//   | 'date'
//   | 'time'
//   | 'timestamp'
//   | 'timestamptz'
//   // JSON
//   | 'json'
//   | 'jsonb'
//   // UUID
//   | 'uuid'
//   // Array
//   | 'array'
//   // Vector & Search (PostgreSQL specific)
//   | 'vector'
//   | 'tsvector';

// /**
//  * Index methods supported by PostgreSQL
//  */
// export type IndexMethod =
//   | 'btree'
//   | 'hash'
//   | 'gin'
//   | 'gist'
//   | 'ivfflat'
//   | 'hnsw'
//   | 'brin'
//   | 'spgist';

// /**
//  * Vector distance operators for similarity search
//  */
// export type VectorOpClass = 'vector_cosine_ops' | 'vector_l2_ops' | 'vector_ip_ops';

// /**
//  * Referential actions for foreign keys
//  */
export type ReferentialAction = 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'SET DEFAULT' | 'NO ACTION';

// /**
//  * Sort order for indexes
//  */
// export type SortOrder = 'ASC' | 'DESC';

// /**
//  * Column definition structure
//  */
// export interface ColumnDefinition {
//   name: string;
//   type: ColumnType;
//   length?: number;
//   precision?: number;
//   scale?: number;
//   dimensions?: number; // For vector type
//   baseType?: string; // For array type
//   nullable: boolean;
//   defaultValue?: string;
//   isPrimaryKey: boolean;
//   isUnique: boolean;
//   checkConstraint?: string;
//   checkConstraintName?: string;
//   comment?: string;
//   generatedExpression?: string;
//   generatedStored?: boolean;
//   foreignKey?: ForeignKeyConstraint;
// }

// /**
//  * Foreign key constraint definition
//  */
// export interface ForeignKeyConstraint {
//   columns: string[];
//   referencedTable: string;
//   referencedColumns: string[];
//   onDelete?: ReferentialAction;
//   onUpdate?: ReferentialAction;
//   name?: string;
// }

// /**
//  * Check constraint definition
//  */
// export interface CheckConstraint {
//   expression: string;
//   name?: string;
// }

// /**
//  * Unique constraint definition
//  */
// export interface UniqueConstraint {
//   columns: string[];
//   name?: string;
// }

// /**
//  * Primary key constraint definition
//  */
// export interface PrimaryKeyConstraint {
//   columns: string[];
//   name?: string;
// }

// /**
//  * Index options for creating indexes
//  */
// export interface IndexOptions {
//   name?: string;
//   unique?: boolean;
//   method?: IndexMethod;
//   opclass?: string;
//   where?: string;
//   order?: SortOrder;
//   lists?: number;
//   m?: number;
//   ef_construction?: number;
// }

// /**
//  * Index definition
//  */
// export interface IndexDefinition extends IndexOptions {
//   columns: string[];
// }

// /**
//  * Table definition structure
//  */
// export interface TableDefinition {
//   name: string;
//   schema?: string;
//   columns: ColumnDefinition[];
//   primaryKey?: PrimaryKeyConstraint;
//   foreignKeys: ForeignKeyConstraint[];
//   uniqueConstraints: UniqueConstraint[];
//   checkConstraints: CheckConstraint[];
//   indexes: IndexDefinition[];
//   comment?: string;
//   metadata: Record<string, any>;
//   options: TableOptions;
// }

// /**
//  * Options for table creation
//  */
// export interface TableOptions {
//   ifNotExists?: boolean;
//   dropIfExists?: boolean;
//   comment?: string;
//   /**
//    * Optional scope/schema for this table
//    * Maps to SQL schema name (e.g., 'billing', 'inventory')
//    * Defaults to 'public' if not specified
//    */
//   scope?: string;
// }

// /**
//  * Options for drop statements
//  */
// export interface DropOptions {
//   ifExists?: boolean;
//   cascade?: boolean;
// }

// /**
//  * Drop statement definition
//  */
// export interface DropStatement {
//   type: 'table' | 'index';
//   name: string;
//   options: DropOptions;
// }

// /**
//  * Validation error types
//  */
// export type ValidationErrorType =
//   | 'INVALID_NAME'
//   | 'DUPLICATE_TABLE'
//   | 'DUPLICATE_COLUMN'
//   | 'MISSING_REFERENCE'
//   | 'CIRCULAR_DEPENDENCY'
//   | 'RESERVED_KEYWORD'
//   | 'INVALID_TYPE'
//   | 'INVALID_CONSTRAINT';

// /**
//  * Validation error structure
//  */
// export interface ValidationError {
//   type: ValidationErrorType;
//   message: string;
//   table?: string;
//   column?: string;
//   constraint?: string;
// }

// /**
//  * Validation warning structure
//  */
// export interface ValidationWarning {
//   message: string;
//   table?: string;
//   column?: string;
// }

// /**
//  * Validation result
//  */
// export interface ValidationResult {
//   valid: boolean;
//   errors: ValidationError[];
//   warnings: ValidationWarning[];
// }

// /**
//  * Dependency graph node
//  */
// export interface DependencyNode {
//   table: string;
//   dependencies: Set<string>;
//   dependents: Set<string>;
// }

// /**
//  * SQL dialect types
//  */
// export type SQLDialect = 'postgresql' | 'mysql' | 'sqlserver';
