/**
 * Deterministic generator for the BlendSDK agent skill tree.
 *
 * The generator reads every documented package's `ai-training/` markdown,
 * normalizes it, and merges it into the five focused reference files the skill
 * exposes. Output is byte-reproducible: package order is alphabetical, each
 * reference merges its sources in a fixed order, line endings are LF, and no
 * timestamps are written.
 *
 * The hand-written `SKILL.md` is never written by the generator; it is only
 * checked for existence. All work is prepared in memory first, so any error
 * (a missing source, a path escape, or secret material) leaves no partial tree
 * behind.
 *
 * @module skill/generate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverDocumentablePackages } from '../ai-training/change-detection.js';
import { cleanMetadataHeaders, rewriteImports } from '../techdocs/rewrite-imports.js';
import { generateDependencyGraph } from './architecture.js';
import {
  GENERATED_MARKER,
  SkillGenerationError,
  assertWithinRoot,
  replacePrivateScope,
  resolveReferenceGroups,
  rewriteReferenceLinks,
} from './mapping.js';
import { migrateSkillContent } from './migrate.js';
import { findSecret } from './secrets.js';

/**
 * Options for a single generation run.
 */
export interface GenerateSkillOptions {
  /** Absolute path to the monorepo root. */
  rootDir: string;

  /**
   * Directory holding the hand-written `SKILL.md`. Defaults to
   * `<rootDir>/.agents/skills/blendsdk`.
   */
  skillDir?: string;

  /**
   * Directory the generated files are written to. Defaults to `skillDir`, so a
   * normal run refreshes the committed tree while the drift gate can target a
   * temporary directory.
   */
  outputDir?: string;

  /**
   * Package short names to generate. Defaults to every package discovered under
   * `packages/` that has both a `package.json` and a `src/` directory.
   */
  packages?: string[];
}

/**
 * Result of a successful generation run.
 */
export interface GenerateSkillSummary {
  /** Sorted package short names that were generated. */
  packages: string[];

  /** Generated file paths relative to the output directory, using `/`. */
  filesWritten: string[];
}

/**
 * Strips a wrapping markdown code fence from ai-training content.
 *
 * Some ai-training files wrap their whole body in a ```` ```markdown ```` fence
 * meant for LLM consumption. The generator writes real markdown, so the outer
 * fence is removed. Only the first opening fence and the last closing fence are
 * removed, which leaves any nested example fences intact.
 *
 * @param content - Raw file content
 * @returns Content without the outer fence, or the original when none is found
 */
