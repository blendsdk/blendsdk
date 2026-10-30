/**
 * Single-Zod guard.
 *
 * The repository must resolve Zod exactly once, at the version whose native
 * `z.toJSONSchema` the OpenAPI tooling uses. A second resolution, a `zod/v3`
 * or `zod/v4` subpath import, or a runtime package that depends on Zod would
 * let two parsers drift apart. This check reports every such violation so CI
 * can fail before it reaches a release.
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
  /** Every distinct `zod` version resolved by `pnpm-lock.yaml`, sorted. */
  readonly versions: readonly string[];
  /** Every rule violation; empty when `ok` is true. */
  readonly violations: readonly SingleZodViolation[];
}

/**
 * Checks the single-Zod invariant for a repository root.
 *
 * @param rootDir - The repository root that contains `pnpm-lock.yaml` and `packages/`.
 * @returns The resolved Zod versions and every violation found.
 */
export function checkSingleZod(rootDir: string): SingleZodResult {
  const violations: SingleZodViolation[] = [];
  const versions = collectLockedVersions(rootDir, violations);
  checkRuntimeManifest(rootDir, violations);
  checkGeneratedClients(rootDir, violations);
  checkSubpathImports(rootDir, violations);
  return { ok: violations.length === 0, versions, violations };
}

/**
 * Reads the `zod` resolutions from `pnpm-lock.yaml`.
 *
 * The pnpm lockfile is line-oriented: every resolved package is a
 * `name@version` key indented by exactly two spaces under a top-level
 * `packages:` or `snapshots:` section. Scoped names are single-quoted and a
 * peer-resolved key carries a parenthesized suffix, so each key is normalized
 * before the `zod` package is matched. Exactly one distinct version is
 * allowed, and it must equal {@link ZOD_VERSION}.
 *
 * @param rootDir - The repository root.
 * @param violations - Collects rule violations.
 * @returns The distinct resolved versions, sorted.
 */
function collectLockedVersions(rootDir: string, violations: SingleZodViolation[]): string[] {
  const lockPath = path.join(rootDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(lockPath)) {
    violations.push({
      message: 'pnpm-lock.yaml is missing; the Zod version cannot be verified.',
    });
    return [];
  }

  const versions = new Set<string>();
  let sawPackagesSection = false;
  let insideResolvedSection = false;

  for (const line of fs.readFileSync(lockPath, 'utf-8').split(/\r?\n/)) {
    const section = /^([A-Za-z][A-Za-z0-9-]*):\s*$/.exec(line);
    if (section) {
      insideResolvedSection = section[1] === 'packages' || section[1] === 'snapshots';
      sawPackagesSection = sawPackagesSection || section[1] === 'packages';
      continue;
    }

    if (!insideResolvedSection) {
      continue;
    }

    const key = packageKey(line);
    if (!key) {
      continue;
    }
    const descriptor = key.replace(/\(.*$/, '').replace(/^\//, '');
    const atIndex = descriptor.lastIndexOf('@');
    if (atIndex <= 0 || descriptor.slice(0, atIndex) !== ZOD_PACKAGE) {
      continue;
    }
    const version = descriptor.slice(atIndex + 1);
    if (version) {
      versions.add(version);
    }
  }

  const sorted = [...versions].sort();
  if (!sawPackagesSection) {
    violations.push({
      message:
        'pnpm-lock.yaml has no packages section; the lockfile layout is not recognized, so the Zod version cannot be verified.',
    });
  } else if (sorted.length === 0) {
    violations.push({ message: 'pnpm-lock.yaml resolves no zod package.' });
  } else if (sorted.length > 1) {
    violations.push({
      message: `pnpm-lock.yaml resolves more than one zod version: ${sorted.join(', ')}.`,
    });
  } else if (sorted[0] !== ZOD_VERSION) {
    violations.push({
      message: `pnpm-lock.yaml resolves zod ${sorted[0]}, expected ${ZOD_VERSION}.`,
    });
  }

  return sorted;
}

/**
 * Extracts a resolved package key from one lockfile line.
 *
 * A resolved entry is indented by exactly two spaces and ends at the first
 * colon; scoped names wrap the key in single quotes. Deeper-indented metadata
 * lines such as `resolution:` are not keys.
 *
 * @param line - One raw lockfile line.
 * @returns The unquoted package key, or undefined for a non-key line.
 */
function packageKey(line: string): string | undefined {
  const match = /^ {2}(?! )'?([^':]+)'?:/.exec(line);
  return match ? match[1] : undefined;
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
