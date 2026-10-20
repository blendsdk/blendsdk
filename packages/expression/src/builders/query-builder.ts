/**
 * Main query builder implementation
 * Provides the fluent API for building SQL WHERE clauses
 */

import { performance } from 'node:perf_hooks';

import { PostgreSQLCompiler } from '../compiler/postgresql-compiler.js';
import { createFullTextNode, createGroupNode, createLogicalNode } from '../core/ast-node.js';
import { ParameterManager } from '../core/parameter-manager.js';
import { ComparisonBuilder, QueryBuilder } from '../core/query-builder-interfaces.js';
import {
  ASTNode,
  CompileResult,
  FullTextMode,
  LogicalOperator,
  QueryOptions,
  SearchOptions,
  SqlDialect,
} from '../core/types.js';
import { ComparisonBuilderImpl } from './comparison-builder.js';

/**
 * Main query builder implementation
 */
export class QueryBuilderImpl<TSchema = Record<string, any>> implements QueryBuilder<TSchema> {
  private ast: ASTNode | null = null;
  private readonly paramManager: ParameterManager;
  private readonly dialect: SqlDialect;
  private debugMode: boolean = false;

  /**
   * Creates a new QueryBuilderImpl instance.
   *
   * @param options - Query builder configuration options
   * @param parentParamManager - Optional parent parameter manager for nested builders
   *   to share parameter naming across nested sub-queries
   */
  constructor(options: QueryOptions = {}, parentParamManager?: ParameterManager) {
    this.dialect = options.dialect || SqlDialect.PostgreSQL;
    this.paramManager = parentParamManager || new ParameterManager(this.dialect);
    this.debugMode = options.debug || false;
  }

