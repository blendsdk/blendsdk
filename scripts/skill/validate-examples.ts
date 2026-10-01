/**
 * Example validator for the committed BlendSDK agent skill.
 *
 * The skill ships TypeScript examples that tell an agent which packages and
 * symbols to use. A wrong import is worse than no example, so this tool checks
 * every reference against the assembled SDK in three tiers:
 *
 * - **Tier 1a** — every `blendsdk/<subpath>` import must exist in the umbrella
 *   package's `exports` map.
 * - **Tier 1b** — every named import must be exported by the package root that
 *   the subpath maps to.
 * - **Tier 2** — the remaining blocks are type-checked with the real compiler
 *   against `packages/blendsdk/dist`.
 *
 * Some content is not a runnable example and must not be treated as one:
 * API signature listings under an `api.md` file are reference material, blocks
 * whose info string ends in `fragment` are illustrative by contract, and
 * examples that import a sibling file or drive a test runner need a project
 * context this tool cannot provide. All of them are still import-checked,
 * because even a fragment that names a package or symbol that does not exist
 * will mislead an agent.
 *
 * The validator never executes the extracted code. It writes the blocks to a
 * throwaway project and runs `tsc` with an argument array, never through a
 * shell and never by interpolating content into a command.
 *
 * @module skill/validate-examples
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SkillGenerationError } from './mapping.js';

/** Tier that produced a validation problem. */
export type ValidationTier = '1a' | '1b' | '2' | 'build' | 'filter';

/** One structured validation problem. */
export interface ValidationProblem {
  /** Reference path relative to the repository root, or empty for build/filter. */
  file: string;

  /** One-based line in the reference, when the problem points at a line. */
  line?: number;

  /** Which check produced the problem. */
  tier: ValidationTier;

  /** Plain-language description of the problem. */
  message: string;
}

/**
 * Result of validating the skill's examples.
 */
export interface ValidationReport {
  /** True when no import, symbol, or compiler problem was found. */
  ok: boolean;

  /** Human-readable problems, each prefixed with `file:line:`. */
  problems: string[];

  /** Structured form of `problems`, for tooling and agent task lists. */
  details: ValidationProblem[];

  /** Number of markdown files scanned. */
  filesScanned: number;

  /** Number of TypeScript blocks inspected. */
  blocksChecked: number;

  /** Number of fragment blocks skipped by the compiler tier. */
  fragmentsSkipped: number;

  /** Number of context-dependent examples skipped by the compiler tier. */
  contextualSkipped: number;

  /** Number of counter-examples skipped entirely. */
  counterExamplesSkipped: number;
}

/**
 * Options that narrow what the validator scans.
 */
export interface ValidateExamplesOptions {
  /**
   * Validate only this reference path. Accepts an absolute path or a path
   * relative to the repository root or to the skill directory.
   */
  filter?: string;

  /**
   * Also run the compiler tier (tier 2). Defaults to true so callers and tests
   * get the full check; the command line passes false unless `--compile` is
   * given, keeping the CI gate on the deterministic import and symbol tiers.
   */
  compile?: boolean;
}

/** Marker added to a symbol surface when it re-exports from an unknown module. */
const OPEN_SURFACE = '\u0000open';

/** Sentinel used to detect the CLI entry point. */
const MODULE_PATH = fileURLToPath(import.meta.url);

/** Marker that identifies a fragment block in its fence info string. */
const FRAGMENT_PATTERN = /^(ts|typescript)\s+fragment$/;

/** Matches a TypeScript fence info string such as `ts` or `typescript`. */
const TYPESCRIPT_PATTERN = /^(ts|typescript)(\s|$)/;

/** Matches an import whose module is relative to a sibling example file. */
const RELATIVE_IMPORT_PATTERN = /^\.\.?\//;

/**
 * Matches the runner globals a test example uses. Such a block needs a test
 * project (runner and matcher types) to compile, which the validator's
 * throwaway project does not provide.
 */
