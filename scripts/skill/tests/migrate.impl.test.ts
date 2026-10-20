/**
 * Implementation tests for hand-written content migration.
 *
 * These cover the normalization and link-rewriting edge cases that the content
 * specification does not describe directly: import rewriting, version headers,
 * line endings, link remapping, anchors, and dropped links to unmigrated files.
 *
 * @module skill/tests/migrate.impl
 */

import { describe, expect, it } from 'vitest';

import { normalizeMigratedContent, rewriteMigratedLinks } from '../migrate.js';

describe('Migration normalization', () => {
  it('rewrites private imports to public blendsdk subpaths', () => {
    const result = normalizeMigratedContent(
      "import { WebApp } from '@blendsdk/webafx';"
    );

    expect(result).toContain("'blendsdk/webafx'");
    expect(result).not.toContain('@blendsdk/');
  });

  it('removes an embedded version header', () => {
    expect(normalizeMigratedContent('> **Version**: 1.2.3\n\nBody.')).toBe('\nBody.');
  });

  it('normalizes CRLF line endings to LF', () => {
    expect(normalizeMigratedContent('a\r\nb')).toBe('a\nb');
  });
});

describe('Migration link rewriting', () => {
  const linkMap = new Map<string, string>([
    ['01-getting-started/01-installation.md', 'references/guides/installation.md'],
    ['01-getting-started/02-project-scaffolding.md', 'references/guides/project-scaffolding.md'],
    ['03-patterns/06-code-generation.md', 'references/patterns/06-code-generation.md'],
  ]);

  it('remaps links between migrated files', () => {
    const result = rewriteMigratedLinks(
      '[Installation](01-installation.md)',
      '01-getting-started/00-index.md',
      'references/guides/index.md',
      linkMap
    );

    expect(result).toBe('[Installation](installation.md)');
  });

  it('preserves anchors when remapping', () => {
    const result = rewriteMigratedLinks(
      '[Setup](02-project-scaffolding.md#setup)',
      '01-getting-started/00-index.md',
      'references/guides/index.md',
      linkMap
    );

    expect(result).toBe('[Setup](project-scaffolding.md#setup)');
  });

  it('resolves links that climb out of the source directory', () => {
    const result = rewriteMigratedLinks(
      '[Codegen](../03-patterns/06-code-generation.md)',
      '06-templates/02-full-api.md',
      'assets/templates/02-full-api.md',
      linkMap
    );

    expect(result).toBe('[Codegen](../../references/patterns/06-code-generation.md)');
  });

  it('drops links to files that are not migrated', () => {
    const result = rewriteMigratedLinks(
      'see [cheatsheet](../05-reference/00-imports-cheatsheet.md)',
      '01-getting-started/01-installation.md',
      'references/guides/installation.md',
      linkMap
    );

    expect(result).toBe('see cheatsheet');
  });

  it('leaves non-markdown links untouched', () => {
    const result = rewriteMigratedLinks('[site](https://example.com)', 'a/b.md', 'c/d.md', linkMap);

    expect(result).toBe('[site](https://example.com)');
  });
});
