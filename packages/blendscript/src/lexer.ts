import { sourceDiagnostic } from './diagnostics.js';
import {
  MAX_FIELD_NAME_LENGTH,
  MAX_SOURCE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TOKEN_COUNT,
} from './limits.js';
import { matchDecimalNumberPrefix } from './number-parsing.js';
import type { SourceExpressionDiagnostic } from './types.js';

/** Internal lexical token kinds consumed by the parser. */
export type TokenKind =
  | 'number'
  | 'string'
  | 'field'
  | 'identifier'
  | 'true'
  | 'false'
  | 'null'
  | 'and'
  | 'or'
  | 'not'
  | 'in'
  | 'leftParen'
  | 'rightParen'
  | 'comma'
  | 'equal'
  | 'notEqual'
  | 'less'
  | 'lessEqual'
  | 'greater'
  | 'greaterEqual'
  | 'eof';

/** One decoded private token with its original half-open source span. */
export interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;
  readonly value?: string | number | boolean | null;
}

/** Result of the bounded lexical pass. */
export type LexResult =
  | Readonly<{ ok: true; tokens: readonly Token[] }>
  | Readonly<{ ok: false; diagnostic: SourceExpressionDiagnostic }>;

const keywordKinds: Readonly<Record<string, TokenKind>> = Object.freeze({
  TRUE: 'true',
  FALSE: 'false',
  NULL: 'null',
  AND: 'and',
  OR: 'or',
  NOT: 'not',
  IN: 'in',
});

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_]/u.test(character);
}