const TEST_GLOBAL_PATTERN =
  /\b(?:describe|it|test|expect|vi|jest|beforeEach|afterEach|beforeAll|afterAll)\s*\(/;

/**
 * Matches the wording authors use to introduce a block that deliberately shows
 * a failing or forbidden import. Such a block must not be import-checked: the
 * bad import is the lesson.
 */
const COUNTEREXAMPLE_PATTERN =
  /❌|\bwrong\b|\bnot exported\b|does not compile|\bblocked\b|\bavoid\b|don'?t\b|do not\b|\binvalid\b|never re-export|not reachable/i;

/** A fenced code block with its position inside the reference. */
interface FencedBlock {
  /** Trimmed fence info string. */
  info: string;

  /** Block body without the fences. */
  code: string;

  /** One-based line number of the block's first line in the reference. */
  startLine: number;

  /** Last non-empty line before the opening fence, used to spot counter-examples. */
  preceding: string;
}

/** A parsed import statement. */
interface ParsedImport {
  /** Module specifier, for example `blendsdk/webafx`. */
  specifier: string;

  /** Named imports from the `{ ... }` clause. */
  names: string[];

  /** One-based line of the statement inside its block. */
  line: number;
}

/** An umbrella export mapped back to its package source. */
interface UmbrellaExport {
  /** Short package name, for example `webafx`. */
  packageName: string;

  /** Absolute path to the package's public source file. */
  sourcePath: string;
}

/** One block prepared for the compiler tier. */
interface CompileBlock {
  /** Index used in the generated file name. */
  index: number;

  /** Absolute path to the reference that owns the block. */
  file: string;

  /** Reference path relative to the repository root, with forward slashes. */
  reference: string;

  /** Block body. */
  code: string;

  /** One-based line of the block's first line in the reference. */
  startLine: number;
}

/** Minimal compiler options used for the throwaway project. */
const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    jsx: 'preserve',
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
    types: [],
  },
  include: ['block-*.ts', 'block-*.tsx'],
};

const require = createRequire(import.meta.url);

/**
 * Repositions a diagnostic line in a generated file back to the reference.
 *
 * @param startLine - One-based line of the block's first line in the reference
 * @param diagnosticLine - One-based line reported by the compiler
 * @returns The matching one-based line in the reference
 */
function toReferenceLine(startLine: number, diagnosticLine: number): number {
  return startLine + diagnosticLine - 1;
}

/**
 * Converts an absolute path into a forward-slash path relative to the root.
 *
 * @param rootDir - Absolute path to the repository root
 * @param absolutePath - Absolute path to convert
 * @returns Relative path using forward slashes
 */
function toReferencePath(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/');
}

/**
 * Replaces comments with spaces so import parsing ignores commented-out code.
 *
 * Newlines are preserved so line numbers stay accurate.
 *
 * @param code - Source code
 * @returns Source with comments blanked out
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, match => ' '.repeat(match.length));
}

/**
 * Computes the one-based line of a character offset.
 *
 * @param text - Text to scan
 * @param offset - Character offset into the text
 * @returns One-based line number
 */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/**
 * Extracts the names from an import clause's `{ ... }` group.
 *
 * Aliases keep the name that must exist on the target module, so `A as B`
 * contributes `A`. Type-only markers are ignored.
 *
 * @param clause - The text between `import` and `from`
 * @returns Imported names
 */
function extractNamedImports(clause: string): string[] {
  const group = /\{([^}]*)\}/.exec(clause);
  if (!group) {
    return [];
  }

  const names: string[] = [];
  for (const part of group[1].split(',')) {
    const cleaned = part.trim().replace(/^type\s+/, '');
    if (!cleaned) {
      continue;
    }
    const name = cleaned.split(/\s+as\s+/)[0].trim();
    if (name && name !== 'default') {
      names.push(name);
    }
  }
  return names;
}

