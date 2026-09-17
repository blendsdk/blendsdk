import type { SourceSpan } from './types.js';

/** A literal scalar embedded directly in source. */
export interface LiteralNode {
  readonly kind: 'literal';
  readonly value: string | number | boolean | null;
  readonly span: SourceSpan;
}

/** A schema-bound field reference. */
export interface FieldNode {
  readonly kind: 'field';
  readonly name: string;
  readonly span: SourceSpan;
}

/** Logical negation of one expression. */
export interface UnaryNode {
  readonly kind: 'unary';
  readonly operator: 'not';
  readonly operand: ExpressionNode;
  readonly span: SourceSpan;
}

/** A two-operand logical or comparison expression. */
export interface BinaryNode {
  readonly kind: 'binary';
  readonly operator:
    'and' | 'or' | 'equal' | 'notEqual' | 'less' | 'lessEqual' | 'greater' | 'greaterEqual';
  readonly left: ExpressionNode;
  readonly right: ExpressionNode;
  readonly span: SourceSpan;
}

/** Strict membership in a non-empty literal list. */
export interface MembershipNode {
  readonly kind: 'membership';
  readonly value: ExpressionNode;
  readonly members: readonly LiteralNode[];
  readonly span: SourceSpan;
}

/** A call to one of the fixed built-in functions. */
export interface CallNode {
  readonly kind: 'call';
  readonly name: string;
  readonly arguments: readonly ExpressionNode[];
  readonly span: SourceSpan;
}

/** The complete private v1 expression tree. */
export type ExpressionNode =
  LiteralNode | FieldNode | UnaryNode | BinaryNode | MembershipNode | CallNode;

/** Creates an immutable source span. */
export function span(start: number, end: number): SourceSpan {
  return Object.freeze({ start, end });
}
