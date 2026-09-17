/**
 * Specification tests for the agent-skill format.
 *
 * The Agent Skills standard defines the hard rules for `SKILL.md`: a YAML
 * frontmatter with `name` and `description`, a name that matches its directory,
 * and a bounded body size. These tests keep the committed skill conformant and
 * catch a rename or a bloated `SKILL.md` before an agent fails to load it.
 *
 * @module skill/tests/skill-format.spec
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** Absolute path to the repository root. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Absolute path to the committed skill directory. */
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'blendsdk');

/** Absolute path to the skill entry point. */
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

/** The standard's name rule: lowercase alphanumerics with single hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Maximum `SKILL.md` body length recommended by the standard. */
const MAX_BODY_LINES = 500;

/** Reads the skill file. */
function readSkill(): string {
  return fs.readFileSync(SKILL_FILE, 'utf-8');
}

/**
 * Reads the top-level scalar fields of the YAML frontmatter.
 *
 * The parser is intentionally small: the standard only requires flat scalar
 * fields at the top level, and nested maps (like `metadata`) are ignored here.
 *
 * @param content - Raw `SKILL.md` content
 * @returns Top-level scalar fields
 */
function frontmatterFields(content: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) {
    return {};
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (field) {
      fields[field[1]] = field[2].trim();
    }
  }
  return fields;
}

/**
 * Returns the markdown body after the frontmatter.
 *
 * @param content - Raw `SKILL.md` content
 * @returns Body lines
 */
function bodyLines(content: string): string[] {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/.exec(content);
  return match ? match[1].split('\n') : [];
}

describe('Agent skill format', () => {
  it('should declare a valid name that matches its directory', () => {
    const fields = frontmatterFields(readSkill());

    expect(fields.name).toBe(path.basename(SKILL_DIR));
    expect(fields.name).toMatch(NAME_PATTERN);
    expect(fields.name.length).toBeGreaterThanOrEqual(1);
    expect(fields.name.length).toBeLessThanOrEqual(64);
  });

  it('should declare a description within the length limit', () => {
    const description = frontmatterFields(readSkill()).description ?? '';

    expect(description.length).toBeGreaterThanOrEqual(1);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('should carry the repository license and a bounded compatibility note', () => {
    const fields = frontmatterFields(readSkill());

    expect(fields.license).toBe('MIT');
    if (fields.compatibility) {
      expect(fields.compatibility.length).toBeLessThanOrEqual(500);
    }
  });

  it('should keep the SKILL.md body within the recommended size', () => {
    expect(bodyLines(readSkill()).length).toBeLessThanOrEqual(MAX_BODY_LINES);
  });

  it('should provide a reference index for progressive disclosure', () => {
    expect(fs.existsSync(path.join(SKILL_DIR, 'references', 'index.md'))).toBe(true);
  });
});
