/**
 * AST node factory functions
 * Creates immutable AST nodes for the expression tree
 */

import {
  ASTNode,
  ASTNodeType,
  ComparisonNode,
  ComparisonOperator,
  LogicalNode,
  LogicalOperator,
  GroupNode,
  JsonNode,
  JsonOperator,
  FullTextNode,
  FullTextMode,
  SubqueryNode,
} from './types.js';

/**
 * Generate unique node ID
 */
let nodeIdCounter = 0;
function generateNodeId(): string {
  return `node_${++nodeIdCounter}`;
}

/**
 * Reset node ID counter (useful for testing)
 */
export function resetNodeIdCounter(): void {
  nodeIdCounter = 0;
}

/**
 * Create a comparison node
 */
export function createComparisonNode(
  column: string,
  operator: ComparisonOperator,
  value?: any,
  values?: any[],
  parameterNames?: string[]
): ComparisonNode {
  return Object.freeze({
    type: ASTNodeType.Comparison,
    id: generateNodeId(),
    column,
    operator,
    value,
    values,
    parameterNames,
  });
}

/**
 * Create a logical node (AND/OR)
 */
export function createLogicalNode(
  operator: LogicalOperator,
  left: ASTNode,
  right: ASTNode
): LogicalNode {
  return Object.freeze({
    type: ASTNodeType.Logical,
    id: generateNodeId(),
    operator,
    left,
    right,
  });
}

/**
 * Create a group node (for parentheses)
 */
export function createGroupNode(child: ASTNode): GroupNode {
  return Object.freeze({
    type: ASTNodeType.Group,
    id: generateNodeId(),
    child,
  });
}

/**
 * Create a JSON operation node
 */
export function createJsonNode(
  column: string,
  operator: JsonOperator,
  options: {
    value?: any;
    path?: string;
    keys?: string[];
    parameterName?: string;
  } = {}
): JsonNode {
  return Object.freeze({
    type: ASTNodeType.Json,
    id: generateNodeId(),
    column,
    operator,
    ...options,
  });
}

/**
 * Create a full-text search node
 */
export function createFullTextNode(
  columns: string[],
  query: string,
  mode: FullTextMode,
  language: string,
  parameterName: string
): FullTextNode {
  return Object.freeze({
    type: ASTNodeType.FullText,
    id: generateNodeId(),
    columns,
    query,
    mode,
    language,
    parameterName,
  });
}

/**
 * Create a subquery node
 */
export function createSubqueryNode(
  operator: SubqueryNode['operator'],
  subquery: ASTNode,
  column?: string
): SubqueryNode {
  return Object.freeze({
    type: ASTNodeType.Subquery,
    id: generateNodeId(),
    column,
    operator,
    subquery,
  });
}

/**
 * Clone an AST node (creates a new immutable copy)
 */
export function cloneNode<T extends ASTNode>(node: T): T {
  return Object.freeze({ ...node, id: generateNodeId() }) as T;
}

/**
 * Check if two nodes are structurally equal (ignoring IDs)
 */
export function nodesEqual(a: ASTNode, b: ASTNode): boolean {
  if (a.type !== b.type) return false;

  switch (a.type) {
    case ASTNodeType.Comparison: {
      const nodeA = a as ComparisonNode;
      const nodeB = b as ComparisonNode;
      return (
        nodeA.column === nodeB.column &&
        nodeA.operator === nodeB.operator &&
        nodeA.value === nodeB.value &&
        JSON.stringify(nodeA.values) === JSON.stringify(nodeB.values)
      );
    }

    case ASTNodeType.Logical: {
      const nodeA = a as LogicalNode;
      const nodeB = b as LogicalNode;
      return (
        nodeA.operator === nodeB.operator &&
        nodesEqual(nodeA.left, nodeB.left) &&
        nodesEqual(nodeA.right, nodeB.right)
      );
    }

    case ASTNodeType.Group: {
      const nodeA = a as GroupNode;
      const nodeB = b as GroupNode;
      return nodesEqual(nodeA.child, nodeB.child);
    }

    case ASTNodeType.Json: {
      const nodeA = a as JsonNode;
      const nodeB = b as JsonNode;
      return (
        nodeA.column === nodeB.column &&
        nodeA.operator === nodeB.operator &&
        JSON.stringify(nodeA.value) === JSON.stringify(nodeB.value) &&
        nodeA.path === nodeB.path &&
        JSON.stringify(nodeA.keys) === JSON.stringify(nodeB.keys)
      );
    }

    case ASTNodeType.FullText: {
      const nodeA = a as FullTextNode;
      const nodeB = b as FullTextNode;
      return (
        JSON.stringify(nodeA.columns) === JSON.stringify(nodeB.columns) &&
        nodeA.query === nodeB.query &&
        nodeA.mode === nodeB.mode &&
        nodeA.language === nodeB.language
      );
    }

    case ASTNodeType.Subquery: {
      const nodeA = a as SubqueryNode;
      const nodeB = b as SubqueryNode;
      return (
        nodeA.column === nodeB.column &&
        nodeA.operator === nodeB.operator &&
        nodesEqual(nodeA.subquery, nodeB.subquery)
      );
    }

    default:
      return false;
  }
}
