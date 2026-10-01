import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateExpression } from '../../src/index.js';

describe('BlendScript capability boundary', () => {
  it('should reject syntax that names or reaches host capabilities', () => {
    const sources = [
      'globalThis.process',
      'process.exit()',
      'require("node:fs")',
      'import("node:fs")',
      'Function("return 1")()',
      'eval("TRUE")',
      'constructor.constructor("return process")()',
      'this',
      'window.fetch("https://example.com")',
      'document.cookie',
    ];
    for (const source of sources) {
      const result = validateExpression(source, { schema: {} });
      expect(result.ok).toBe(false);
    }
  });

  it('should contain no dynamic-code or dynamic-loader path in production source', () => {
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const sourceDirectory = join(currentDirectory, '..', '..', 'src');
    const files = [
      'analyzer.ts',
      'api.ts',
      'ast.ts',
      'builtins.ts',
      'compiled-expression.ts',
      'diagnostics.ts',
      'errors.ts',
      'evaluator.ts',
      'index.ts',
      'input-validation.ts',
      'lexer.ts',
      'limits.ts',
      'parser.ts',
      'types.ts',
    ];
    const source = files.map(file => readFileSync(join(sourceDirectory, file), 'utf8')).join('\n');
    expect(source).not.toMatch(/\beval\s*\(/u);
    expect(source).not.toMatch(/\bnew\s+Function\b/u);
    expect(source).not.toMatch(/\bFunction\s*\(/u);
    expect(source).not.toMatch(/\bimport\s*\(/u);
  });
});
