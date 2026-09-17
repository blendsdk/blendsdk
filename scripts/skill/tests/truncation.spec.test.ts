/**
 * Specification tests for truncation handling in the ai-training generator.
 *
 * When a provider returns a response that stopped because it hit the output
 * limit (`truncated: true`), the generator must mark that file as failed and
 * must not write a partial `.md` file for it. A message naming truncation must
 * be surfaced so the run can report why the file was skipped.
 *
 * These tests point the generator at a temporary package tree and inject a
 * provider that returns canned results. No real LLM call is made.
 *
 * @module skill/tests/truncation.spec
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as generatorModule from '../../generate-ai-training.js';
import { LLMProvider } from '../../changelog/llm-provider.js';

import type { LLMResult } from '../../changelog/types.js';
import type { AiTrainingOptions, PackageFreshness } from '../../ai-training/types.js';

// ============================================================================
// GENERATION RUNNER SEAM
// ============================================================================

/** Result shape returned by the package generation runner. */
interface GenerationResult {
  /** Number of files written successfully. */
  filesGenerated: number;

  /** Number of files that were skipped or failed. */
  filesFailed: number;
}

/**
 * Signature of the generation runner under test.
 *
 * The optional trailing `rootDir` lets a test redirect the reader and writer
 * at a temporary tree instead of the repository root.
 */
type GenerationRunner = (
  packageName: string,
  freshness: PackageFreshness,
  provider: LLMProvider,
  options: AiTrainingOptions,
  rootDir?: string
) => Promise<GenerationResult>;

/**
 * Resolves the generation runner from the generator module.
 *
 * The runner is read through `Reflect.get` so that a missing export produces a
 * clear runtime failure instead of aborting the whole test file at import time.
 *
 * @returns The generation runner function
 * @throws Error when the generator module does not export the runner
 */
function resolveGenerationRunner(): GenerationRunner {
  const candidate = Reflect.get(generatorModule, 'generatePackageDocs');
  if (typeof candidate !== 'function') {
    throw new Error(
      'scripts/generate-ai-training.ts does not export generatePackageDocs; ' +
        'the generation runner must be exported for its truncation handling to be verified.'
    );
  }
  return candidate as GenerationRunner;
}

// ============================================================================
// TEST FIXTURES
// ============================================================================

/**
 * Provides a result that is truncated on the first call and valid afterwards.
 *
 * This keeps the test focused on a single file: the first output is marked as
 * stopped-by-length, and every later output is a normal successful result.
 */
class TruncatedOnceProvider extends LLMProvider {
  private calls = 0;

  override async generate(): Promise<LLMResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: 'partial content',
        provider: 'deepseek',
        model: 'deepseek-flash',
        tokensUsed: { input: 11, output: 22, reasoning: 7 },
        truncated: true,
      };
    }
    return {
      content: '# Generated content\n\nThis file was generated successfully.',
      provider: 'deepseek',
      model: 'deepseek-flash',
      tokensUsed: { input: 11, output: 22 },
    };
  }
}

/** A temporary monorepo tree with a single package. */
interface TempTree {
  /** Absolute path to the temporary repository root. */
  rootDir: string;

  /** Absolute path to the temporary package directory. */
  packageDir: string;

  /** Removes the temporary tree from disk. */
  cleanup(): void;
}

/**
 * Creates a temporary monorepo containing one minimal package.
 *
 * @returns The temporary tree handle and its cleanup function
 */
function createTempTree(): TempTree {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truncation-spec-'));
  const packageDir = path.join(rootDir, 'packages', 'test-pkg');
  const srcDir = path.join(packageDir, 'src');
  const testsDir = path.join(packageDir, 'tests');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });

  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      { name: '@blendsdk/test-pkg', version: '5.54.0', description: 'Temporary test package' },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(srcDir, 'index.ts'),
    "export { Calculator } from './calculator.js';\n"
  );
  fs.writeFileSync(
    path.join(srcDir, 'calculator.ts'),
    'export class Calculator {\n    add(a: number, b: number): number {\n        return a + b;\n    }\n}\n'
  );
  fs.writeFileSync(
    path.join(testsDir, 'calculator.test.ts'),
    "import { Calculator } from '../src/calculator.js';\n\ntest:1;\n"
  );

  return {
    rootDir,
    packageDir,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

/**
 * Builds a freshness result for a package whose ai-training output is absent.
 *
 * @returns A `missing` freshness record for the fixture package
 */
function missingFreshness(): PackageFreshness {
  return {
    packageName: 'test-pkg',
    packagePath: 'packages/test-pkg',
    status: 'missing',
    currentHashes: {
      src: 'src-hash',
      tests: 'tests-hash',
      apiSurface: 'api-hash',
      packageJson: 'package-json-hash',
    },
    changedAreas: ['src', 'tests', 'api', 'dependencies'],
  };
}

/**
 * Intercepts console and stdout writes so a test can inspect the messages the
 * generator prints.
 *
 * @returns The collected text plus a function that restores the original writers
 */
function captureOutput(): { output: string[]; restore(): void } {
  const output: string[] = [];

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map(arg => String(arg)).join(' '));
  });
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args.map(arg => String(arg)).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    output.push(args.map(arg => String(arg)).join(' '));
  });
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    });

  return {
    output,
    restore: () => {
      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      stdoutSpy.mockRestore();
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Truncated DeepSeek responses', () => {
  let tree: TempTree;

  beforeEach(() => {
    tree = createTempTree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  it('should mark the file failed and write no markdown when a DeepSeek response is truncated', async () => {
    const run = resolveGenerationRunner();
    const provider = new TruncatedOnceProvider({ anthropicModel: 'unused', openaiModel: 'unused' });
    const options: AiTrainingOptions = {
      check: false,
      force: true,
      incremental: false,
      concurrency: 1,
      yes: true,
      dryRun: false,
      verbose: false,
    };

    const captured = captureOutput();
    try {
      const result = await run('test-pkg', missingFreshness(), provider, options, tree.rootDir);

      expect(result.filesFailed).toBe(1);
      expect(result.filesGenerated).toBeGreaterThan(0);

      const aiTrainingDir = path.join(tree.packageDir, 'ai-training');
      expect(fs.existsSync(path.join(aiTrainingDir, '00-overview.md'))).toBe(false);

      const written = fs.existsSync(aiTrainingDir)
        ? fs.readdirSync(aiTrainingDir).filter(entry => entry.endsWith('.md'))
        : [];
      expect(written).not.toContain('00-overview.md');
      expect(written).toContain('01-core-concepts.md');

      expect(captured.output.join('\n')).toMatch(/truncat/i);
    } finally {
      captured.restore();
    }
  }, 15_000);
});