function isHex(character: string): boolean {
  return /[0-9A-Fa-f]/u.test(character);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Tokenizes one expression without executing or resolving any authored name. */
export function lex(source: string): LexResult {
  if (source.length > MAX_SOURCE_LENGTH) {
    return {
      ok: false,
      diagnostic: sourceDiagnostic(
        source,
        'BS_SOURCE_TOO_LONG',
        `Expression source cannot exceed ${MAX_SOURCE_LENGTH} UTF-16 code units.`,
        MAX_SOURCE_LENGTH,
        MAX_SOURCE_LENGTH + 1
      ),
    };
  }

  const tokens: Token[] = [];
  let cursor = 0;

  const fail = (
    code: SourceExpressionDiagnostic['code'],
    message: string,
    start: number,
    end: number
  ): LexResult => ({ ok: false, diagnostic: sourceDiagnostic(source, code, message, start, end) });

  const push = (token: Token): LexResult | undefined => {
    if (tokens.length === MAX_TOKEN_COUNT) {
      return fail(
        'BS_TOKEN_LIMIT_EXCEEDED',
        `Expression cannot contain more than ${MAX_TOKEN_COUNT} tokens.`,
        token.start,
        token.end
      );
    }
    tokens.push(Object.freeze(token));
    return undefined;
  };

  while (cursor < source.length) {
    const character = source[cursor] ?? '';
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }

    const start = cursor;
    if (character === '"') {
      cursor += 1;
      let value = '';
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor] ?? '';
        if (current === '"') {
          cursor += 1;
          closed = true;
          break;
        }
        if (current === '\n' || current === '\r' || current === '\u2028' || current === '\u2029') {
          return fail(
            'BS_INVALID_STRING',
            'String literals cannot contain raw line breaks.',
            start,
            cursor + 1
          );
        }
        if (current === '\\') {
          const escapeStart = cursor;
          cursor += 1;
          const escape = source[cursor] ?? '';
          const simpleEscapes: Readonly<Record<string, string>> = {
            '"': '"',
            '\\': '\\',
            n: '\n',
            r: '\r',
            t: '\t',
            b: '\b',
            f: '\f',
          };
          if (Object.hasOwn(simpleEscapes, escape)) {
            value += simpleEscapes[escape];
            cursor += 1;
          } else if (escape === 'u') {
            const hex = source.slice(cursor + 1, cursor + 5);
            if (hex.length !== 4 || [...hex].some(part => !isHex(part))) {
              return fail(
                'BS_INVALID_STRING',
                'Unicode escapes require exactly four hexadecimal digits.',
                escapeStart,
                Math.min(source.length, cursor + 5)
              );
            }
            const code = Number.parseInt(hex, 16);
            cursor += 5;
            if (isHighSurrogate(code)) {
              if (source.slice(cursor, cursor + 2) !== '\\u') {
                return fail(
                  'BS_INVALID_STRING',
                  'A high surrogate escape must be followed by a low surrogate escape.',
                  escapeStart,
                  cursor
                );
              }
              const lowHex = source.slice(cursor + 2, cursor + 6);
              if (lowHex.length !== 4 || [...lowHex].some(part => !isHex(part))) {
                return fail(
                  'BS_INVALID_STRING',
                  'Unicode escapes require exactly four hexadecimal digits.',
                  cursor,
                  Math.min(source.length, cursor + 6)
                );
              }
              const lowCode = Number.parseInt(lowHex, 16);
              if (!isLowSurrogate(lowCode)) {
                return fail(
                  'BS_INVALID_STRING',
                  'A high surrogate escape must be followed by a low surrogate escape.',
                  escapeStart,
                  cursor + 6
                );
              }
              value += String.fromCharCode(code, lowCode);
              cursor += 6;
            } else if (isLowSurrogate(code)) {
              return fail(
                'BS_INVALID_STRING',
                'A low surrogate escape requires a preceding high surrogate escape.',
                escapeStart,
                cursor
              );
            } else {
              value += String.fromCharCode(code);
            }
          } else {
            return fail(
              'BS_INVALID_STRING',
              'The string contains an unsupported escape sequence.',
              escapeStart,
              Math.min(source.length, cursor + 1)
            );
          }
        } else {
          const code = source.charCodeAt(cursor);
          if (isHighSurrogate(code)) {
            const lowCode = source.charCodeAt(cursor + 1);
            if (!isLowSurrogate(lowCode)) {
              return fail(
                'BS_INVALID_STRING',
                'String literals cannot contain an unpaired surrogate.',
                cursor,
                cursor + 1
              );
            }
            value += source.slice(cursor, cursor + 2);
            cursor += 2;
          } else if (isLowSurrogate(code)) {
            return fail(
              'BS_INVALID_STRING',
              'String literals cannot contain an unpaired surrogate.',
              cursor,
              cursor + 1
            );
          } else {
            value += current;
            cursor += 1;
          }
        }
        if (value.length > MAX_STRING_LENGTH) {
          return fail(
            'BS_STRING_LITERAL_TOO_LONG',
            `String literals cannot exceed ${MAX_STRING_LENGTH} UTF-16 code units.`,
            start,
            cursor
          );
        }
      }
      if (!closed)
        return fail(
          'BS_INVALID_STRING',
          'The string literal is missing its closing quote.',
          start,
          source.length
        );
      const result = push({ kind: 'string', value, start, end: cursor });
      if (result) return result;
      continue;
    }

    if (character === '[') {
      cursor += 1;
      let value = '';
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === ']') {
          if (source[cursor + 1] === ']') {
            value += ']';
            cursor += 2;
          } else {
            cursor += 1;
            closed = true;
            break;
          }
        } else {
          value += source[cursor] ?? '';
          cursor += 1;
        }
        if (value.length > MAX_FIELD_NAME_LENGTH) {
          return fail(
            'BS_FIELD_NAME_TOO_LONG',
            `Field names cannot exceed ${MAX_FIELD_NAME_LENGTH} UTF-16 code units.`,
            start,
            cursor
          );
        }
      }
      if (!closed || value.length === 0) {
        return fail(
          'BS_UNEXPECTED_TOKEN',
          closed
            ? 'Bracketed field names cannot be empty.'
            : 'The field name is missing its closing bracket.',
          start,
          cursor
        );
      }
      const result = push({ kind: 'field', value, start, end: cursor });
      if (result) return result;
      continue;
    }

    const raw = matchDecimalNumberPrefix(source.slice(cursor));
    if (raw !== undefined && raw.length > 0) {
      cursor += raw.length;
      if (isIdentifierPart(source[cursor] ?? '') || source[cursor] === '.') {
        while (cursor < source.length && /[A-Za-z0-9_.]/u.test(source[cursor] ?? '')) cursor += 1;
        return fail('BS_INVALID_NUMBER', 'The number literal is malformed.', start, cursor);
      }
      const value = Number(raw);
      if (!Number.isFinite(value))
        return fail('BS_INVALID_NUMBER', 'Number literals must be finite.', start, cursor);
      const result = push({ kind: 'number', value, start, end: cursor });
      if (result) return result;
      continue;
    }

    if (isIdentifierStart(character)) {
      cursor += 1;
      while (cursor < source.length && isIdentifierPart(source[cursor] ?? '')) cursor += 1;
      const value = source.slice(start, cursor);
      const upper = value.toUpperCase();
      const keyword = Object.hasOwn(keywordKinds, upper) ? keywordKinds[upper] : undefined;
      const kind = keyword ?? 'identifier';
      const tokenValue =
        kind === 'true' ? true : kind === 'false' ? false : kind === 'null' ? null : value;
      const result = push({ kind, value: tokenValue, start, end: cursor });
      if (result) return result;
      continue;
    }

    const two = source.slice(cursor, cursor + 2);
    const twoKinds: Readonly<Record<string, TokenKind>> = {
      '==': 'equal',
      '!=': 'notEqual',
      '<=': 'lessEqual',
      '>=': 'greaterEqual',
      '&&': 'and',
      '||': 'or',
    };
    if (Object.hasOwn(twoKinds, two)) {
      cursor += 2;
      const result = push({ kind: twoKinds[two] ?? 'eof', start, end: cursor });
      if (result) return result;
      continue;
    }

    const oneKinds: Readonly<Record<string, TokenKind>> = {
      '(': 'leftParen',
      ')': 'rightParen',
      ',': 'comma',
      '<': 'less',
      '>': 'greater',
      '!': 'not',
    };
    if (Object.hasOwn(oneKinds, character)) {
      cursor += 1;
      const result = push({ kind: oneKinds[character] ?? 'eof', start, end: cursor });
      if (result) return result;
      continue;
    }

    return fail(
      'BS_INVALID_CHARACTER',
      `Character ${JSON.stringify(character)} is not valid BlendScript syntax.`,
      start,
      start + 1
    );
  }

  tokens.push(Object.freeze({ kind: 'eof', start: cursor, end: cursor }));
  return Object.freeze({ ok: true, tokens: Object.freeze(tokens) });
}
