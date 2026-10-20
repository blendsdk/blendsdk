/**
 * Semantic example checker.
 *
 * Type-checks extracted example blocks against the real SDK using the
 * TypeScript 7 native checker (`typescript/unstable/sync`) and splits the
 * findings in two:
 *
 * - **api** — the example names a package, symbol, or member the SDK does not
 *   have. These are the mistakes that mislead a coding agent, so CI gates them.
 * - **type** — everything else the compiler reports (wrong types, missing
 *   context). These are repaired locally.
 *
 * The checker writes the blocks into a throwaway project under the ignored
 * cache directory and resolves `blendsdk/*` through the built umbrella package.
 * It never executes the extracted code.
 *
 * @module skill/semantic-check
 */

import fs from 'node:fs';
import path from 'node:path';

import { API } from 'typescript/unstable/sync';

/** Tier assigned to a semantic problem. */
export type SemanticTier = 'api' | 'type';

/** One example block to type-check. */
export interface SemanticBlock {
  /** Reference path relative to the repository root. */
  reference: string;

  /** One-based line where the block body starts in the reference. */
  startLine: number;

  /** Block body without the fences. */
  code: string;
}

/** One problem found in an example block. */
export interface SemanticProblem {
  /** Reference path relative to the repository root. */
  reference: string;

  /** One-based line in the reference. */
  line: number;

  /** Whether the problem is a missing API or a type mismatch. */
  tier: SemanticTier;

  /** Compiler diagnostic code. */
  code: number;

  /** Compiler diagnostic message. */
  message: string;
}

/**
 * Diagnostic codes that mean the example used an API that does not exist.
 *
 * 2305/2459/2497/2614/2724: a named import is not exported by the package.
 * 2307: the package specifier itself does not resolve.
 * 2339/2551/2561: a property or member does not exist on the type.
 * 2503: a namespace does not exist.
 */
const API_DIAGNOSTIC_CODES = new Set([2305, 2307, 2339, 2459, 2497, 2503, 2551, 2561, 2614, 2724]);

/** Cache subdirectory the throwaway project is written into. */
const WORK_DIR = path.join('node_modules', '.cache', 'skill-validate', 'semantic');

/** Matches the generated block file names. */
const BLOCK_FILE = /^block-(\d+)\.tsx?$/;

/**
 * Computes the one-based line of a character offset.
 *
 * @param text - Source text
 * @param offset - Zero-based character offset
 * @returns One-based line number
 */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * Type-checks example blocks and classifies the findings.
 *
 * @param rootDir - Absolute path to the repository root
 * @param blocks - Blocks to check, in the order their diagnostics are reported
 * @returns Problems sorted by reference and line; empty when every block is clean
 * @throws Error when the throwaway project cannot be created
 */
export function checkSemantics(rootDir: string, blocks: SemanticBlock[]): SemanticProblem[] {
  if (blocks.length === 0) {
    return [];
  }

  const workDir = path.join(rootDir, WORK_DIR);
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(workDir, 'node_modules'), { recursive: true });
  fs.symlinkSync(
    path.join(rootDir, 'packages', 'blendsdk'),
    path.join(workDir, 'node_modules', 'blendsdk'),
    'dir'
  );
  fs.writeFileSync(
    path.join(workDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        moduleResolution: 'Bundler',
        module: 'ESNext',
        target: 'ES2022',
        jsx: 'preserve',
        strict: false,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
    }) + '\n',
    'utf-8'
  );

  const sources: string[] = [];
  blocks.forEach((block, index) => {
    // `export {}` keeps every block a module, so a block cannot leak globals
    // into another block and change its result.
    const source = `${block.code}\nexport {};\n`;
    fs.writeFileSync(path.join(workDir, `block-${index}.ts`), source, 'utf-8');
    sources.push(source);
  });

  const problems: SemanticProblem[] = [];
  const configPath = path.join(workDir, 'tsconfig.json');
  const api = new API();
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);
    if (!project) {
      throw new Error(`Semantic check could not open the throwaway project at ${workDir}`);
    }

    for (const diagnostic of project.program.getSemanticDiagnostics()) {
      if (!diagnostic.fileName) {
        continue;
      }
      const match = BLOCK_FILE.exec(path.basename(diagnostic.fileName));
      if (!match) {
        continue;
      }
      const block = blocks[Number(match[1])];
      if (!block) {
        continue;
      }
      problems.push({
        reference: block.reference,
        line: block.startLine + lineAt(sources[Number(match[1])], diagnostic.pos) - 1,
        tier: API_DIAGNOSTIC_CODES.has(diagnostic.code) ? 'api' : 'type',
        code: diagnostic.code,
        message: diagnostic.text,
      });
    }
  } finally {
    api.close();
  }

  return problems.sort(
    (a, b) => a.reference.localeCompare(b.reference) || a.line - b.line || a.code - b.code
  );
}
