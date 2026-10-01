/**
 * Implementation tests for the umbrella assembler.
 *
 * The published `blendsdk` package must not name the private `@blendsdk/`
 * workspace scope. Real imports are rewritten to relative module paths so the
 * bundled code runs; specifiers that appear in JSDoc comments become the public
 * `blendsdk/` path so consumer-facing examples stay valid. These tests pin both
 * rewrites and the scan that rejects any leftover.
 *
 * @module assemble.impl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { rewriteImports, verifyNoRemainingReferences } from './assemble.js';

/** The repository root, one level above `scripts/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The assembled output root, used to compute relative module paths. */
const OUTPUT_DIR = path.join(REPO_ROOT, 'packages', 'blendsdk', 'dist');

describe('rewriteImports', () => {
  it('should rewrite a real import specifier to a relative module path', () => {
    const filePath = path.join(OUTPUT_DIR, 'dbcore', 'from-statement.js');
    const { content, rewrites } = rewriteImports(
      filePath,
      "import { from } from '@blendsdk/expression';\n"
    );

    expect(content).toBe("import { from } from '../expression/index.js';\n");
    expect(rewrites).toBe(1);
  });

  it('should keep a secondary entry point in a real import', () => {
    const filePath = path.join(OUTPUT_DIR, 'webafx-i18n', 'i18n-plugin.js');
    const { content } = rewriteImports(
      filePath,
      "const mod = await import('@blendsdk/i18n/node');\n"
    );

    expect(content).toBe("const mod = await import('../i18n/node.js');\n");
  });

  it('should rewrite a JSDoc example import to the public umbrella path', () => {
    const filePath = path.join(OUTPUT_DIR, 'codegen', 'api', 'types.d.ts');
    const input = [
      '/**',
      ' * @example',
      " * import { defineApiContract } from '@blendsdk/codegen';",
      ' */',
      '',
    ].join('\n');

    const { content } = rewriteImports(filePath, input);

    expect(content).toContain("from 'blendsdk/codegen'");
    expect(content).not.toContain('@blendsdk/');
  });

  it('should rewrite a quoted package specifier in JSDoc that is not an import', () => {
    const filePath = path.join(OUTPUT_DIR, 'codegen', 'generator', 'client-types.d.ts');
    const input = ['/**', " *   runtimeImport: '@blendsdk/api-client',", ' */', ''].join('\n');

    const { content } = rewriteImports(filePath, input);

    expect(content).toContain("runtimeImport: 'blendsdk/api-client'");
    expect(content).not.toContain('@blendsdk/');
  });
});

describe('verifyNoRemainingReferences', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('should report files that still contain a quoted @blendsdk/ specifier', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-assemble-'));
    fs.writeFileSync(path.join(dir, 'a.d.ts'), "import { X } from '@blendsdk/codegen';\n");
    fs.writeFileSync(path.join(dir, 'b.js'), 'export const ok = 1;\n');

    expect(verifyNoRemainingReferences(dir)).toEqual(['a.d.ts']);
  });

  it('should check comment lines as well as real imports', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-assemble-'));
    fs.writeFileSync(path.join(dir, 'a.js'), " * import { X } from '@blendsdk/codegen';\n");

    expect(verifyNoRemainingReferences(dir)).toEqual(['a.js']);
  });
});
