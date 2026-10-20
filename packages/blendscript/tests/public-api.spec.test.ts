import { describe, expect, it } from 'vitest';

import { compileExpression, validateExpression } from '../src/index.js';

const emptyOptions = Object.freeze({ schema: Object.freeze({}) });

describe('BlendScript public validation and compilation', () => {
  it('should infer every literal type when the source is valid', () => {
    const cases = [
      ['TRUE', { type: 'boolean', nullable: false }],
      ['"hello"', { type: 'string', nullable: false }],
      ['42', { type: 'number', nullable: false }],
      ['NULL', { type: 'null', nullable: true }],
    ] as const;

    for (const [source, resultType] of cases) {
      expect(validateExpression(source, emptyOptions)).toEqual({
        ok: true,
        resultType,
        referencedFields: [],
      });
    }
  });

  it('should enforce an exact expected result type when it is provided', () => {
    expect(
      validateExpression('TRUE', { ...emptyOptions, expectedResult: 'boolean' })
    ).toMatchObject({
      ok: true,
    });

    expect(
      validateExpression('"yes"', { ...emptyOptions, expectedResult: 'boolean' })
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_EXPECTED_RESULT_TYPE_MISMATCH' }],
    });

    expect(validateExpression('NULL', { ...emptyOptions, expectedResult: 'null' })).toMatchObject({
      ok: true,
    });
  });

  it('should preserve referenced fields in first-source-occurrence order', () => {
    const schema = {
      A: { type: 'boolean' },
      B: { type: 'boolean' },
    } as const;

    expect(validateExpression('B AND A AND B', { schema })).toMatchObject({
      ok: true,
      referencedFields: ['B', 'A'],
    });
  });

  it('should return the same normalized metadata and diagnostics from validate and compile', () => {
    const options = { schema: { Country: { type: 'string' } } } as const;
    const valid = validateExpression('Country == "NL"', options);
    const compiled = compileExpression('Country == "NL"', options);

    expect(compiled).toMatchObject(valid);
    expect(compiled).toMatchObject({ ok: true, expression: expect.any(Object) });
    if (compiled.ok) {
      expect(Object.isFrozen(compiled)).toBe(true);
      expect(Object.isFrozen(compiled.expression)).toBe(true);
      expect(Object.isFrozen(compiled.referencedFields)).toBe(true);
    }

    const invalidValidation = validateExpression('Missing', options);
    const invalidCompilation = compileExpression('Missing', options);
    expect(invalidCompilation).toEqual(invalidValidation);
  });

  it('should report one lexical or syntax diagnostic with exact locations', () => {
    expect(validateExpression('$', emptyOptions)).toMatchObject({
      ok: false,
      diagnostics: [
        {
          kind: 'source',
          code: 'BS_INVALID_CHARACTER',
          severity: 'error',
          span: { start: 0, end: 1 },
          location: { line: 1, column: 1, endLine: 1, endColumn: 2 },
        },
      ],
    });

    expect(validateExpression('TRUE)', emptyOptions)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_UNEXPECTED_TOKEN', span: { start: 4, end: 5 } }],
    });
  });

  it('should return only the first twenty ordered semantic diagnostics', () => {
    const twentyOne = Array.from({ length: 21 }, (_, index) => `Missing${index}`).join(' AND ');
    const result = validateExpression(twentyOne, emptyOptions);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(20);
      expect(result.diagnostics.every(({ code }) => code === 'BS_UNKNOWN_FIELD')).toBe(true);
      expect(result.diagnostics.map(({ span }) => span.start)).toEqual(
        [...result.diagnostics].map(({ span }) => span.start).sort((left, right) => left - right)
      );
    }
  });

  it('should count UTF-16 columns and treat CRLF as one line break', () => {
    const result = validateExpression('"😀"\r\n$', emptyOptions);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: 'BS_INVALID_CHARACTER',
          span: { start: 6, end: 7 },
          location: { line: 2, column: 1, endLine: 2, endColumn: 2 },
        },
      ],
    });
  });

  it('should count ECMAScript line separators in diagnostic locations', () => {
    for (const separator of ['\u2028', '\u2029']) {
      expect(validateExpression(`TRUE${separator}$`, emptyOptions)).toMatchObject({
        ok: false,
        diagnostics: [
          {
            code: 'BS_INVALID_CHARACTER',
            span: { start: 5, end: 6 },
            location: { line: 2, column: 1, endLine: 2, endColumn: 2 },
          },
        ],
      });
    }
  });

  it('should accept the source cap and reject the first code unit above it before tokenization', () => {
    expect(validateExpression(`${' '.repeat(16_380)}TRUE`, emptyOptions)).toMatchObject({
      ok: true,
    });
    expect(validateExpression(`${' '.repeat(16_381)}TRUE`, emptyOptions)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_SOURCE_TOO_LONG', span: { start: 16_384, end: 16_385 } }],
    });
    expect(validateExpression('A'.repeat(1_000_000), emptyOptions)).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'BS_SOURCE_TOO_LONG', span: { start: 16_384, end: 16_385 } }],
    });
  });

  it('should select the first twenty diagnostics after deterministic ordering', () => {
    const argumentsList = Array.from({ length: 21 }, (_, index) => `Missing${index}`).join(', ');
    const result = validateExpression(`contains(${argumentsList})`, emptyOptions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toHaveLength(20);
      expect(result.diagnostics[0]?.code).toBe('BS_INVALID_ARGUMENT_COUNT');
      expect(result.diagnostics.slice(1).every(({ code }) => code === 'BS_UNKNOWN_FIELD')).toBe(
        true
      );
    }
  });
});
