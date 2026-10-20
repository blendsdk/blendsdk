/**
 * Comparison builder implementation
 * Provides fluent API for building comparison expressions
 */

import {
  createComparisonNode,
  createJsonNode,
  createFullTextNode,
  createSubqueryNode,
} from '../core/ast-node.js';
import { ParameterManager } from '../core/parameter-manager.js';
import {
  ComparisonOperator,
  JsonOperator,
  FullTextMode,
  SearchOptions,
  ASTNode,
} from '../core/types.js';
import { ComparisonBuilder, QueryBuilder } from '../core/query-builder-interfaces.js';

/**
 * Comparison builder implementation
 */
export class ComparisonBuilderImpl<TSchema, K extends keyof TSchema>
  implements ComparisonBuilder<TSchema, K>
{
  constructor(
    private readonly column: string,
    private readonly queryBuilder: QueryBuilder<TSchema>,
    private readonly paramManager: ParameterManager,
    private readonly addNode: (node: ASTNode) => QueryBuilder<TSchema>
  ) {}

  equals(value: TSchema[K]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.Equal,
      value,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  notEquals(value: TSchema[K]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.NotEqual,
      value,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  greaterThan(value: TSchema[K]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.GreaterThan,
      value,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  greaterThanOrEqual(value: TSchema[K]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.GreaterThanOrEqual,
      value,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  lessThan(value: TSchema[K]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.LessThan,
      value,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  lessThanOrEqual(value: TSchema[K]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.LessThanOrEqual,
      value,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  between(min: TSchema[K], max: TSchema[K]): QueryBuilder<TSchema> {
    const minParamName = this.paramManager.addParameterWithValue(min);
    const maxParamName = this.paramManager.addParameterWithValue(max);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.Between,
      undefined,
      [min, max],
      [minParamName, maxParamName]
    );
    return this.addNode(node);
  }

  notBetween(min: TSchema[K], max: TSchema[K]): QueryBuilder<TSchema> {
    const minParamName = this.paramManager.addParameterWithValue(min);
    const maxParamName = this.paramManager.addParameterWithValue(max);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.NotBetween,
      undefined,
      [min, max],
      [minParamName, maxParamName]
    );
    return this.addNode(node);
  }

  in(values: TSchema[K][]): QueryBuilder<TSchema> {
    const paramNames = values.map(v => this.paramManager.addParameterWithValue(v));
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.In,
      undefined,
      values,
      paramNames
    );
    return this.addNode(node);
  }

  notIn(values: TSchema[K][]): QueryBuilder<TSchema> {
    const paramNames = values.map(v => this.paramManager.addParameterWithValue(v));
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.NotIn,
      undefined,
      values,
      paramNames
    );
    return this.addNode(node);
  }

  like(pattern: string): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(pattern);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.Like,
      pattern,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  ilike(pattern: string): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(pattern);
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.ILike,
      pattern,
      undefined,
      [paramName]
    );
    return this.addNode(node);
  }

  isNull(): QueryBuilder<TSchema> {
    const node = createComparisonNode(this.column, ComparisonOperator.IsNull);
    return this.addNode(node);
  }

  isNotNull(): QueryBuilder<TSchema> {
    const node = createComparisonNode(this.column, ComparisonOperator.IsNotNull);
    return this.addNode(node);
  }

  startsWith(value: string): QueryBuilder<TSchema> {
    return this.like(`${value}%`);
  }

  endsWith(value: string): QueryBuilder<TSchema> {
    return this.like(`%${value}`);
  }

  contains(value: string): QueryBuilder<TSchema> {
    return this.like(`%${value}%`);
  }

  jsonContains(value: any): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createJsonNode(this.column, JsonOperator.Contains, {
      value,
      parameterName: paramName,
    });
    return this.addNode(node);
  }

  jsonContainedBy(value: any): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(value);
    const node = createJsonNode(this.column, JsonOperator.ContainedBy, {
      value,
      parameterName: paramName,
    });
    return this.addNode(node);
  }

  jsonHasKey(key: string): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(key);
    const node = createJsonNode(this.column, JsonOperator.HasKey, {
      keys: [key],
      parameterName: paramName,
    });
    return this.addNode(node);
  }

  jsonHasAnyKey(keys: string[]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(keys);
    const node = createJsonNode(this.column, JsonOperator.HasAnyKey, {
      keys,
      parameterName: paramName,
    });
    return this.addNode(node);
  }

  jsonHasAllKeys(keys: string[]): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(keys);
    const node = createJsonNode(this.column, JsonOperator.HasAllKeys, {
      keys,
      parameterName: paramName,
    });
    return this.addNode(node);
  }

  jsonPathExists(path: string): QueryBuilder<TSchema> {
    const paramName = this.paramManager.addParameterWithValue(path);
    const node = createJsonNode(this.column, JsonOperator.PathExists, {
      path,
      parameterName: paramName,
    });
    return this.addNode(node);
  }

  search(query: string, options?: SearchOptions): QueryBuilder<TSchema> {
    const mode = options?.mode === 'phrase' 
      ? FullTextMode.Phrase 
      : options?.mode === 'websearch'
      ? FullTextMode.WebSearch
      : FullTextMode.Plain;
    const language = options?.language || 'english';
    const paramName = this.paramManager.addParameterWithValue(query);
    
    const node = createFullTextNode([this.column], query, mode, language, paramName);
    return this.addNode(node);
  }

  exists(subquery: QueryBuilder<any>): QueryBuilder<TSchema> {
    const subqueryAST = subquery.getAST();
    if (!subqueryAST) {
      throw new Error('Subquery must have at least one condition');
    }
    const node = createSubqueryNode('EXISTS', subqueryAST, this.column);
    return this.addNode(node);
  }

  notExists(subquery: QueryBuilder<any>): QueryBuilder<TSchema> {
    const subqueryAST = subquery.getAST();
    if (!subqueryAST) {
      throw new Error('Subquery must have at least one condition');
    }
    const node = createSubqueryNode('NOT EXISTS', subqueryAST, this.column);
    return this.addNode(node);
  }

  inSubquery(subquery: QueryBuilder<any>): QueryBuilder<TSchema> {
    const subqueryAST = subquery.getAST();
    if (!subqueryAST) {
      throw new Error('Subquery must have at least one condition');
    }
    const node = createSubqueryNode('IN', subqueryAST, this.column);
    return this.addNode(node);
  }

  notInSubquery(subquery: QueryBuilder<any>): QueryBuilder<TSchema> {
    const subqueryAST = subquery.getAST();
    if (!subqueryAST) {
      throw new Error('Subquery must have at least one condition');
    }
    const node = createSubqueryNode('NOT IN', subqueryAST, this.column);
    return this.addNode(node);
  }

  equalsColumn(column: string): QueryBuilder<TSchema> {
    // For correlated subqueries - column reference without parameter
    const node = createComparisonNode(
      this.column,
      ComparisonOperator.Equal,
      column,
      undefined,
      undefined
    );
    return this.addNode(node);
  }
}
