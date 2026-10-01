/**
 * One-time migration of the retired MCP's hand-written documentation.
 *
 * The skill's guides, patterns, templates, and architecture reference are
 * migrated from `packages/blendsdk-mcp/docs/` rather than regenerated, because
 * they are curated by hand. This module copies them with two deterministic
 * transforms: public import rewriting and removal of any embedded version
 * header. It also rewrites links that point at other migrated files and removes
 * links to files that are not migrated, so the skill never carries dangling
 * references.
 *
 * Migration is invoked once through the `--migrate` flag of the generator. The
 * copied files are intentionally left without the generated-file marker; the
 * drift gate compares generated files only.
 *
 * @module skill/migrate
 */

import fs from 'node:fs';
import path from 'node:path';

import { rewriteImports } from '../techdocs/rewrite-imports.js';
import {
  LEGACY_ARCHITECTURE_DESTINATION,
  LEGACY_ARCHITECTURE_SOURCES,
  LEGACY_DOCS_ROOT,
  LEGACY_GUIDES,
  LEGACY_PATTERNS,
  LEGACY_TEMPLATES,
  SkillGenerationError,
  assertWithinRoot,
  buildLegacyLinkMap,
  replacePrivateScope,
} from './mapping.js';
import { findSecret } from './secrets.js';

import type { LegacyFileMapping } from './mapping.js';

/**
 * Options for a migration run.
 */
export interface MigrateSkillOptions {
  /** Absolute path to the monorepo root. */
  rootDir: string;

  /** Destination skill folder. Defaults to `<rootDir>/.agents/skills/blendsdk`. */
  skillDir?: string;
}

/**
 * Result of a migration run.
 */
export interface MigrateSkillSummary {
  /** Migrated file paths relative to the skill folder, using `/`. */
  filesWritten: string[];
}

/**
 * Applies the migration normalization rules to one source document.
 *
 * Rule 1 rewrites private `@blendsdk/*` imports to public `blendsdk/*` paths;
 * rule 2 removes any embedded version header so migrated content stays
 * versionless. Line endings are normalized to LF for deterministic output.
 *
 * @param content - Raw source document
 * @returns Normalized document
 */
export function normalizeMigratedContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const rewritten = replacePrivateScope(rewriteImports(normalized));
  return rewritten.replace(/^> \*\*Version\*\*:.*$\n?/gm, '');
}

/**
 * Rewrites links to migrated files and removes links to unmigrated files.
 *
 * A link whose target resolves to another migrated source is remapped to that
 * file's destination. A link to a file that has no destination is reduced to
 * its display text, so the skill never points at a file that does not exist.
 * Anchors are preserved. Links to non-markdown targets are left untouched.
 *
 * @param content - Document content
 * @param sourceRelative - Source path relative to the MCP documentation root
 * @param destinationRelative - Destination path relative to the skill folder
 * @param linkMap - Map of migrated source paths to destination paths
 * @returns Content with links rewritten
 */
export function rewriteMigratedLinks(
  content: string,
  sourceRelative: string,
  destinationRelative: string,
  linkMap: ReadonlyMap<string, string>
): string {
  const sourceDir = path.posix.dirname(sourceRelative);
  const destinationDir = path.posix.dirname(destinationRelative);

  return content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (whole, text: string, target: string) => {
    const [pathPart, anchor] = splitAnchor(target);

    if (!pathPart.endsWith('.md')) {
      return whole;
    }

    const resolved = path.posix.normalize(path.posix.join(sourceDir, pathPart));
    const mapped = linkMap.get(resolved);

    if (!mapped) {
      return text;
    }

    const relative = path.posix.relative(destinationDir, mapped) || path.posix.basename(mapped);
    return `[${text}](${relative}${anchor})`;
  });
}

/**
 * Splits a markdown link target into its path and fragment parts.
 *
 * @param target - Link target such as `foo.md#section`
 * @returns The path (without fragment) and the fragment including `#`, or an empty string
 */
function splitAnchor(target: string): [string, string] {
  const hashIndex = target.indexOf('#');
  return hashIndex === -1 ? [target, ''] : [target.slice(0, hashIndex), target.slice(hashIndex)];
}

/**
 * Reads and validates one migration source.
 *
 * The read fails closed: a missing file, a path that escapes the documentation
 * root, or embedded secret material aborts the migration before anything is
 * written, mirroring the generator's rules.
 *
 * @param docsRoot - Absolute path to the MCP documentation root
 * @param relativePath - Source path relative to `docsRoot`
 * @returns Raw source content
 * @throws SkillGenerationError when the source is missing, escapes the root, or has a secret
 */