/**
 * Parses the import statements of a block.
 *
 * @param code - Block source
 * @returns Parsed imports with their line numbers
 */
function parseImports(code: string): ParsedImport[] {
  const clean = stripComments(code);
  const imports: ParsedImport[] = [];

  const fromPattern = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(clean)) !== null) {
    imports.push({
      specifier: match[2],
      names: extractNamedImports(match[1]),
      line: lineAt(clean, match.index),
    });
  }

  const sideEffectPattern = /import\s*['"]([^'"]+)['"]/g;
  while ((match = sideEffectPattern.exec(clean)) !== null) {
    imports.push({ specifier: match[1], names: [], line: lineAt(clean, match.index) });
  }

  return imports;
}

/**
 * Reports whether a block deliberately shows invalid code.
 *
 * Generated troubleshooting content routinely shows a failing import to teach
 * what not to do, marking it with a ❌ or wording such as "not exported". The
 * marker can be the line before the fence or the first comment inside it.
 * Checking those imports would flag the lesson itself, so the block is skipped
 * entirely.
 *
 * @param block - Block to inspect
 * @returns True when the block is a counter-example
 */
function isCounterExample(block: FencedBlock): boolean {
  if (COUNTEREXAMPLE_PATTERN.test(block.preceding)) {
    return true;
  }
  const firstLine =
    block.code
      .split('\n')
      .find(line => line.trim().length > 0)
      ?.trim() ?? '';
  return firstLine.startsWith('//') && COUNTEREXAMPLE_PATTERN.test(firstLine);
}

/**
 * Reports whether a block depends on context the throwaway project lacks.
 *
 * Examples that import a sibling file (`./helpers.js`) or drive a test runner
 * (`describe`, `expect`, `vi`) are written for a real project, not for
 * isolated compilation. They are still import-checked; only the compiler tier
 * skips them, so they do not produce false diagnostics.
 *
 * @param code - Block source
 * @returns True when the block is context-dependent
 */
function isContextualExample(code: string): boolean {
  if (TEST_GLOBAL_PATTERN.test(code)) {
    return true;
  }
  return parseImports(code).some(imported => RELATIVE_IMPORT_PATTERN.test(imported.specifier));
}

/**
 * Splits a markdown document into fenced code blocks.
 *
 * @param content - Markdown content
 * @returns Fenced blocks with their starting line numbers
 */
