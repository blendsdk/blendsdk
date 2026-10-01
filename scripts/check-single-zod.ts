/**
 * Single-Zod guard.
 *
 * The repository must resolve Zod exactly once, at the version whose native
 * `z.toJSONSchema` the OpenAPI tooling uses. A second resolution, a nested
 * copy, a `zod/v3` or `zod/v4` subpath import, or a runtime package that
 * depends on Zod would let two parsers drift apart. This check reports every
 * such violation so CI can fail before it reaches a release.
 *
 * The check is pure and reads only the filesystem, so tests can point it at a
 * fixture tree as well as the real repository.
 *
 * @module check-single-zod
 */

import fs from 'node:fs';
import path from 'node:path';

/** The one supported Zod version. */
export const ZOD_VERSION = '4.4.3';

/** The Zod package name. */
const ZOD_PACKAGE = 'zod';

/** Package manifest fields that declare a dependency. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** Source file extensions scanned for subpath imports and generated clients. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** Directories that never contain authored source. */
const EXCLUDED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);

/** One rule violation with a human-readable description. */
export interface SingleZodViolation {
  /** A sentence that names the offending file and the rule it breaks. */
  readonly message: string;
}

/** The outcome of a single-Zod check. */
export interface SingleZodResult {
  /** True when no rule was violated. */
  readonly ok: boolean;
  /** Every distinct `zod` version resolved by `yarn.lock`, sorted. */
  readonly versions: readonly string[];
  /** Every rule violation; empty when `ok` is true. */
  readonly violations: readonly SingleZodViolation[];
}

/**
 * Checks the single-Zod invariant for a repository root.
 *
 * @param rootDir - The repository root that contains `yarn.lock` and `packages/`.
 * @returns The resolved Zod versions and every violation found.
 */
export function checkSingleZod(rootDir: string): SingleZodResult {
  const violations: SingleZodViolation[] = [];
  const versions = collectLockedVersions(rootDir, violations);
  checkNestedCopies(rootDir, violations);
  checkRuntimeManifest(rootDir, violations);
  checkGeneratedClients(rootDir, violations);
  checkSubpathImports(rootDir, violations);
  return { ok: violations.length === 0, versions, violations };
}

/**
 * Reads the `zod` resolutions from `yarn.lock`.
 *
 * Yarn v1 groups several ranges into one block key (for example
 * `zod@^4.4.3, zod@^4.0.0:`), so the block header is matched, not the whole
 * line. Exactly one distinct version is allowed, and it must equal
 * {@link ZOD_VERSION}.
 *
 * @param rootDir - The repository root.
 * @param violations - Collects rule violations.
 * @returns The distinct resolved versions, sorted.
 */
function collectLockedVersions(rootDir: string, violations: SingleZodViolation[]): string[] {
  const lockPath = path.join(rootDir, 'yarn.lock');
  if (!fs.existsSync(lockPath)) {
    violations.push({ message: 'yarn.lock is missing; the Zod version cannot be verified.' });
    return [];
  }

  const blocks = fs.readFileSync(lockPath, 'utf-8').split(/\n{2,}/);
  const versions = new Set<string>();

  for (const block of blocks) {
    const newlineIndex = block.indexOf('\n');
    const header = (newlineIndex === -1 ? block : block.slice(0, newlineIndex)).trim();
    if (!isZodDescriptor(header)) {
      continue;
    }
    const match = /^\s+version "([^"]+)"/m.exec(block);
    if (!match) {
      violations.push({ message: `yarn.lock has a zod entry without a version: ${header}` });
      continue;
    }
    versions.add(match[1]);
  }

  const sorted = [...versions].sort();
  if (sorted.length === 0) {
    violations.push({ message: 'yarn.lock resolves no zod package.' });
  } else if (sorted.length > 1) {
    violations.push({
      message: `yarn.lock resolves more than one zod version: ${sorted.join(', ')}.`,
    });
  } else if (sorted[0] !== ZOD_VERSION) {
    violations.push({
      message: `yarn.lock resolves zod ${sorted[0]}, expected ${ZOD_VERSION}.`,
    });
  }

  return sorted;
}

/**
 * Reports whether a `yarn.lock` block header names the `zod` package.
 *
 * @param header - The block header without its trailing colon.
 * @returns True when any descriptor in the header is `zod`.
 */
function isZodDescriptor(header: string): boolean {
  const descriptor = header.replace(/:\s*$/, '');
  return descriptor.split(',').some(part => unquote(part.trim()).startsWith(`${ZOD_PACKAGE}@`));
}

/**
 * Removes one pair of surrounding double quotes.
 *
 * Yarn v1 quotes a descriptor that contains whitespace, for example
 * `"zod@>=3.0.0 <4.0.0"`, so the leading quote must be removed before the
 * package name can match.
 *
 * @param value - A trimmed lock descriptor.
 * @returns The descriptor without surrounding quotes.
 */
function unquote(value: string): string {
  return value.replace(/^"(.*)"$/u, '$1');
}

/**
 * Reports nested `node_modules/zod` directories.
 *
 * The root `node_modules/zod` is the single allowed copy. Any other copy — under
 * a package, under a hoisted dependency, under a scoped package, or deeper —
 * means two Zod instances can load. The scan recurses through `node_modules`
 * directories to a bounded depth so a nested install cannot hide.
 *
 * @param rootDir - The repository root.
 * @param violations - Collects rule violations.
 */
