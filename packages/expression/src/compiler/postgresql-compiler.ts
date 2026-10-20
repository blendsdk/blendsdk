/**
 * PostgreSQL SQL compiler
 * Compiles AST nodes to PostgreSQL-compatible SQL
 */

import { ParameterManager } from '../core/parameter-manager.js';
import {
  ASTNode,
  ComparisonNode,
  LogicalNode,
  GroupNode,
  JsonNode,
  FullTextNode,
  SubqueryNode,
  ComparisonOperator,
  LogicalOperator,
  JsonOperator,
  FullTextMode,
  isComparisonNode,
  isLogicalNode,
  isGroupNode,
  isJsonNode,
  isFullTextNode,
  isSubqueryNode,
} from '../core/types.js';

/**
 * PostgreSQL compiler
 */
export class PostgreSQLCompiler {
  private optimizations: string[] = [];
  private warnings: string[] = [];

  constructor(private readonly paramManager: ParameterManager) {}

  /**
   * Compile AST to SQL
   */
  compile(ast: ASTNode): string {
    return this.compileNode(ast);
  }

  /**
   * Get applied optimizations
   */
  getOptimizations(): string[] {
    return this.optimizations;
  }

  /**
   * Get warnings
   */
  getWarnings(): string[] {
    return this.warnings;
  }

  /**
   * Compile a single AST node
   */
  private compileNode(node: ASTNode): string {
    if (isComparisonNode(node)) {
      return this.compileComparison(node);
    } else if (isLogicalNode(node)) {
      return this.compileLogical(node);
    } else if (isGroupNode(node)) {
      return this.compileGroup(node);
    } else if (isJsonNode(node)) {
      return this.compileJson(node);
    } else if (isFullTextNode(node)) {
      return this.compileFullText(node);
    } else if (isSubqueryNode(node)) {
      return this.compileSubquery(node);
    }

    throw new Error(`Unknown node type: ${node.type}`);
  }

  /**
   * Compile comparison node
   */
  private compileComparison(node: ComparisonNode): string {
    const { column, operator, parameterNames } = node;

    switch (operator) {
      case ComparisonOperator.Equal:
      case ComparisonOperator.NotEqual:
      case ComparisonOperator.GreaterThan:
      case ComparisonOperator.GreaterThanOrEqual:
      case ComparisonOperator.LessThan:
      case ComparisonOperator.LessThanOrEqual:
        if (parameterNames && parameterNames.length > 0) {
          const placeholder = this.paramManager.formatParameterPlaceholder(parameterNames[0]);
          return `${column} ${operator} ${placeholder}`;
        } else {
          // Column reference (for correlated subqueries)
          return `${column} ${operator} ${node.value}`;
        }

      case ComparisonOperator.Like:
      case ComparisonOperator.ILike:
        if (parameterNames && parameterNames.length > 0) {
          const placeholder = this.paramManager.formatParameterPlaceholder(parameterNames[0]);
          return `${column} ${operator} ${placeholder}`;
        }
        throw new Error('LIKE operator requires a parameter');

      case ComparisonOperator.Between:
      case ComparisonOperator.NotBetween:
        if (parameterNames && parameterNames.length === 2) {
          const minPlaceholder = this.paramManager.formatParameterPlaceholder(parameterNames[0]);
          const maxPlaceholder = this.paramManager.formatParameterPlaceholder(parameterNames[1]);
          return `${column} ${operator} ${minPlaceholder} AND ${maxPlaceholder}`;
        }
        throw new Error('BETWEEN operator requires two parameters');

      case ComparisonOperator.In:
      case ComparisonOperator.NotIn:
        if (parameterNames && parameterNames.length > 0) {
          const placeholders = parameterNames
            .map(name => this.paramManager.formatParameterPlaceholder(name))
            .join(', ');
          return `${column} ${operator} (${placeholders})`;
        }
        // Handle empty IN arrays - return empty parentheses
        return `${column} ${operator} ()`;

      case ComparisonOperator.IsNull:
        return `${column} IS NULL`;

      case ComparisonOperator.IsNotNull:
        return `${column} IS NOT NULL`;

      default:
        throw new Error(`Unknown comparison operator: ${operator}`);
    }
  }

