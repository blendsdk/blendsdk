/**
 * Query builder interfaces
 * Defines the fluent API for building SQL WHERE clauses
 */

import { ASTNode, CompileResult, SearchOptions } from './types.js';

/**
 * Comparison builder interface
 * Provides methods for building comparison expressions
 */
export interface ComparisonBuilder<TSchema, K extends keyof TSchema> {
  /**
   * Equal comparison (=)
   */
  equals(value: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * Not equal comparison (<>)
   */
  notEquals(value: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * Greater than comparison (>)
   */
  greaterThan(value: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * Greater than or equal comparison (>=)
   */
  greaterThanOrEqual(value: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * Less than comparison (<)
   */
  lessThan(value: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * Less than or equal comparison (<=)
   */
  lessThanOrEqual(value: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * Between comparison (BETWEEN min AND max)
   */
  between(min: TSchema[K], max: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * Not between comparison (NOT BETWEEN min AND max)
   */
  notBetween(min: TSchema[K], max: TSchema[K]): QueryBuilder<TSchema>;

  /**
   * IN comparison (IN (value1, value2, ...))
   */
  in(values: TSchema[K][]): QueryBuilder<TSchema>;

  /**
   * NOT IN comparison (NOT IN (value1, value2, ...))
   */
  notIn(values: TSchema[K][]): QueryBuilder<TSchema>;

  /**
   * LIKE comparison (LIKE pattern)
   */
  like(pattern: string): QueryBuilder<TSchema>;

  /**
   * ILIKE comparison (ILIKE pattern) - PostgreSQL only
   */
  ilike(pattern: string): QueryBuilder<TSchema>;

  /**
   * IS NULL check
   */
  isNull(): QueryBuilder<TSchema>;

  /**
   * IS NOT NULL check
   */
  isNotNull(): QueryBuilder<TSchema>;

  /**
   * Starts with (sugar for LIKE 'value%')
   */
  startsWith(value: string): QueryBuilder<TSchema>;

  /**
   * Ends with (sugar for LIKE '%value')
   */
  endsWith(value: string): QueryBuilder<TSchema>;

  /**
   * Contains (sugar for LIKE '%value%')
   */
  contains(value: string): QueryBuilder<TSchema>;

  /**
   * JSON contains (PostgreSQL @> operator)
   */
  jsonContains(value: any): QueryBuilder<TSchema>;

  /**
   * JSON contained by (PostgreSQL <@ operator)
   */
  jsonContainedBy(value: any): QueryBuilder<TSchema>;

  /**
   * JSON has key (PostgreSQL ? operator)
   */
  jsonHasKey(key: string): QueryBuilder<TSchema>;

  /**
   * JSON has any key (PostgreSQL ?| operator)
   */
  jsonHasAnyKey(keys: string[]): QueryBuilder<TSchema>;

  /**
   * JSON has all keys (PostgreSQL ?& operator)
   */
  jsonHasAllKeys(keys: string[]): QueryBuilder<TSchema>;

  /**
   * JSON path exists (PostgreSQL @? operator)
   */
  jsonPathExists(path: string): QueryBuilder<TSchema>;

  /**
   * Full-text search
   */
  search(query: string, options?: SearchOptions): QueryBuilder<TSchema>;

  /**
   * EXISTS with subquery
   */
  exists(subquery: QueryBuilder<any>): QueryBuilder<TSchema>;

  /**
   * NOT EXISTS with subquery
   */
  notExists(subquery: QueryBuilder<any>): QueryBuilder<TSchema>;

  /**
   * IN with subquery
   */
  inSubquery(subquery: QueryBuilder<any>): QueryBuilder<TSchema>;

  /**
   * NOT IN with subquery
   */
  notInSubquery(subquery: QueryBuilder<any>): QueryBuilder<TSchema>;

  /**
   * Compare with column (for correlated subqueries)
   */
  equalsColumn(column: string): QueryBuilder<TSchema>;
}

/**
 * Main query builder interface
 * Provides the fluent API for building queries
 */
export interface QueryBuilder<TSchema = Record<string, any>> {
  /**
   * Start a WHERE clause with a column
   */
  where<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;

  /**
   * Start a WHERE clause with a callback for grouping
   */
  where(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;

  /**
   * Add an AND condition with a column
   */
  and<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;

  /**
   * Add an AND condition with a callback for grouping
   */
  and(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;

  /**
   * Add an OR condition with a column
   */
  or<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;

  /**
   * Add an OR condition with a callback for grouping
   */
  or(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;

  /**
   * Full-text search across multiple columns
   */
  search(columns: string | string[], query: string, options?: SearchOptions): QueryBuilder<TSchema>;

  /**
   * Enable debug mode
   */
  debug(): QueryBuilder<TSchema>;

  /**
   * Compile the query to SQL
   */
  compile(): CompileResult;

  /**
   * Get the internal AST (for advanced use cases)
   */
  getAST(): ASTNode | null;
}

/**
 * Subquery builder interface
 * Used for building subqueries
 */
export interface SubqueryBuilder<TSchema = Record<string, any>> extends QueryBuilder<TSchema> {
  /**
   * Select columns for subquery
   */
  select(...columns: (keyof TSchema)[]): SubqueryBuilder<TSchema>;

  /**
   * Aggregate function for subquery
   */
  aggregate(func: 'avg' | 'sum' | 'count' | 'min' | 'max'): SubqueryBuilder<TSchema>;
}