function parseFencedBlocks(content: string): FencedBlock[] {
  const lines = content.split('\n');
  const blocks: FencedBlock[] = [];
  let fence: string | undefined;
  let info = '';
  let startLine = 0;
  let body: string[] = [];
  let lastNonEmpty = '';

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = /^\s*(```|~~~)(.*)$/.exec(line);

    if (!fence && marker) {
      fence = marker[1];
      info = marker[2].trim();
      startLine = i + 2;
      body = [];
      continue;
    }

    if (fence && marker && marker[1] === fence) {
      blocks.push({ info, code: body.join('\n'), startLine, preceding: lastNonEmpty });
      fence = undefined;
      continue;
    }

    if (fence) {
      body.push(line);
      continue;
    }

    if (line.trim()) {
      lastNonEmpty = line.trim();
    }
  }

  return blocks;
}

/**
 * Reads a `types` (or `import`) target from an export entry.
 *
 * @param value - One entry from the umbrella package's `exports` map
 * @returns The target path, or undefined when the entry is not usable
 */
function readExportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.types === 'string') {
    return record.types;
  }
  if (typeof record.import === 'string') {
    return record.import;
  }
  return undefined;
}

/**
 * Maps a compiled `dist` target back to the package's public source file.
 *
 * @param rootDir - Absolute path to the repository root
 * @param target - Target path from the exports map, such as `./dist/react/index.d.ts`
 * @returns The package name and source path, or undefined when it cannot be mapped
 */
function resolveSourcePath(
  rootDir: string,
  target: string
): { packageName: string; sourcePath: string } | undefined {
  const normalized = target.replace(/^\.\//, '');
  if (!normalized.startsWith('dist/')) {
    return undefined;
  }

  const segments = normalized.slice('dist/'.length).split('/');
  const packageName = segments[0];
  if (!packageName) {
    return undefined;
  }

  const filePart = segments
    .slice(1)
    .join('/')
    .replace(/\.d\.ts$/, '');
  const base = filePart || 'index';
  const packageDir = path.join(rootDir, 'packages', packageName);
  const candidates = [
    path.join(packageDir, 'src', `${base}.ts`),
    path.join(packageDir, 'src', 'index.ts'),
  ];
  const sourcePath = candidates.find(candidate => fs.existsSync(candidate));

  return sourcePath ? { packageName, sourcePath } : undefined;
}

/**
 * Builds the map from umbrella subpath to package source.
 *
 * @param rootDir - Absolute path to the repository root
 * @returns Map keyed by subpath such as `webafx`, with no leading `blendsdk/`
 * @throws SkillGenerationError when the umbrella manifest cannot be read
 */
function readUmbrellaExports(rootDir: string): Map<string, UmbrellaExport> {
  const manifestPath = path.join(rootDir, 'packages', 'blendsdk', 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SkillGenerationError(`Cannot read ${manifestPath}: ${reason}`);
  }

  const exports = new Map<string, UmbrellaExport>();
  if (typeof parsed !== 'object' || parsed === null || !('exports' in parsed)) {
    return exports;
  }

  const rawExports = (parsed as Record<string, unknown>).exports;
  if (typeof rawExports !== 'object' || rawExports === null) {
    return exports;
  }

  for (const [key, value] of Object.entries(rawExports)) {
    const subpath = key.startsWith('./') ? key.slice(2) : key;
    if (!subpath || subpath.includes('*')) {
      continue;
    }
    const target = readExportTarget(value);
    const resolved = target ? resolveSourcePath(rootDir, target) : undefined;
    if (resolved) {
      exports.set(subpath, resolved);
    }
  }

  return exports;
}

/**
 * Collects the symbols a source file exports, following relative re-exports.
 *
 * A wildcard re-export that cannot be resolved marks the surface as open, so
 * the symbol check does not report false positives for symbols that may come
 * from the unknown module.
 *
 * @param sourcePath - Absolute path to the source file
 * @param visited - Files already visited, to stop cycles
 * @param depth - Current recursion depth
 * @returns Exported symbol names, or a set containing the open-surface marker
 */
function collectExportedSymbols(
  sourcePath: string,
  visited = new Set<string>(),
  depth = 0
): Set<string> {
  if (visited.has(sourcePath) || depth > 12 || !fs.existsSync(sourcePath)) {
    return new Set();
  }
  visited.add(sourcePath);

  const source = fs.readFileSync(sourcePath, 'utf-8');
  const names = new Set<string>();

  // Recognizes every declaration form that can bind a named export, including
  // modifier prefixes (`declare`, `default`, `abstract`, `async`) and generator
  // functions. `export type { X }` is intentionally excluded here; the group
  // pattern below handles it.
  const directPattern =
    /export\s+(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = directPattern.exec(source)) !== null) {
    names.add(match[1]);
  }

  const groupPattern = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  while ((match = groupPattern.exec(source)) !== null) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim().replace(/^type\s+/, '');
      if (!cleaned) {
        continue;
      }
      const name = cleaned.split(/\s+as\s+/)[1] ?? cleaned;
      names.add(name.trim());
    }
  }

  const wildcardPattern = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;
  while ((match = wildcardPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) {
      names.add(OPEN_SURFACE);
      continue;
    }

    const base = path.resolve(path.dirname(sourcePath), specifier).replace(/\.(js|mjs|cjs)$/, '');
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
      if (fs.existsSync(candidate)) {
        for (const name of collectExportedSymbols(candidate, visited, depth + 1)) {
          names.add(name);
        }
        break;
      }
    }
  }

  return names;
}

/**
 * Lists the markdown files to scan.
 *
 * Only `references/**` and `SKILL.md` are scanned: the template assets are
 * project scaffolds with placeholders, not examples an agent should copy
 * verbatim.
 *
 * @param rootDir - Absolute path to the repository root
 * @param filter - Optional single path to scan
 * @returns Sorted absolute paths to markdown files
 */
function collectMarkdownFiles(rootDir: string, filter?: string): string[] {
  const skillDir = path.join(rootDir, '.agents', 'skills', 'blendsdk');

  if (filter) {
    const candidates = path.isAbsolute(filter)
      ? [filter]
      : [path.resolve(rootDir, filter), path.resolve(skillDir, filter)];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    return found ? [found] : [];
  }

  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) {
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  };

  walk(path.join(skillDir, 'references'));
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillFile)) {
    files.push(skillFile);
  }

  return files.sort();
}