function readSource(docsRoot: string, relativePath: string): string {
  const absolutePath = path.join(docsRoot, relativePath);

  if (!fs.existsSync(absolutePath)) {
    throw new SkillGenerationError(`Missing migration source: ${absolutePath}`);
  }

  assertWithinRoot(docsRoot, absolutePath);

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const secret = findSecret(content);

  if (secret) {
    throw new SkillGenerationError(`Refusing to migrate: ${relativePath} contains ${secret}`);
  }

  return content;
}

/**
 * Writes one migrated file, validating that it stays inside the skill folder.
 *
 * @param skillDir - Absolute path to the skill folder
 * @param destinationRelative - Destination path relative to `skillDir`
 * @param content - File content to write
 */
function writeMigratedFile(skillDir: string, destinationRelative: string, content: string): void {
  const destination = path.join(skillDir, destinationRelative);
  assertWithinRoot(skillDir, destination);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf-8');
}

/**
 * Migrates one standalone source file with import, version, and link rewrites.
 *
 * @param context - Migration context shared by all files
 * @param mapping - Source and destination for the file
 * @returns The destination path relative to the skill folder
 */
function migrateFile(context: MigrationContext, mapping: LegacyFileMapping): string {
  const raw = readSource(context.docsRoot, mapping.source);
  const normalized = normalizeMigratedContent(raw);
  const content = rewriteMigratedLinks(
    normalized,
    mapping.source,
    mapping.destination,
    context.linkMap
  );

  writeMigratedFile(context.skillDir, mapping.destination, content);
  return mapping.destination;
}

/**
 * Migrates the three hand-written architecture documents into one reference.
 *
 * The MCP architecture index links to project-structure and design-patterns;
 * those links become in-document anchors because the three files are merged.
 * The generated dependency graph is linked, not copied.
 *
 * @param context - Migration context shared by all files
 * @returns The destination path relative to the skill folder
 */
function migrateArchitecture(context: MigrationContext): string {
  const sections = LEGACY_ARCHITECTURE_SOURCES.map(source => {
    const raw = readSource(context.docsRoot, source);
    const normalized = normalizeMigratedContent(raw)
      .replace(/\]\(0?2-project-structure\.md\)/g, '](#project-structure)')
      .replace(/\]\(0?3-design-patterns\.md\)/g, '](#design-patterns)');

    return rewriteMigratedLinks(
      normalized.trim(),
      source,
      LEGACY_ARCHITECTURE_DESTINATION,
      context.linkMap
    );
  });

  const body = [
    ...sections,
    '## Dependency Graph',
    '',
    'The package dependency graph is regenerated from package metadata. See ' +
      '[dependency-graph.md](dependency-graph.md).',
  ].join('\n\n---\n\n');

  const content = `${body.trim()}\n`;
  writeMigratedFile(context.skillDir, LEGACY_ARCHITECTURE_DESTINATION, content);
  return LEGACY_ARCHITECTURE_DESTINATION;
}

/**
 * Shared state for one migration run.
 */
interface MigrationContext {
  /** Absolute path to the MCP documentation root. */
  docsRoot: string;

  /** Absolute path to the destination skill folder. */
  skillDir: string;

  /** Migrated source-to-destination link map. */
  linkMap: Map<string, string>;
}

/**
 * Migrates the retired MCP's hand-written content into the skill folder.
 *
 * Existing destination files are overwritten, which makes the operation
 * idempotent. Because this is a one-time source-of-truth move, it is run through
 * the generator's `--migrate` flag rather than on every generation.
 *
 * @param options - Migration options
 * @returns A summary of the migrated files
 * @throws SkillGenerationError when a source is missing or a destination escapes the skill folder
 */
export function migrateSkillContent(options: MigrateSkillOptions): MigrateSkillSummary {
  const rootDir = path.resolve(options.rootDir);
  const skillDir = path.resolve(
    options.skillDir ?? path.join(rootDir, '.agents', 'skills', 'blendsdk')
  );

  const linkMap = buildLegacyLinkMap();
  linkMap.set('04-architecture/01-dependency-graph.md', 'references/dependency-graph.md');

  const context: MigrationContext = {
    docsRoot: path.join(rootDir, LEGACY_DOCS_ROOT),
    skillDir,
    linkMap,
  };

  const filesWritten: string[] = [];

  for (const mapping of [...LEGACY_GUIDES, ...LEGACY_PATTERNS, ...LEGACY_TEMPLATES]) {
    filesWritten.push(migrateFile(context, mapping));
  }

  filesWritten.push(migrateArchitecture(context));

  return { filesWritten };
}
