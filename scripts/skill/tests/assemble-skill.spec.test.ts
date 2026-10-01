/**
 * Specification tests for skill distribution.
 *
 * Assembly copies `.agents/skills/blendsdk/` into the published package so the
 * skill ships inside `blendsdk`. The destination is rebuilt on every run, so
 * removed files cannot linger, and the copy is byte-equal to the source.
 *
 * @module skill/tests/assemble-skill.spec
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assembleSkill } from '../../assemble.js';
import { readTree } from './helpers/fixture-workspace.js';

/** Absolute path to the repository root. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Temporary directories created by the tests. */
const tempDirs: string[] = [];

/**
 * Creates a temporary directory and tracks it for cleanup.
 *
 * @returns Absolute path to the directory
 */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-assemble-'));
  tempDirs.push(dir);
  return dir;
}

describe('Skill distribution', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should copy the skill byte-equal and remove stale files', () => {
    const source = tempDir();
    const destination = tempDir();

    fs.mkdirSync(path.join(source, 'references', 'packages', 'widget'), { recursive: true });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# Skill\n', 'utf-8');
    fs.writeFileSync(
      path.join(source, 'references', 'packages', 'widget', 'usage.md'),
      '# Usage\n',
      'utf-8'
    );

    fs.writeFileSync(path.join(destination, 'stale.md'), 'old\n', 'utf-8');

    assembleSkill(source, path.join(destination, 'blendsdk'));

    const copied = readTree(path.join(destination, 'blendsdk'));
    expect(copied).toEqual(readTree(source));
    expect(fs.existsSync(path.join(destination, 'blendsdk', 'stale.md'))).toBe(false);
  });

  it('should list "skills" in the published file set', () => {
    const packageJson: { files?: string[] } = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'packages', 'blendsdk', 'package.json'), 'utf-8')
    );

    expect(packageJson.files).toContain('skills');
  });

  it('should document both activation commands and discovery paths', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'packages', 'blendsdk', 'README.md'), 'utf-8');

    expect(readme).toContain('node_modules/blendsdk/skills/blendsdk');
    expect(readme).toContain('.agents/skills/blendsdk');
    expect(readme).toContain('.claude/skills/blendsdk');
  });
});