/**
 * Locates the compiler that ships with the repository.
 *
 * @returns Absolute path to the `tsc` entry point
 * @throws SkillGenerationError when the compiler cannot be resolved
 */
function resolveCompilerPath(): string {
  try {
    const typescriptEntry = require.resolve('typescript');
    return path.join(path.dirname(path.dirname(typescriptEntry)), 'bin', 'tsc');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SkillGenerationError(`Cannot locate the TypeScript compiler: ${reason}`);
  }
}

/**
 * Runs the compiler over the throwaway project.
 *
 * @param compilerPath - Absolute path to `tsc`
 * @param tempDir - Absolute path to the throwaway project
 * @returns Combined compiler output
 * @throws SkillGenerationError when the process cannot be started
 */
function runCompiler(compilerPath: string, tempDir: string): string {
  const result = spawnSync(
    process.execPath,
    [compilerPath, '--project', path.join(tempDir, 'tsconfig.json')],
    { cwd: tempDir, encoding: 'utf-8' }
  );

  if (result.error) {
    throw new SkillGenerationError(
      `Failed to run the TypeScript compiler: ${result.error.message}`
    );
  }

  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Writes the given blocks into a throwaway project and compiles them.
 *
 * The project is created under `node_modules/.cache` so Node module resolution
 * can find the compiler and any peer packages, and a symlink named `blendsdk`
 * makes the umbrella package's own `exports` map resolve exactly as a consumer
 * would see it.
 *
 * @param rootDir - Absolute path to the repository root
 * @param entries - Blocks to compile
 * @param extension - File extension for every block in this pass
 * @returns Compiler output for the pass
 * @throws SkillGenerationError when the compiler cannot be located or started
 */
function compileBlocks(rootDir: string, entries: CompileBlock[], extension: 'ts' | 'tsx'): string {
  const compilerPath = resolveCompilerPath();
  const cacheDir = path.join(rootDir, 'node_modules', '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(cacheDir, 'skill-validate-'));

  try {
    const modulesDir = path.join(tempDir, 'node_modules');
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.symlinkSync(
      path.join(rootDir, 'packages', 'blendsdk'),
      path.join(modulesDir, 'blendsdk'),
      'dir'
    );

    for (const entry of entries) {
      fs.writeFileSync(
        path.join(tempDir, `block-${entry.index}.${extension}`),
        entry.code,
        'utf-8'
      );
    }
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify(TSCONFIG, null, 2) + '\n',
      'utf-8'
    );

    return runCompiler(compilerPath, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Extracts the block indexes that produced compiler errors.
 *
 * @param output - Compiler output
 * @returns Set of failing block indexes
 */
function failingBlockIndexes(output: string): Set<number> {
  const indexes = new Set<number>();
  const pattern = /^block-(\d+)\.tsx?\(\d+,\d+\): error TS\d+:/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    indexes.add(Number(match[1]));
  }
  return indexes;
}

/**
 * Turns compiler diagnostics into structured problems.
 *
 * @param output - Compiler output
 * @param blocks - Blocks keyed by index
 * @returns Problems addressed to the owning reference
 */
function formatDiagnostics(output: string, blocks: Map<number, CompileBlock>): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const pattern = /^block-(\d+)\.tsx?\((\d+),\d+\): error (TS\d+): (.*)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(output)) !== null) {
    const block = blocks.get(Number(match[1]));
    if (!block) {
      continue;
    }
    problems.push({
      file: block.reference,
      line: toReferenceLine(block.startLine, Number(match[2])),
      tier: '2',
      message: `error ${match[3]}: ${match[4]}`,
    });
  }
  return problems;
}