function stripWrappingFence(content: string): string {
  const trimmed = content.trim();
  const openMatch = trimmed.match(/^```(?:markdown|md)?\s*\n/);

  if (!openMatch) {
    return content;
  }

  const lastFenceIndex = trimmed.lastIndexOf('\n```');
  if (lastFenceIndex === -1 || lastFenceIndex < openMatch[0].length) {
    return content;
  }

  return trimmed.slice(openMatch[0].length, lastFenceIndex);
}

/**
 * Normalizes one ai-training source into skill-ready markdown.
 *
 * Applies the mandatory normalization rules: strip the outer fence, drop
 * per-file metadata headers, rewrite imports to the public `blendsdk/` form,
 * and rewrite links to sibling ai-training files so they point at the merged
 * reference.
 *
 * @param raw - Raw source file content
 * @param packageName - Short package name, used to clean headings and links
 * @returns Normalized markdown
 */
function normalizeSource(raw: string, packageName: string): string {
  // Normalize line endings first: the determinism contract promises LF output
  // regardless of how the source file was checked out on disk.
  const normalized = raw.replace(/\r\n/g, '\n');

  let content = stripWrappingFence(normalized);
  content = cleanMetadataHeaders(content, packageName);
  content = rewriteImports(content);
  content = rewriteReferenceLinks(content);
  content = replacePrivateScope(content);

  return content.trim();
}

/**
 * Builds one generated reference file.
 *
 * The file opens with a canonical metadata header naming the public package
 * (the installed package version identifies the skill, so no per-file version
 * is written), then merges the normalized sources, then ends with the
 * generated marker.
 *
 * @param packageName - Short package name
 * @param sources - Normalized source sections, in merge order
 * @returns The complete reference file content
 */
function buildReferenceContent(packageName: string, sources: string[]): string {
  const header = `> **Package**: \`blendsdk/${packageName}\``;
  const body = sources.join('\n\n---\n\n');

  return `${header}\n\n${body}\n\n${GENERATED_MARKER}\n`;
}

/**
 * Task families and the references that answer them.
 *
 * The routing table is the progressive-disclosure entry point: an agent starts
 * here, picks the family that matches the request, and loads only the linked
 * references. Every target must exist in the committed tree.
 */
const TASK_ROUTES: ReadonlyArray<{ family: string; links: string[] }> = [
  {
    family: 'CRUD API',
    links: ['packages/webafx/overview.md', 'patterns/01-web-api-crud.md'],
  },
  {
    family: 'Authentication',
    links: ['packages/webafx-auth/overview.md', 'patterns/02-authentication-jwt.md'],
  },
  {
    family: 'Authorization',
    links: [
      'packages/authz/overview.md',
      'packages/webafx-authz/overview.md',
      'packages/react/overview.md',
    ],
  },
  {
    family: 'Caching',
    links: ['packages/webafx-cache/overview.md', 'patterns/03-caching-patterns.md'],
  },
  {
    family: 'Database',
    links: [
      'packages/dbcore/overview.md',
      'packages/postgresql/overview.md',
      'patterns/04-database-queries.md',
    ],
  },
  {
    family: 'Email',
    links: ['packages/webafx-mailer/overview.md', 'patterns/07-email-sending.md'],
  },
  {
    family: 'Internationalization',
    links: [
      'packages/i18n/overview.md',
      'packages/webafx-i18n/overview.md',
      'patterns/08-internationalization.md',
    ],
  },
  {
    family: 'Logging',
    links: ['packages/webafx-pino/overview.md'],
  },
  {
    family: 'Code generation',
    links: ['packages/codegen/overview.md', 'patterns/06-code-generation.md'],
  },
  {
    family: 'Typed API client',
    links: [
      'packages/api-client/overview.md',
      'packages/codegen/overview.md',
      'patterns/10-client-sdk-generation.md',
    ],
  },
  {
    family: 'Testing',
    links: ['patterns/09-testing-patterns.md'],
  },
];

/**
 * Renders a markdown link whose display text is the target's file stem.
 *
 * @param target - Path relative to `references/`
 * @returns Markdown link
 */
function toLink(target: string): string {
  const stem = path.basename(target, '.md');
  return `[${stem}](${target})`;
}

/**
 * Builds the generated `references/index.md` routing map.
 *
 * @param packages - Sorted package short names
 * @returns The index file content
 */
function buildIndex(packages: string[]): string {
  const lines = [
    '# BlendSDK Skill References',
    '',
    'Generated routing map for the BlendSDK agent skill. Each package exposes five focused references.',
    '',
    '| Package | Overview | Usage | API | Recipes | Pitfalls |',
    '|---------|----------|-------|-----|---------|----------|',
  ];

  for (const packageName of packages) {
    const base = `packages/${packageName}`;
    lines.push(
      `| ${packageName} | [overview](${base}/overview.md) | [usage](${base}/usage.md) | ` +
        `[api](${base}/api.md) | [recipes](${base}/recipes.md) | [pitfalls](${base}/pitfalls.md) |`
    );
  }

  lines.push('', '## Task routing', '', '| Task family | Read |', '|-------------|------|');

  for (const { family, links } of TASK_ROUTES) {
    lines.push(`| ${family} | ${links.map(toLink).join(', ')} |`);
  }

  lines.push(
    '',
    '## Architecture',
    '',
    `See [architecture](architecture.md) and [dependency-graph](dependency-graph.md).`,
    '',
    GENERATED_MARKER,
    ''
  );

  return lines.join('\n');
}

/**
 * Removes generated files that the current run no longer produces.
 *
 * When a package or a reference is removed, its previously generated file would
 * otherwise linger and keep the drift gate permanently red, because
 * regeneration alone could never delete it. Only files ending with the
 * generated marker are candidates, so hand-written and migrated content is
 * always preserved.
 *
 * @param outputDir - Directory that holds the generated tree
 * @param keep - Relative paths the current run wrote
 */
function removeStaleGeneratedFiles(outputDir: string, keep: ReadonlySet<string>): void {
  if (!fs.existsSync(outputDir)) {
    return;
  }

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);

        // Remove directories that the prune just emptied, so a removed package
        // leaves no orphan directory behind for `find`-based content checks.
        if (fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(outputDir, fullPath).split(path.sep).join('/');

      if (keep.has(relativePath)) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.trimEnd().endsWith(GENERATED_MARKER)) {
        fs.rmSync(fullPath);
      }
    }
  };

  walk(outputDir);
}

