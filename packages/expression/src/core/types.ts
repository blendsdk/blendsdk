/**
 * Core type definitions for expression2
 */

/**
 * SQL dialect enumeration
 */
export enum SqlDialect {
  PostgreSQL = 'postgresql',
  MySQL = 'mysql',
  MSSQL = 'mssql',
  SQLite = 'sqlite',
}

/**
 * Query builder options
 */
export interface QueryOptions {
  /**
   * SQL dialect to use (default: PostgreSQL)
   */
  dialect?: SqlDialect;

  /**
   * Enable debug mode
   */
  debug?: boolean;
}

/**
 * Result of compiling a query
 */
export interface CompileResult {
  /**
   * Generated SQL WHERE clause (without the WHERE keyword)
   */
  sql: string;

  /**
   * Parameter values keyed by parameter name
   */
  params: Record<string, any>;

  /**
   * Debug information (only present if debug mode is enabled)
   */
  debug?: DebugInfo;
}

/**
 * Debug information about query compilation
 */
export interface DebugInfo {
  /**
   * Abstract syntax tree representation
   */
  ast: ASTNode;

  /**
   * List of optimizations applied
   */
  optimizations: string[];

  /**
   * Number of parameters in the query
   */
  parameterCount: number;

  /**
   * Time taken to compile the query (in milliseconds)
   */
  compilationTime: number;

  /**
   * Warnings or suggestions
   */
  warnings: string[];
}

/**
 * Base AST node type
 */
export enum ASTNodeType {
  Comparison = 'comparison',
  Logical = 'logical',
  Group = 'group',
  Json = 'json',
  FullText = 'fulltext',
  Subquery = 'subquery',
}

/**
 * Base interface for all AST nodes
 */
export interface ASTNode {
  readonly type: ASTNodeType;
  readonly id: string;
}

/**
 * Comparison operators
 */
export enum ComparisonOperator {
  Equal = '=',
  NotEqual = '<>',
  GreaterThan = '>',
  GreaterThanOrEqual = '>=',
  LessThan = '<',
  LessThanOrEqual = '<=',
  Like = 'LIKE',
  ILike = 'ILIKE',
  In = 'IN',
  NotIn = 'NOT IN',
  Between = 'BETWEEN',
  NotBetween = 'NOT BETWEEN',
  IsNull = 'IS NULL',
  IsNotNull = 'IS NOT NULL',
}

/**
 * Comparison AST node
 */
export interface ComparisonNode extends ASTNode {
  readonly type: ASTNodeType.Comparison;
  readonly column: string;
  readonly operator: ComparisonOperator;
  readonly value?: any;
  readonly values?: any[];
  readonly parameterNames?: string[];
}

/**
 * Logical operators
 */
export enum LogicalOperator {
  And = 'AND',
  Or = 'OR',
}

/**
 * Logical AST node (AND/OR)
 */
export interface LogicalNode extends ASTNode {
  readonly type: ASTNodeType.Logical;
  readonly operator: LogicalOperator;
  readonly left: ASTNode;
  readonly right: ASTNode;
}

/**
 * Group AST node (for parentheses)
 */
export interface GroupNode extends ASTNode {
  readonly type: ASTNodeType.Group;
  readonly child: ASTNode;
}

/**
 * JSON operators (PostgreSQL)
 */
export enum JsonOperator {
  Contains = '@>',
  ContainedBy = '<@',
  HasKey = '?',
  HasAnyKey = '?|',
  HasAllKeys = '?&',
  PathExists = '@?',
}

/**
 * JSON AST node
 */
export interface JsonNode extends ASTNode {
  readonly type: ASTNodeType.Json;
  readonly column: string;
  readonly operator: JsonOperator;
  readonly value?: any;
  readonly path?: string;
  readonly keys?: string[];
  readonly parameterName?: string;
}

/**
 * Full-text search modes
 */
export enum FullTextMode {
  Plain = 'plain',
  Phrase = 'phrase',
  WebSearch = 'websearch',
}

/**
 * Full-text search AST node
 */
export interface FullTextNode extends ASTNode {
  readonly type: ASTNodeType.FullText;
  readonly columns: string[];
  readonly query: string;
  readonly mode: FullTextMode;
  readonly language: string;
  readonly parameterName: string;
}

/**
 * Subquery AST node
 */
export interface SubqueryNode extends ASTNode {
  readonly type: ASTNodeType.Subquery;
  readonly column?: string;
  readonly operator: 'EXISTS' | 'NOT EXISTS' | 'IN' | 'NOT IN' | ComparisonOperator;
  readonly subquery: ASTNode;
}

/**
 * Search options for full-text search
 */
export interface SearchOptions {
  /**
   * Search mode (default: plain)
   */
  mode?: 'plain' | 'phrase' | 'websearch';

  /**
   * Language for text search (default: english)
   */
  language?: string;
}

/**
 * Extract column names from a schema type
 */
export type ColumnName<TSchema> = keyof TSchema & string;

/**
 * Extract column type from a schema
 */
export type ColumnType<TSchema, K extends keyof TSchema> = TSchema[K];

/**
 * Type guard to check if a value is an ASTNode
 */
export function isASTNode(value: any): value is ASTNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    'id' in value &&
    Object.values(ASTNodeType).includes(value.type)
  );
}

/**
 * Type guard for ComparisonNode
 */
export function isComparisonNode(node: ASTNode): node is ComparisonNode {
  return node.type === ASTNodeType.Comparison;
}

/**
 * Type guard for LogicalNode
 */
export function isLogicalNode(node: ASTNode): node is LogicalNode {
  return node.type === ASTNodeType.Logical;
}

/**
 * Type guard for GroupNode
 */
export function isGroupNode(node: ASTNode): node is GroupNode {
  return node.type === ASTNodeType.Group;
}

/**
 * Type guard for JsonNode
 */
export function isJsonNode(node: ASTNode): node is JsonNode {
  return node.type === ASTNodeType.Json;
}

/**
 * Type guard for FullTextNode
 */
export function isFullTextNode(node: ASTNode): node is FullTextNode {
  return node.type === ASTNodeType.FullText;
}

/**
 * Type guard for SubqueryNode
 */
export function isSubqueryNode(node: ASTNode): node is SubqueryNode {
  return node.type === ASTNodeType.Subquery;
}