/**
 * Renders one structured problem as a `file:line: message` line.
 *
 * @param problem - Problem to render
 * @returns Single-line description
 */
export function formatProblem(problem: ValidationProblem): string {
  return problem.line === undefined
    ? `${problem.file ? `${problem.file}: ` : ''}${problem.message}`
    : `${problem.file}:${problem.line}: ${problem.message}`;
}

/**
 * Serializes a report as the JSON document written by `--report`.
 *
 * The shape is meant for tooling and coding agents: each entry names the file,
 * the line, the tier that failed, and a plain-language message, so an agent can
 * turn a red build into a concrete work list without parsing prose.
 *
 * @param report - Validation report to serialize
 * @returns Pretty-printed JSON
 */
export function formatValidationReport(report: ValidationReport): string {
  return (
    JSON.stringify(
      {
        ok: report.ok,
        filesScanned: report.filesScanned,
        blocksChecked: report.blocksChecked,
        fragmentsSkipped: report.fragmentsSkipped,
        contextualSkipped: report.contextualSkipped,
        counterExamplesSkipped: report.counterExamplesSkipped,
        problemCount: report.details.length,
        problems: report.details,
      },
      null,
      2
    ) + '\n'
  );
}

/**
 * Checks the skill's examples against the assembled SDK.
 *
 * @param rootDir - Absolute path to the repository root
 * @param options - Optional scan narrowing
 * @returns The validation report
 * @throws SkillGenerationError when the umbrella manifest cannot be read
 */
