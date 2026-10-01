import { describe, expect, it } from 'vitest';

import { validateExpression } from '../src/index.js';

const emptyOptions = Object.freeze({ schema: Object.freeze({}) });

function expectDiagnostic(source: string, code: string, options: object = emptyOptions): void {
  expect(validateExpression(source, options as never)).toMatchObject({
    ok: false,
    diagnostics: [{ code }],
  });
}

describe('BlendScript lexical grammar, parser, and analyzer', () => {
  it('should validate fields, precedence-bearing operators, and references', () => {
    const options = {
      schema: {
        Country: { type: 'string' },
        'Order Total': { type: 'number' },
      },
      expectedResult: 'boolean',
    } as const;

    expect(validateExpression('Country == "NL" AND [Order Total] >= 1000', options)).toEqual({
      ok: true,
      resultType: { type: 'boolean', nullable: false },
      referencedFields: ['Country', 'Order Total'],
    });
  });

  it('should reject chained comparisons at the second operator', () => {
    expect(validateExpression('1 < 2 < 3', emptyOptions)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_UNEXPECTED_TOKEN', span: { start: 6, end: 7 } }],
    });
  });

  it('should enforce the closed membership-list grammar and compatible types', () => {
    const nullable = { schema: { Country: { type: 'string', nullable: true } } } as const;
    const required = { schema: { Country: { type: 'string' } } } as const;

    expect(validateExpression('Country IN ("GB", "NL", "NL")', required)).toMatchObject({
      ok: true,
    });
    expect(validateExpression('Country IN ("NL", NULL)', nullable)).toMatchObject({ ok: true });
    expectDiagnostic('Country IN ()', 'BS_UNEXPECTED_TOKEN', required);
    expectDiagnostic('Country IN ("NL",)', 'BS_UNEXPECTED_TOKEN', required);
    expectDiagnostic('Country IN (Other)', 'BS_UNEXPECTED_TOKEN', {
      schema: { Country: { type: 'string' }, Other: { type: 'string' } },
    });
    expectDiagnostic('Country IN (NULL)', 'BS_TYPE_MISMATCH', required);
  });

  it('should accept direct Unicode, paired surrogate escapes, and every approved escape', () => {
    const sources = ['"😀"', '"\\uD83D\\uDE00"', String.raw`"\"\\\n\r\t\b\f\u0041"`];
    for (const source of sources)
      expect(validateExpression(source, emptyOptions)).toMatchObject({ ok: true });
  });

  it('should reject malformed strings without scanning beyond the first source error', () => {
    for (const source of [
      '"line\nbreak"',
      '"line\u2028break"',
      '"line\u2029break"',
      '"\\x"',
      '"\\u123"',
      '"\\uD83D"',
    ]) {
      expectDiagnostic(source, 'BS_INVALID_STRING');
    }
  });

  it('should accept finite decimal forms and reject forbidden or non-finite forms', () => {
    for (const source of ['0', '007', '-12.5', '+2', '.5', '5.', '1e3', '-2.5E-2']) {
      expect(validateExpression(source, emptyOptions)).toMatchObject({ ok: true });
    }
    for (const source of [
      '0x10',
      '0b10',
      '0o10',
      '1_000',
      'NaN',
      'Infinity',
      '+',
      '.',
      '1e',
      '1e309',
      '-1e309',
    ]) {
      const result = validateExpression(source, emptyOptions);
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.diagnostics).toHaveLength(1);
    }
  });

  it('should reject all out-of-scope syntax and unknown call targets', () => {
    const sources = [
      'A.B',
      'A[0]',
      'A + 1',
      'A ? TRUE : FALSE',
      '`template`',
      '/regex/',
      '{ value: 1 }',
      '[1, 2]',
      'new Thing()',
      'function () {}',
      'A = 1',
      'A; TRUE',
      'A // comment',
    ];
    const options = { schema: { A: { type: 'number' } } } as const;
    for (const source of sources)
      expect(validateExpression(source, options)).toMatchObject({ ok: false });

    expect(validateExpression('foo()', emptyOptions)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_UNEXPECTED_TOKEN', span: { start: 3, end: 4 } }],
    });
  });

  it('should bind exact schema names without normalization or suggestions', () => {
    const result = validateExpression('missing', { schema: { Missing: { type: 'boolean' } } });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'BS_UNKNOWN_FIELD',
          span: { start: 0, end: 7 },
        },
      ],
    });
    if (!result.ok) expect(result.diagnostics[0]).not.toHaveProperty('suggestion');
  });

  it('should decode bracket escaping and distinguish fields from built-in calls', () => {
    const options = {
      schema: {
        AND: { type: 'boolean' },
        trim: { type: 'string' },
        'A]B': { type: 'boolean' },
      },
    } as const;
    expect(validateExpression('[AND] AND [A]]B]', options)).toMatchObject({ ok: true });
    expect(validateExpression('[trim] == "x"', options)).toMatchObject({ ok: true });
    expect(validateExpression('trim == "x"', options)).toMatchObject({ ok: true });
    expectDiagnostic('trim', 'BS_UNEXPECTED_TOKEN');
    expectDiagnostic('[trim]', 'BS_UNKNOWN_FIELD');
    expect(validateExpression('Missing AND trim', emptyOptions)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_UNEXPECTED_TOKEN', span: { start: 12, end: 16 } }],
    });
    expect(validateExpression('AND', options)).toMatchObject({ ok: false });
  });

  it('should reject statically incompatible operations without coercion', () => {
    const options = {
      schema: {
        Text: { type: 'string' },
        Count: { type: 'number' },
        Enabled: { type: 'boolean' },
      },
    } as const;
    for (const source of [
      'Text == Count',
      'Text < "z"',
      'Count AND Enabled',
      'contains(Count, "1")',
    ]) {
      expectDiagnostic(source, 'BS_TYPE_MISMATCH', options);
    }
  });

  it('should enforce token, literal, field, and nesting limits inclusively', () => {
    const validTokens = `!${Array.from({ length: 2_048 }, () => 'TRUE').join('||')}`;
    expect(validateExpression(validTokens, emptyOptions)).toMatchObject({ ok: true });
    expectDiagnostic(`!${validTokens}`, 'BS_TOKEN_LIMIT_EXCEEDED');

    expect(validateExpression(`"${'a'.repeat(4_096)}"`, emptyOptions)).toMatchObject({ ok: true });
    expectDiagnostic(`"${'a'.repeat(4_097)}"`, 'BS_STRING_LITERAL_TOO_LONG');

    const field256 = 'F'.repeat(256);
    expect(
      validateExpression(`[${field256}]`, { schema: { [field256]: { type: 'boolean' } } })
    ).toMatchObject({
      ok: true,
    });
    expectDiagnostic(`[${'F'.repeat(257)}]`, 'BS_FIELD_NAME_TOO_LONG');

    expect(
      validateExpression(`${'('.repeat(64)}TRUE${')'.repeat(64)}`, emptyOptions)
    ).toMatchObject({ ok: true });
    expectDiagnostic(`${'('.repeat(65)}TRUE${')'.repeat(65)}`, 'BS_NESTING_LIMIT_EXCEEDED');
  });

  it('should report built-in arity separately from argument type errors', () => {
    expectDiagnostic('trim()', 'BS_INVALID_ARGUMENT_COUNT');
    expectDiagnostic('trim("a", "b")', 'BS_INVALID_ARGUMENT_COUNT');
    expectDiagnostic('trim(TRUE)', 'BS_TYPE_MISMATCH');
  });

  it('should accept literal null only for null-aware built-ins', () => {
    expect(validateExpression('isEmpty(NULL)', emptyOptions)).toMatchObject({ ok: true });
    expect(validateExpression('isBlank(NULL)', emptyOptions)).toMatchObject({ ok: true });
    expect(validateExpression('tryNumber(NULL)', emptyOptions)).toMatchObject({ ok: true });
    expectDiagnostic('trim(NULL)', 'BS_TYPE_MISMATCH');
    expectDiagnostic('text(NULL)', 'BS_TYPE_MISMATCH');
  });

  it('should not charge non-recursive IN list parentheses against nesting', () => {
    const source = `${'('.repeat(64)}A IN (1)${')'.repeat(64)}`;
    expect(validateExpression(source, { schema: { A: { type: 'number' } } })).toMatchObject({
      ok: true,
    });
  });
});
