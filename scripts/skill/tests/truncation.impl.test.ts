/**
 * Implementation tests for failure handling in the ai-training generator.
 *
 * These tests complement the specification tests: they assert that a package
 * with failed or truncated files is not recorded as current in the manifest,
 * and that the provider-to-limits mapping selects the raised DeepSeek limits.
 *
 * @module skill/tests/truncation.impl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generatePackageDocs, resolveGenerationLimits } from '../../generate-ai-training.js';
import { LLMProvider } from '../../changelog/llm-provider.js';

import type { LLMResult } from '../../changelog/types.js';
import type { AiTrainingOptions, PackageFreshness } from '../../ai-training/types.js';

// ============================================================================
// FIXTURES
// ============================================================================

/** A provider whose responses are always truncated. */
class AlwaysTruncatedProvider extends LLMProvider {
  override async generate(): Promise<LLMResult> {
    return {
      content: 'partial',
      provider: 'deepseek',
      model: 'deepseek-flash',
      tokensUsed: { input: 1, output: 2 },
      truncated: true,
    };
  }
}

/** A provider that truncates only the first response and succeeds afterwards. */
class TruncatedOnceProvider extends LLMProvider {
  private calls = 0;

  override async generate(): Promise<LLMResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return {
        content: 'partial',
        provider: 'deepseek',
        model: 'deepseek-flash',
        tokensUsed: { input: 1, output: 2 },
        truncated: true,
      };
    }
    return {
      content: '# Generated content\n\nComplete.',
      provider: 'deepseek',
      model: 'deepseek-flash',
      tokensUsed: { input: 1, output: 2 },
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
 * @returns The temporary tree handle
 */
function createTempTree(): TempTree {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truncation-impl-'));
  const packageDir = path.join(rootDir, 'packages', 'test-pkg');
  const srcDir = path.join(packageDir, 'src');
  const testsDir = path.join(packageDir, 'tests');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(testsDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@blendsdk/test-pkg', version: '5.54.0' }, null, 2)
  );
  fs.writeFileSync(
    path.join(srcDir, 'index.ts'),
    "export { Calculator } from './calculator.js';\n"
  );
  fs.writeFileSync(
    path.join(srcDir, 'calculator.ts'),
    'export class Calculator {\n    add(a: number, b: number): number {\n        return a + b;\n    }\n}\n'
  );
  fs.writeFileSync(path.join(testsDir, 'calculator.test.ts'), 'test:1;\n');

  return {
    rootDir,
    packageDir,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

/**
 * Builds a freshness record for the fixture package.
 *
 * @returns A `missing` freshness record
 */
function missingFreshness(): PackageFreshness {
  return {
    packageName: 'test-pkg',
    packagePath: 'packages/test-pkg',
    status: 'missing',
    currentHashes: { src: 's', tests: 't', apiSurface: 'a', packageJson: 'p' },
    changedAreas: ['src', 'tests', 'api', 'dependencies'],
  };
}

/** CLI options used by the generator tests. */
function options(): AiTrainingOptions {
  return {
    check: false,
    force: true,
    incremental: false,
    concurrency: 1,
    yes: true,
    dryRun: false,
    verbose: false,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Failed-file manifest handling', () => {
  let tree: TempTree;

  beforeEach(() => {
    tree = createTempTree();
  });

  afterEach(() => {
    tree.cleanup();
  });

  it('should not record the package as current when every file is truncated', async () => {
    const provider = new AlwaysTruncatedProvider({ anthropicModel: 'x', openaiModel: 'y' });
    const result = await generatePackageDocs(
      'test-pkg',
      missingFreshness(),
      provider,
      options(),
      tree.rootDir
    );

    expect(result.filesFailed).toBeGreaterThan(0);
    expect(result.filesGenerated).toBe(0);
    expect(fs.existsSync(path.join(tree.rootDir, '.ai-training-manifest.json'))).toBe(false);
  });

  it('should not record the package as current when some files succeeded and one failed', async () => {
    const provider = new TruncatedOnceProvider({ anthropicModel: 'x', openaiModel: 'y' });
    const result = await generatePackageDocs(
      'test-pkg',
      missingFreshness(),
      provider,
      options(),
      tree.rootDir
    );

    expect(result.filesGenerated).toBeGreaterThan(0);
    expect(result.filesFailed).toBe(1);
    expect(fs.existsSync(path.join(tree.rootDir, '.ai-training-manifest.json'))).toBe(false);
  });
});

describe('Provider limit resolution', () => {
  it('should select the raised limits for DeepSeek', () => {
    const limits = resolveGenerationLimits({
      provider: 'deepseek',
      anthropicModel: 'x',
      openaiModel: 'y',
    });

    expect(limits).toEqual({ maxTokens: 131_072, timeout: 600_000 });
  });

  it('should keep the standard limits for the fallback providers', () => {
    const limits = resolveGenerationLimits({ anthropicModel: 'x', openaiModel: 'y' });

    expect(limits).toEqual({ maxTokens: 8192, timeout: 120_000 });
  });
});