export function validateExamples(
  rootDir: string,
  options: ValidateExamplesOptions = {}
): ValidationReport {
  const resolvedRoot = path.resolve(rootDir);
  const exports = readUmbrellaExports(resolvedRoot);
  const files = collectMarkdownFiles(resolvedRoot, options.filter);
  const details: ValidationProblem[] = [];
  const symbolCache = new Map<string, Set<string>>();

  let filesScanned = 0;
  let blocksChecked = 0;
  let fragmentsSkipped = 0;
  let contextualSkipped = 0;
  let counterExamplesSkipped = 0;
  const compileBlocksList: CompileBlock[] = [];
  let compileIndex = 0;

  if (options.filter && files.length === 0) {
    details.push({ file: options.filter, tier: 'filter', message: 'filter path not found' });
  }

  for (const file of files) {
    filesScanned += 1;
    const reference = toReferencePath(resolvedRoot, file);
    const blocks = parseFencedBlocks(fs.readFileSync(file, 'utf-8'));
    const isApiReference = /\/api\.md$/.test(file);

    for (const block of blocks) {
      if (!TYPESCRIPT_PATTERN.test(block.info)) {
        continue;
      }

      blocksChecked += 1;

      if (isCounterExample(block)) {
        counterExamplesSkipped += 1;
        continue;
      }

      for (const imported of parseImports(block.code)) {
        if (!imported.specifier.startsWith('blendsdk/')) {
          continue;
        }

        const subpath = imported.specifier.slice('blendsdk/'.length);
        const entry = exports.get(subpath);
        const line = toReferenceLine(block.startLine, imported.line);

        if (!entry) {
          details.push({
            file: reference,
            line,
            tier: '1a',
            message: `unknown package specifier '${imported.specifier}'`,
          });
          continue;
        }

        if (!symbolCache.has(entry.sourcePath)) {
          symbolCache.set(entry.sourcePath, collectExportedSymbols(entry.sourcePath));
        }
        const surface = symbolCache.get(entry.sourcePath) ?? new Set<string>();
        if (surface.has(OPEN_SURFACE)) {
          continue;
        }

        for (const name of imported.names) {
          if (!surface.has(name)) {
            details.push({
              file: reference,
              line,
              tier: '1b',
              message: `unknown symbol '${name}' imported from '${imported.specifier}'`,
            });
          }
        }
      }

      if (FRAGMENT_PATTERN.test(block.info)) {
        fragmentsSkipped += 1;
        continue;
      }

      if (isApiReference) {
        continue;
      }

      if (isContextualExample(block.code)) {
        contextualSkipped += 1;
        continue;
      }

      compileBlocksList.push({
        index: compileIndex,
        file,
        reference,
        code: block.code,
        startLine: block.startLine,
      });
      compileIndex += 1;
    }
  }

  if (options.compile !== false && compileBlocksList.length > 0) {
    const distDir = path.join(resolvedRoot, 'packages', 'blendsdk', 'dist');
    if (!fs.existsSync(distDir)) {
      details.push({
        file: '',
        tier: 'build',
        message: 'Umbrella package not built. Run: npx turbo run build --filter=blendsdk',
      });
    } else {
      const byIndex = new Map(compileBlocksList.map(entry => [entry.index, entry]));
      const firstPass = compileBlocks(resolvedRoot, compileBlocksList, 'ts');
      const failing = failingBlockIndexes(firstPass);

      if (failing.size > 0) {
        const retry = compileBlocksList.filter(entry => failing.has(entry.index));
        const secondPass = compileBlocks(resolvedRoot, retry, 'tsx');
        const stillFailing = failingBlockIndexes(secondPass);
        const neverFailing = new Set([...failing].filter(index => !stillFailing.has(index)));

        for (const index of neverFailing) {
          byIndex.delete(index);
        }
        details.push(...formatDiagnostics(secondPass, byIndex));
      }
    }
  }

  return {
    ok: details.length === 0,
    problems: details.map(formatProblem),
    details,
    filesScanned,
    blocksChecked,
    fragmentsSkipped,
    contextualSkipped,
    counterExamplesSkipped,
  };
}

/**
 * Runs the validator as a command-line tool.
 */
function main(): void {
  const args = process.argv.slice(2);
  let filter: string | undefined;
  let reportPath: string | undefined;
  // The command line gates the deterministic import and symbol tiers by
  // default; tier 2 (compiler) is opt-in so CI stays stable and the noisy
  // snippet checks are run locally.
  let compile = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--filter' && i + 1 < args.length) {
      filter = args[i + 1];
      i += 1;
    } else if (args[i] === '--compile') {
      compile = true;
    } else if (args[i] === '--report') {
      // The path is optional: a bare flag writes to the cache directory.
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        reportPath = args[i + 1];
        i += 1;
      } else {
        reportPath = path.join(
          process.cwd(),
          'node_modules',
          '.cache',
          'skill-validate',
          'report.json'
        );
      }
    }
  }

  try {
    const report = validateExamples(process.cwd(), { filter, compile });
    console.log(
      `Scanned ${report.filesScanned} files, checked ${report.blocksChecked} blocks, ` +
        `skipped ${report.fragmentsSkipped} fragments, ${report.contextualSkipped} contextual ` +
        `examples, ${report.counterExamplesSkipped} counter-examples` +
        `${compile ? ', compiler tier enabled' : ''}.`
    );

    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, formatValidationReport(report), 'utf-8');
      console.log(`Wrote validation report to ${reportPath}`);
    }

    if (report.ok) {
      console.log('All skill examples are valid.');
      return;
    }

    console.error(`Found ${report.problems.length} problem(s):`);
    for (const problem of report.problems) {
      console.error(`  ${problem}`);
    }
    process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  main();
}
