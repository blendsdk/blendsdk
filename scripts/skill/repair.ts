/**
 * Local example repair tool.
 *
 * The tool reads a validator report and asks a language model to fix only the
 * blocks that failed, using the SDK's public declarations. It rewrites the
 * affected references in place, repeats up to a bounded number of rounds, and
 * keeps every path inside the skill tree.
 *
 * The tool never runs in CI and never executes the extracted examples. Its
 * language-model call is injected so tests can run without a network call.
 *
 * @module skill/repair
 */

import fs from 'node:fs';
import path from 'node:path';

import { SkillGenerationError } from './mapping.js';
import { validateExamples } from './validate-examples.js';

import type { ValidationProblem, ValidationReport } from './validate-examples.js';

/** The language-model call the repair loop depends on. */
export interface RepairDependencies {
  /**
   * Sends one repair prompt and returns the corrected block.
   *
   * @param system - System/instruction prompt
   * @param user - User prompt with the block, the error, and the declarations
   * @returns The model response, or null when the call failed
   */
  generate(system: string, user: string): Promise<string | null>;
}

/** Options that control a repair run. */
export interface RepairOptions {
  /** Absolute path to the repository root. */
  rootDir: string;

  /** Report produced by the validator; only its failing blocks are repaired. */
  report: ValidationReport;

  /** Maximum number of repair rounds (default: 2). */
  maxRounds?: number;

  /** Maximum number of blocks to repair in one run (default: unlimited). */
  limit?: number;
}

/** Outcome of a repair run. */
export interface RepairResult {
  /** Number of rounds actually executed. */
  rounds: number;

  /** Number of reported problems that are gone from the final report. */
  fixed: number;

  /** Number of problems still present after the final round. */
  remaining: number;
}

/** One fenced block located in a reference. */
interface FencedBlock {
  /** One-based line of the opening fence. */
  fenceStart: number;

  /** One-based line of the first body line. */
  bodyStart: number;

  /** One-based line of the last body line. */
  bodyEnd: number;

  /** Fence info string. */
  info: string;
}

/** A group of problems that point at the same block. */
interface BlockTarget {
  /** Reference path relative to the repository root. */
  reference: string;

  /** Absolute path of the reference file. */
  absolutePath: string;

  /** The fenced block to repair. */
  block: FencedBlock;

  /** Problems reported for this block. */
  problems: ValidationProblem[];
}

/** System prompt sent with every repair request. */
const REPAIR_SYSTEM_PROMPT = [
  'You repair TypeScript examples for the BlendSDK agent skill.',
  'Return only the corrected code block, wrapped in a ```ts fence.',
  'Do not add prose, explanations, or headings.',
  'Use only symbols and members that appear in the provided declarations.',
  'Keep the example focused on the same topic as the original.',
].join(' ');

/** Matches an import whose module is the umbrella package. */
const UMBRELLA_IMPORT = /from\s*['"](blendsdk\/[^'"]+)['"]/g;

/**
 * Parses the fenced blocks of a markdown reference.
 *
 * @param content - Markdown content
 * @returns Fenced blocks with their one-based line ranges
 */