function checkNestedCopies(rootDir: string, violations: SingleZodViolation[]): void {
  const allowed = path.join(rootDir, 'node_modules', ZOD_PACKAGE);
  const roots = [path.join(rootDir, 'node_modules')];

  const packagesDir = path.join(rootDir, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        roots.push(path.join(packagesDir, entry.name, 'node_modules'));
      }
    }
  }

  for (const root of roots) {
    scanForNestedZod(root, allowed, 0, rootDir, violations);
  }
}

/** The deepest nested `node_modules` level the guard inspects. */
const NESTED_SCAN_DEPTH = 4;

/**
 * Recursively finds `zod` packages below a `node_modules` directory.
 *
 * @param directory - The `node_modules` directory to scan.
 * @param allowed - The absolute path of the one allowed copy.
 * @param depth - The current nesting depth.
 * @param rootDir - The repository root, for relative reporting.
 * @param violations - Collects rule violations.
 */
function scanForNestedZod(
  directory: string,
  allowed: string,
  depth: number,
  rootDir: string,
  violations: SingleZodViolation[]
): void {
  if (depth > NESTED_SCAN_DEPTH || !fs.existsSync(directory)) {
    return;
  }

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(directory, entry.name);

    if (entry.name === ZOD_PACKAGE) {
      if (candidate !== allowed) {
        violations.push({
          message: `A nested zod copy exists at ${relative(rootDir, candidate)}.`,
        });
      }
      continue;
    }

    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(candidate, { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          scanForNestedZod(
            path.join(candidate, scoped.name, 'node_modules'),
            allowed,
            depth + 1,
            rootDir,
            violations
          );
        }
      }
      continue;
    }

    scanForNestedZod(path.join(candidate, 'node_modules'), allowed, depth + 1, rootDir, violations);
  }
}

/**
 * Reports a `zod` dependency in the runtime client manifest.
 *
 * @param rootDir - The repository root.
 * @param violations - Collects rule violations.
 */
function checkRuntimeManifest(rootDir: string, violations: SingleZodViolation[]): void {
  const manifestPath = path.join(rootDir, 'packages', 'api-client', 'package.json');
  const manifest = readJson(manifestPath);
  if (!manifest) {
    return;
  }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field];
    if (isRecord(dependencies) && ZOD_PACKAGE in dependencies) {
      violations.push({
        message: `packages/api-client/package.json declares zod in ${field}.`,
      });
    }
  }
}

/**
 * Reports a `zod` import in generated client output.
 *
 * @param rootDir - The repository root.
 * @param violations - Collects rule violations.
 */
function checkGeneratedClients(rootDir: string, violations: SingleZodViolation[]): void {
  const generatedDir = path.join(rootDir, 'packages', 'playground', 'src', 'api-client');
  if (!fs.existsSync(generatedDir)) {
    return;
  }

  for (const filePath of walkFiles(generatedDir)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (importsZod(content)) {
      violations.push({
        message: `A generated client imports zod: ${relative(rootDir, filePath)}.`,
      });
    }
  }
}

/**
 * Reports `zod/v3` and `zod/v4` subpath imports in authored source.
 *
 * @param rootDir - The repository root.
 * @param violations - Collects rule violations.
 */
function checkSubpathImports(rootDir: string, violations: SingleZodViolation[]): void {
  const packagesDir = path.join(rootDir, 'packages');
  if (!fs.existsSync(packagesDir)) {
    return;
  }

  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourceDir = path.join(packagesDir, entry.name, 'src');
    if (!fs.existsSync(sourceDir)) {
      continue;
    }
    for (const filePath of walkFiles(sourceDir)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (/['"]zod\/v[34]['"]/.test(content)) {
        violations.push({
          message: `A source file imports a zod subpath: ${relative(rootDir, filePath)}.`,
        });
      }
    }
  }
}

/**
 * True when file content imports the `zod` package.
 *
 * @param content - The file content.
 * @returns True for a static or dynamic `zod` import.
 */
function importsZod(content: string): boolean {
  return /(?:from\s*['"]zod['"]|require\(\s*['"]zod['"]\s*\)|import\(\s*['"]zod['"]\s*\))/.test(
    content
  );
}

/**
 * Recursively lists source files below a directory.
 *
 * Only regular files are returned. A symbolic link or a special file is never
 * read, so a committed link cannot cause an out-of-tree read or block the scan.
 *
 * @param directory - The directory to walk.
 * @returns Absolute paths of matching files.
 */
function walkFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
        files.push(...walkFiles(fullPath));
      }
    } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Reads and parses a JSON file, returning undefined when absent or invalid.
 *
 * @param filePath - The file path.
 * @returns The parsed object, or undefined.
 */
function readJson(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Narrows an unknown value to a plain object.
 *
 * @param value - The value to inspect.
 * @returns True when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Formats a path relative to the repository root with forward slashes.
 *
 * @param rootDir - The repository root.
 * @param target - The absolute path.
 * @returns The relative path.
 */
function relative(rootDir: string, target: string): string {
  return path.relative(rootDir, target).split(path.sep).join('/');
}