  /**
   * Compile logical node (AND/OR)
   */
  private compileLogical(node: LogicalNode): string {
    const left = this.compileNode(node.left);
    const right = this.compileNode(node.right);
    return `${left} ${node.operator} ${right}`;
  }

  /**
   * Compile group node (parentheses)
   */
  private compileGroup(node: GroupNode): string {
    const inner = this.compileNode(node.child);
    return `(${inner})`;
  }

  /**
   * Compile JSON node
   */
  private compileJson(node: JsonNode): string {
    const { column, operator, parameterName } = node;

    if (!parameterName) {
      throw new Error('JSON operation requires a parameter');
    }

    const placeholder = this.paramManager.formatParameterPlaceholder(parameterName);

    switch (operator) {
      case JsonOperator.Contains:
        // PostgreSQL @> operator
        return `${column} @> ${placeholder}`;

      case JsonOperator.ContainedBy:
        // PostgreSQL <@ operator
        return `${column} <@ ${placeholder}`;

      case JsonOperator.HasKey:
        // PostgreSQL ? operator
        return `${column} ? ${placeholder}`;

      case JsonOperator.HasAnyKey:
        // PostgreSQL ?| operator
        return `${column} ?| ${placeholder}`;

      case JsonOperator.HasAllKeys:
        // PostgreSQL ?& operator
        return `${column} ?& ${placeholder}`;

      case JsonOperator.PathExists:
        // PostgreSQL @? operator
        return `${column} @? ${placeholder}`;

      default:
        throw new Error(`Unknown JSON operator: ${operator}`);
    }
  }

  /**
   * Compile full-text search node
   */
  private compileFullText(node: FullTextNode): string {
    const { columns, mode, language, parameterName } = node;
    const placeholder = this.paramManager.formatParameterPlaceholder(parameterName);

    // Build tsvector expression
    let tsvectorExpr: string;
    if (columns.length === 1) {
      tsvectorExpr = `to_tsvector('${language}', ${columns[0]})`;
    } else {
      // Concatenate multiple columns
      const concatenated = columns.join(" || ' ' || ");
      tsvectorExpr = `to_tsvector('${language}', ${concatenated})`;
    }

    // Build tsquery expression based on mode
    let tsqueryExpr: string;
    switch (mode) {
      case FullTextMode.Plain:
        tsqueryExpr = `plainto_tsquery('${language}', ${placeholder})`;
        break;
      case FullTextMode.Phrase:
        tsqueryExpr = `phraseto_tsquery('${language}', ${placeholder})`;
        break;
      case FullTextMode.WebSearch:
        tsqueryExpr = `websearch_to_tsquery('${language}', ${placeholder})`;
        break;
      default:
        tsqueryExpr = `plainto_tsquery('${language}', ${placeholder})`;
    }

    return `${tsvectorExpr} @@ ${tsqueryExpr}`;
  }

  /**
   * Compile subquery node
   */
  private compileSubquery(node: SubqueryNode): string {
    const { column, operator, subquery } = node;
    const subquerySQL = this.compileNode(subquery);

    switch (operator) {
      case 'EXISTS':
        return `EXISTS (SELECT 1 WHERE ${subquerySQL})`;

      case 'NOT EXISTS':
        return `NOT EXISTS (SELECT 1 WHERE ${subquerySQL})`;

      case 'IN':
        if (!column) {
          throw new Error('IN subquery requires a column');
        }
        return `${column} IN (SELECT * WHERE ${subquerySQL})`;

      case 'NOT IN':
        if (!column) {
          throw new Error('NOT IN subquery requires a column');
        }
        return `${column} NOT IN (SELECT * WHERE ${subquerySQL})`;

      default:
        throw new Error(`Unknown subquery operator: ${operator}`);
    }
  }
}