function parseFences(content: string): FencedBlock[] {
  const lines = content.split('\n');
  const blocks: FencedBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (!fence) {
      index += 1;
      continue;
    }

    let close = index + 1;
    while (close < lines.length && !/^(`{3,}|~{3,})\s*$/.test(lines[close])) {
      close += 1;
    }
    blocks.push({
      fenceStart: index + 1,
      bodyStart: index + 2,
      bodyEnd: close,
      info: fence[2].trim(),
    });
    index = close + 1;
  }

  return blocks;
}

/**
 * Finds the block that contains a reported line.
 *
 * @param blocks - Blocks parsed from a reference
 * @param line - One-based line from a validation problem
 * @returns The containing block, or undefined when the line is outside every block
 */
function blockAt(blocks: FencedBlock[], line: number): FencedBlock | undefined {
  return blocks.find(block => line >= block.bodyStart - 1 && line <= block.bodyEnd + 1);
}

/**
 * Resolves a report path and proves it stays inside the skill tree.
 *
 * Report paths are relative to the repository root, so they are resolved from
 * `rootDir` and then checked against the skill directory.
 *
 * @param rootDir - Absolute path to the repository root
 * @param reference - Report path relative to the repository root
 * @returns Absolute path of the reference
 * @throws SkillGenerationError when the path escapes the skill tree
 */
function resolveInsideSkill(rootDir: string, reference: string): string {
  const skillRoot = path.join(rootDir, '.agents', 'skills', 'blendsdk');
  const resolved = path.resolve(rootDir, reference);
  if (resolved !== skillRoot && !resolved.startsWith(skillRoot + path.sep)) {
    throw new SkillGenerationError(`Repair target is outside the skill tree: ${reference}`);
  }
  return resolved;
}

/**
 * Reads the public declaration file for an umbrella subpath.
 *
 * @param rootDir - Absolute path to the repository root
 * @param subpath - Umbrella subpath, for example `widget`
 * @returns Declaration text, or null when the subpath publishes no types
 */
function declarationFor(rootDir: string, subpath: string): string | null {
  const manifestPath = path.join(rootDir, 'packages', 'blendsdk', 'package.json');
  const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (typeof manifest !== 'object' || manifest === null || !('exports' in manifest)) {
    return null;
  }

  const exports = (manifest as { exports?: Record<string, unknown> }).exports ?? {};
  const entry = exports[`./${subpath}`];
  if (typeof entry !== 'object' || entry === null || !('types' in entry)) {
    return null;
  }

  const typesPath = path.join(
    rootDir,
    'packages',
    'blendsdk',
    String((entry as { types: string }).types)
  );
  return fs.existsSync(typesPath) ? fs.readFileSync(typesPath, 'utf-8') : null;
}

/**
 * Collects the public declarations for every umbrella import in a block.
 *
 * @param rootDir - Absolute path to the repository root
 * @param code - Block body
 * @returns Declaration text for the imported subpaths, or a short note when none apply
 */
function collectDeclarations(rootDir: string, code: string): string {
  const subpaths = new Set<string>();
  UMBRELLA_IMPORT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UMBRELLA_IMPORT.exec(code)) !== null) {
    subpaths.add(match[1].slice('blendsdk/'.length));
  }

  const parts: string[] = [];
  for (const subpath of subpaths) {
    const declaration = declarationFor(rootDir, subpath);
    if (declaration) {
      parts.push(`// blendsdk/${subpath}\n${declaration}`);
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : '*No public declarations found for this block.*';
}

/**
 * Extracts the first fenced code block from a model response.
 *
 * @param response - Raw model response
 * @returns The block body, or the trimmed response when no fence is present
 */
function extractCode(response: string): string {
  const match = /(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\1/.exec(response);
  return (match ? match[2] : response).trim();
}

/**
 * Builds the repair prompt for one failing block.
 *
 * @param rootDir - Absolute path to the repository root
 * @param target - Block and its problems
 * @returns System and user prompts
 */
export function buildRepairPrompt(
  rootDir: string,
  target: BlockTarget
): { system: string; user: string } {
  const lines = fs.readFileSync(target.absolutePath, 'utf-8').split('\n');
  const original = lines.slice(target.block.bodyStart - 1, target.block.bodyEnd).join('\n');
  const errors = target.problems.map(problem => `- ${problem.message}`).join('\n');
  const declarations = collectDeclarations(rootDir, original);

  return {
    system: REPAIR_SYSTEM_PROMPT,
    user: [
      `Reference: ${target.reference}`,
      '',
      'The example below failed validation:',
      errors,
      '',
      'Original block:',
      '```ts',
      original,
      '```',
      '',
      'Public declarations:',
      declarations,
      '',
      'Return the corrected block only.',
    ].join('\n'),
  };
}

/**
 * Groups the report's problems by the block they point at.
 *
 * @param rootDir - Absolute path to the repository root
 * @param report - Validation report
 * @returns One target per failing block, ordered by reference then line
 * @throws SkillGenerationError when a reported path is outside the skill tree
 */
function collectTargets(rootDir: string, report: ValidationReport): BlockTarget[] {
  const byBlock = new Map<string, BlockTarget>();

  for (const problem of report.details) {
    if (!problem.file || problem.line === undefined) {
      continue;
    }
    const absolutePath = resolveInsideSkill(rootDir, problem.file);
    if (!fs.existsSync(absolutePath)) {
      throw new SkillGenerationError(`Repair target does not exist: ${problem.file}`);
    }
    const blocks = parseFences(fs.readFileSync(absolutePath, 'utf-8'));
    const block = blockAt(blocks, problem.line);
    if (!block) {
      continue;
    }

    const key = `${problem.file}:${block.bodyStart}`;
    const existing = byBlock.get(key);
    if (existing) {
      existing.problems.push(problem);
    } else {
      byBlock.set(key, {
        reference: problem.file,
        absolutePath,
        block,
        problems: [problem],
      });
    }
  }

  return [...byBlock.values()].sort(
    (a, b) => a.reference.localeCompare(b.reference) || a.block.bodyStart - b.block.bodyStart
  );
}

/**
 * Replaces one block body in a reference.
 *
 * @param absolutePath - Absolute path of the reference
 * @param block - Block to replace
 * @param code - Corrected block body
 */
function replaceBlock(absolutePath: string, block: FencedBlock, code: string): void {
  const lines = fs.readFileSync(absolutePath, 'utf-8').split('\n');
  const replacement = code.split('\n');
  lines.splice(block.bodyStart - 1, block.bodyEnd - block.bodyStart + 1, ...replacement);
  fs.writeFileSync(absolutePath, lines.join('\n'), 'utf-8');
}

/**
 * Repairs the failing blocks named in a validation report.
 *
 * @param options - Repair options
 * @param dependencies - Language-model call to use
 * @returns The number of rounds, fixed problems, and remaining problems
 * @throws SkillGenerationError when a reported path is outside the skill tree
 */
export async function repairExamples(
  options: RepairOptions,
  dependencies: RepairDependencies
): Promise<RepairResult> {
  const maxRounds = options.maxRounds ?? 2;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const initial = options.report.details.length;

  let targets = collectTargets(options.rootDir, options.report).slice(0, limit);
  let remaining = initial;
  let rounds = 0;

  while (rounds < maxRounds && targets.length > 0) {
    rounds += 1;

    for (const target of targets) {
      const prompt = buildRepairPrompt(options.rootDir, target);
      const response = await dependencies.generate(prompt.system, prompt.user);
      if (!response || response.trim().length === 0) {
        continue;
      }
      replaceBlock(target.absolutePath, target.block, extractCode(response));
    }

    const report = validateExamples(options.rootDir);
    remaining = report.details.length;
    targets = collectTargets(options.rootDir, report).slice(0, limit);
  }

  return { rounds, fixed: initial - remaining, remaining };
}
