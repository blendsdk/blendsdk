import type {
  BinaryNode,
  CallNode,
  ExpressionNode,
  FieldNode,
  LiteralNode,
  MembershipNode,
  UnaryNode,
} from './ast.js';
import { span } from './ast.js';
import { isBuiltinName } from './builtins.js';
import { sourceDiagnostic } from './diagnostics.js';
import type { Token, TokenKind } from './lexer.js';
import { MAX_NESTING_DEPTH } from './limits.js';
import type { SourceExpressionDiagnostic } from './types.js';

/** Result of parsing a complete token stream. */
export type ParseResult =
  | Readonly<{ ok: true; expression: ExpressionNode }>
  | Readonly<{ ok: false; diagnostic: SourceExpressionDiagnostic }>;

class ParserFailure extends Error {
  public constructor(public readonly diagnostic: SourceExpressionDiagnostic) {
    super(diagnostic.message);
  }
}

/** Parses tokens using explicit v1 precedence and one bounded nesting counter. */
export function parse(source: string, tokens: readonly Token[]): ParseResult {
  let cursor = 0;
  let nesting = 0;

  const current = (): Token =>
    tokens[cursor] ?? tokens[tokens.length - 1] ?? { kind: 'eof', start: 0, end: 0 };
  const advance = (): Token => {
    const token = current();
    if (cursor < tokens.length - 1) cursor += 1;
    return token;
  };
  const fail = (
    token: Token,
    message: string,
    code: SourceExpressionDiagnostic['code'] = 'BS_UNEXPECTED_TOKEN'
  ): never => {
    throw new ParserFailure(sourceDiagnostic(source, code, message, token.start, token.end));
  };
  const expect = (kind: TokenKind, message: string): Token => {
    if (current().kind !== kind) return fail(current(), message);
    return advance();
  };
  const nested = <T>(token: Token, action: () => T): T => {
    if (nesting >= MAX_NESTING_DEPTH) {
      return fail(
        token,
        `Expression nesting cannot exceed ${MAX_NESTING_DEPTH} levels.`,
        'BS_NESTING_LIMIT_EXCEEDED'
      );
    }
    nesting += 1;
    try {
      return action();
    } finally {
      nesting -= 1;
    }
  };

  const literalFromToken = (token: Token): LiteralNode =>
    Object.freeze({
      kind: 'literal',
      value: token.value ?? null,
      span: span(token.start, token.end),
    });

  const parsePrimary = (): ExpressionNode => {
    const token = current();
    if (
      token.kind === 'number' ||
      token.kind === 'string' ||
      token.kind === 'true' ||
      token.kind === 'false' ||
      token.kind === 'null'
    ) {
      advance();
      return literalFromToken(token);
    }
    if (token.kind === 'field') {
      advance();
      return Object.freeze({
        kind: 'field',
        name: String(token.value),
        span: span(token.start, token.end),
      } satisfies FieldNode);
    }
    if (token.kind === 'identifier') {
      advance();
      const name = String(token.value);
      if (current().kind !== 'leftParen') {
        return Object.freeze({
          kind: 'field',
          name,
          span: span(token.start, token.end),
        } satisfies FieldNode);
      }
      const opening = current();
      if (!isBuiltinName(name)) {
        return fail(opening, `Only documented BlendScript built-ins can be called.`);
      }
      return nested(opening, () => {
        advance();
        const argumentsList: ExpressionNode[] = [];
        if (current().kind !== 'rightParen') {
          while (true) {
            argumentsList.push(parseOr());
            if (current().kind !== 'comma') break;
            advance();
            if (current().kind === 'rightParen')
              return fail(current(), 'A trailing comma is not allowed in a call.');
          }
        }
        const closing = expect(
          'rightParen',
          'The built-in call is missing its closing parenthesis.'
        );
        return Object.freeze({
          kind: 'call',
          name: name.toLowerCase(),
          arguments: Object.freeze(argumentsList),
          span: span(token.start, closing.end),
        } satisfies CallNode);
      });
    }
    if (token.kind === 'leftParen') {
      return nested(token, () => {
        advance();
        const expression = parseOr();
        expect('rightParen', 'The grouped expression is missing its closing parenthesis.');
        return expression;
      });
    }
    return fail(token, 'Expected a literal, field, built-in call, or grouped expression.');
  };

  const parseNot = (): ExpressionNode => {
    if (current().kind !== 'not') return parsePrimary();
    const token = advance();
    return nested(token, () => {
      const operand = parseNot();
      return Object.freeze({
        kind: 'unary',
        operator: 'not',
        operand,
        span: span(token.start, operand.span.end),
      } satisfies UnaryNode);
    });
  };

  type ComparisonKind = Extract<
    TokenKind,
    'equal' | 'notEqual' | 'less' | 'lessEqual' | 'greater' | 'greaterEqual'
  >;
  const comparisonKinds = new Set<TokenKind>([
    'equal',
    'notEqual',
    'less',
    'lessEqual',
    'greater',
    'greaterEqual',
  ]);
  const isComparisonKind = (kind: TokenKind): kind is ComparisonKind => comparisonKinds.has(kind);

  const parseComparison = (): ExpressionNode => {
    const left = parseNot();
    const operator = current();
    if (isComparisonKind(operator.kind)) {
      advance();
      const right = parseNot();
      return Object.freeze({
        kind: 'binary',
        operator: operator.kind,
        left,
        right,
        span: span(left.span.start, right.span.end),
      } satisfies BinaryNode);
    }
    if (operator.kind !== 'in') return left;
    advance();
    const opening = expect('leftParen', 'IN must be followed by a parenthesized literal list.');
    return (() => {
      const members: LiteralNode[] = [];
      if (current().kind === 'rightParen')
        return fail(current(), 'IN requires at least one literal.');
      while (true) {
        const member = current();
        if (!['number', 'string', 'true', 'false', 'null'].includes(member.kind)) {
          return fail(member, 'IN members must be primitive literals.');
        }
        advance();
        members.push(literalFromToken(member));
        if (current().kind !== 'comma') break;
        advance();
        if (current().kind === 'rightParen')
          return fail(current(), 'A trailing comma is not allowed in IN.');
      }
      const closing = expect('rightParen', 'The IN list is missing its closing parenthesis.');
      return Object.freeze({
        kind: 'membership',
        value: left,
        members: Object.freeze(members),
        span: span(left.span.start, closing.end),
      } satisfies MembershipNode);
    })();
  };

  const parseAnd = (): ExpressionNode => {
    let expression = parseComparison();
    while (current().kind === 'and') {
      advance();
      const right = parseComparison();
      expression = Object.freeze({
        kind: 'binary',
        operator: 'and',
        left: expression,
        right,
        span: span(expression.span.start, right.span.end),
      } satisfies BinaryNode);
    }
    return expression;
  };

  function parseOr(): ExpressionNode {
    let expression = parseAnd();
    while (current().kind === 'or') {
      advance();
      const right = parseAnd();
      expression = Object.freeze({
        kind: 'binary',
        operator: 'or',
        left: expression,
        right,
        span: span(expression.span.start, right.span.end),
      } satisfies BinaryNode);
    }
    return expression;
  }

  try {
    const expression = parseOr();
    if (current().kind !== 'eof')
      fail(current(), 'Unexpected token after the complete expression.');
    return Object.freeze({ ok: true, expression });
  } catch (error) {
    if (error instanceof ParserFailure)
      return Object.freeze({ ok: false, diagnostic: error.diagnostic });
    throw error;
  }
}