  /**
   * Start WHERE clause with a column
   */
  where<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;
  where(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;
  where<K extends keyof TSchema>(
    columnOrCallback: K | ((q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)
  ): ComparisonBuilder<TSchema, K> | QueryBuilder<TSchema> {
    if (typeof columnOrCallback === 'function') {
      // Callback for grouping - share parameter manager
      const nestedBuilder = this.createNestedBuilder();
      const result = columnOrCallback(nestedBuilder);
      const nestedAST = result.getAST();

      if (nestedAST) {
        const groupNode = createGroupNode(nestedAST);
        this.ast = groupNode;
      }

      return this;
    } else {
      // Column comparison
      return new ComparisonBuilderImpl<TSchema, K>(
        String(columnOrCallback),
        this,
        this.paramManager,
        (node: ASTNode) => {
          this.ast = node;
          return this;
        }
      );
    }
  }

  /**
   * Add AND condition with a column
   */
  and<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;
  and(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;
  and<K extends keyof TSchema>(
    columnOrCallback: K | ((q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)
  ): ComparisonBuilder<TSchema, K> | QueryBuilder<TSchema> {
    if (typeof columnOrCallback === 'function') {
      // Callback for grouping - share parameter manager
      const nestedBuilder = this.createNestedBuilder();
      const result = columnOrCallback(nestedBuilder);
      const nestedAST = result.getAST();

      if (nestedAST && this.ast) {
        const groupNode = createGroupNode(nestedAST);
        this.ast = createLogicalNode(LogicalOperator.And, this.ast, groupNode);
      } else if (nestedAST) {
        this.ast = createGroupNode(nestedAST);
      }

      return this;
    } else {
      // Column comparison
      return new ComparisonBuilderImpl<TSchema, K>(
        String(columnOrCallback),
        this,
        this.paramManager,
        (node: ASTNode) => {
          if (this.ast) {
            this.ast = createLogicalNode(LogicalOperator.And, this.ast, node);
          } else {
            this.ast = node;
          }
          return this;
        }
      );
    }
  }

  /**
   * Add OR condition with a column
   */
  or<K extends keyof TSchema>(column: K): ComparisonBuilder<TSchema, K>;
  or(callback: (q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>): QueryBuilder<TSchema>;
  or<K extends keyof TSchema>(
    columnOrCallback: K | ((q: QueryBuilder<TSchema>) => QueryBuilder<TSchema>)
  ): ComparisonBuilder<TSchema, K> | QueryBuilder<TSchema> {
    if (typeof columnOrCallback === 'function') {
      // Callback for grouping - share parameter manager
      const nestedBuilder = this.createNestedBuilder();
      const result = columnOrCallback(nestedBuilder);
      const nestedAST = result.getAST();

      if (nestedAST && this.ast) {
        const groupNode = createGroupNode(nestedAST);
        this.ast = createLogicalNode(LogicalOperator.Or, this.ast, groupNode);
      } else if (nestedAST) {
        this.ast = createGroupNode(nestedAST);
      }

      return this;
    } else {
      // Column comparison
      return new ComparisonBuilderImpl<TSchema, K>(
        String(columnOrCallback),
        this,
        this.paramManager,
        (node: ASTNode) => {
          if (this.ast) {
            this.ast = createLogicalNode(LogicalOperator.Or, this.ast, node);
          } else {
            this.ast = node;
          }
          return this;
        }
      );
    }
  }

  /**
   * Full-text search across multiple columns
   */
  search(
    columns: string | string[],
    query: string,
    options?: SearchOptions
  ): QueryBuilder<TSchema> {
    const columnArray = Array.isArray(columns) ? columns : [columns];
    const mode =
      options?.mode === 'phrase'
        ? FullTextMode.Phrase
        : options?.mode === 'websearch'
          ? FullTextMode.WebSearch
          : FullTextMode.Plain;
    const language = options?.language || 'english';
    const paramName = this.paramManager.addParameterWithValue(query);

    const node = createFullTextNode(columnArray, query, mode, language, paramName);

    if (this.ast) {
      this.ast = createLogicalNode(LogicalOperator.And, this.ast, node);
    } else {
      this.ast = node;
    }

    return this;
  }

  /**
   * Enable debug mode
   */
  debug(): QueryBuilder<TSchema> {
    this.debugMode = true;
    return this;
  }

  /**
   * Compile the query to SQL
   */
  compile(): CompileResult {
    const startTime = performance.now();

    if (!this.ast) {
      return {
        sql: '',
        params: {},
        debug: this.debugMode
          ? {
              ast: this.ast!,
              optimizations: [],
              parameterCount: 0,
              compilationTime: 0,
              warnings: ['No conditions specified'],
            }
          : undefined,
      };
    }

    // Create compiler based on dialect
    let compiler;
    switch (this.dialect) {
      case SqlDialect.PostgreSQL:
        compiler = new PostgreSQLCompiler(this.paramManager);
        break;
      case SqlDialect.MySQL:
      case SqlDialect.MSSQL:
      case SqlDialect.SQLite:
        throw new Error(`Dialect ${this.dialect} is not yet implemented`);
      default:
        throw new Error(`Unknown dialect: ${this.dialect}`);
    }

    // Compile AST to SQL
    const sql = compiler.compile(this.ast);
    const params = this.paramManager.getParameters();
    const compilationTime = performance.now() - startTime;

    const result: CompileResult = {
      sql,
      params,
    };

    // Add debug information if enabled
    if (this.debugMode) {
      result.debug = {
        ast: this.ast,
        optimizations: compiler.getOptimizations(),
        parameterCount: this.paramManager.getParameterCount(),
        compilationTime,
        warnings: compiler.getWarnings(),
      };
    }

    return result;
  }

  /**
   * Get the internal AST
   */
  getAST(): ASTNode | null {
    return this.ast;
  }

  /**
   * Create a nested builder that shares the parameter manager.
   * This ensures parameter naming is consistent across the parent
   * and nested sub-queries (e.g., grouped WHERE conditions).
   *
   * @returns A new QueryBuilderImpl that shares this builder's parameter manager
   */
  private createNestedBuilder(): QueryBuilderImpl<TSchema> {
    return new QueryBuilderImpl<TSchema>(
      { dialect: this.dialect, debug: this.debugMode },
      this.paramManager
    );
  }

  /**
   * Clone this query builder.
   *
   * **⚠️ WARNING: Shared state** — The cloned builder gets a **new** parameter manager,
   * but shares the same AST reference. Modifying the AST in either the original
   * or the clone may affect the other. Use this for branching query variations,
   * not for independent copies. If you need fully independent copies, compile
   * the original first, then build a new query.
   *
   * @returns A new QueryBuilder with the same AST but independent parameter manager
   */
  clone(): QueryBuilder<TSchema> {
    const cloned = new QueryBuilderImpl<TSchema>({
      dialect: this.dialect,
      debug: this.debugMode,
    });
    cloned.ast = this.ast;
    return cloned;
  }
}

/**
 * Create a new query builder
 */
export function query<TSchema = Record<string, any>>(
  options?: QueryOptions
): QueryBuilder<TSchema> {
  return new QueryBuilderImpl<TSchema>(options);
}
