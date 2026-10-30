/**
 * @blendsdk/expression
 * Modern, type-safe SQL WHERE clause builder with fluent API
 */

// Export main query builder
export { query, QueryBuilderImpl } from './builders/query-builder.js';

// Export types
export type {
  ComparisonBuilder,
  QueryBuilder,
  SubqueryBuilder,
} from './core/query-builder-interfaces.js';

export type {
  ASTNode,
  ComparisonNode,
  CompileResult,
  DebugInfo,
  FullTextNode,
  GroupNode,
  JsonNode,
  LogicalNode,
  QueryOptions,
  SearchOptions,
  SubqueryNode,
} from './core/types.js';

export {
  ASTNodeType,
  ComparisonOperator,
  FullTextMode,
  JsonOperator,
  LogicalOperator,
  SqlDialect,
} from './core/types.js';

// Export utilities
export { PostgreSQLCompiler } from './compiler/postgresql-compiler.js';
export { ParameterManager } from './core/parameter-manager.js';