/**
 * Generates the skill reference tree from the current package sources.
 *
 * All files are prepared and validated in memory before the first write, so an
 * error never leaves a partially generated tree.
 *
 * @param options - Generation options
 * @returns A summary of the packages and files that were written
 * @throws SkillGenerationError when `SKILL.md` is missing, a source is missing
 *   or escapes its package, or secret material is found
 */
export function generateSkillTree(options: GenerateSkillOptions): GenerateSkillSummary {
  const rootDir = path.resolve(options.rootDir);
  const skillDir = path.resolve(
    options.skillDir ?? path.join(rootDir, '.agents', 'skills', 'blendsdk')
  );
  const outputDir = path.resolve(options.outputDir ?? skillDir);

  const skillFilePath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFilePath)) {
    throw new SkillGenerationError(`Missing hand-written SKILL.md: ${skillFilePath}`);
  }

  const packageNames = (options.packages ?? discoverDocumentablePackages(rootDir)).slice().sort();

  const pending: Array<{ relativePath: string; content: string }> = [];

  for (const packageName of packageNames) {
    const packageDir = assertWithinRoot(rootDir, path.join(rootDir, 'packages', packageName));
    const groups = resolveReferenceGroups(packageDir);

    for (const group of groups) {
      const sources = group.sourcePaths.map(sourcePath => {
        const raw = fs.readFileSync(sourcePath, 'utf-8');
        const secret = findSecret(raw);

        if (secret) {
          throw new SkillGenerationError(
            `Refusing to generate: ${path.relative(rootDir, sourcePath)} contains ${secret}`
          );
        }

        return normalizeSource(raw, packageName);
      });

      pending.push({
        relativePath: `references/packages/${packageName}/${group.destination}.md`,
        content: buildReferenceContent(packageName, sources),
      });
    }
  }

  pending.push({ relativePath: 'references/index.md', content: buildIndex(packageNames) });
  pending.push({
    relativePath: 'references/dependency-graph.md',
    content: generateDependencyGraph(rootDir, packageNames),
  });

  const filesWritten: string[] = [];

  for (const file of pending) {
    const destination = path.join(outputDir, file.relativePath);
    assertWithinRoot(outputDir, destination);

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, file.content, 'utf-8');
    filesWritten.push(file.relativePath);
  }

  // Prune after a successful write so a failure never deletes existing output.
  removeStaleGeneratedFiles(outputDir, new Set(filesWritten));

  return { packages: packageNames, filesWritten };
}

/**
 * Runs the generator as a command-line tool.
 *
 * With `--migrate`, copies the retired MCP's hand-written guides, patterns,
 * templates, and architecture reference into the skill folder (a one-time step).
 * Otherwise generates the package references, routing index, and dependency
 * graph. Prints a summary on success and the error message (without a stack
 * trace) plus a non-zero exit code on failure.
 */
function main(): void {
  try {
    const rootDir = process.cwd();

    if (process.argv.includes('--migrate')) {
      const migrated = migrateSkillContent({ rootDir });
      console.log(`Migrated ${migrated.filesWritten.length} hand-written files.`);
      for (const relativePath of migrated.filesWritten) {
        console.log(`  ${relativePath}`);
      }
      return;
    }

    const summary = generateSkillTree({ rootDir });
    const referencesByPackage = new Map<string, number>();

    for (const relativePath of summary.filesWritten) {
      const match = relativePath.match(/^references\/packages\/([^/]+)\//);
      if (match) {
        referencesByPackage.set(match[1], (referencesByPackage.get(match[1]) ?? 0) + 1);
      }
    }

    console.log(
      `Generated ${summary.filesWritten.length} files for ${summary.packages.length} package(s).`
    );
    for (const packageName of summary.packages) {
      console.log(`  ${packageName}: ${referencesByPackage.get(packageName) ?? 0} references`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
