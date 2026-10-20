/**
 * Specification tests for the BlendSDK skill installer.
 *
 * These tests describe the installer's contract, not its implementation: it
 * detects client skill directories, resolves targets, installs the skill by
 * replacing the namespaced `blendsdk/` directory, writes a version marker, and
 * never touches other skills. All filesystem work uses temporary directories.
 *
 * @module skill/tests/install-skill.spec
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectClients,
  installSkill,
  readMarker,
  resolveTargets,
  uninstallSkill,
} from '../install-skill.mjs';

/** Creates a throwaway directory. */
function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Creates a minimal fake skill tree.
 *
 * @param root - Directory under which to create `blendsdk/`
 * @returns Absolute path to the created skill directory
 */
function makeSkill(root: string): string {
  const dir = path.join(root, 'blendsdk');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# blendsdk\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'references', 'index.md'), 'index\n', 'utf-8');
  return dir;
}

describe('detectClients', () => {
  it('detects only clients whose directory exists', () => {
    const home = tempDir('installer-home-');
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });

    const detected = detectClients({ home, cwd: home, exists: fs.existsSync });

    expect(detected.map((c) => c.id)).toEqual(['claude']);
  });
});

describe('resolveTargets', () => {
  const detected = [
    { id: 'opencode', globalDir: '/h/.config/opencode/skills', projectDir: '/p/.opencode/skills' },
    { id: 'claude', globalDir: '/h/.claude/skills', projectDir: '/p/.claude/skills' },
  ];

  it('returns explicit targets when provided', () => {
    expect(resolveTargets({ targets: ['/custom/skills'] }, detected)).toEqual(['/custom/skills']);
  });

  it('returns every detected global directory by default', () => {
    expect(resolveTargets({}, detected)).toEqual([
      '/h/.config/opencode/skills',
      '/h/.claude/skills',
    ]);
  });

  it('returns project directories when requested', () => {
    expect(resolveTargets({ project: true }, detected)).toEqual([
      '/p/.opencode/skills',
      '/p/.claude/skills',
    ]);
  });
});

describe('installSkill', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = tempDir('installer-');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('copies the full skill and writes the marker', () => {
    const source = makeSkill(path.join(workspace, 'source'));
    const target = path.join(workspace, 'skills');

    installSkill({ sourceDir: source, targetDir: target, version: '5.55.0' });

    expect(fs.existsSync(path.join(target, 'blendsdk', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'blendsdk', 'references', 'index.md'))).toBe(true);
    const marker = readMarker(path.join(target, 'blendsdk'));
    expect(marker?.version).toBe('5.55.0');
  });

  it('replaces cleanly on a second install with no leftovers', () => {
    const source = makeSkill(path.join(workspace, 'source'));
    const target = path.join(workspace, 'skills');

    installSkill({ sourceDir: source, targetDir: target, version: '5.55.0' });
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# blendsdk v2\n', 'utf-8');
    installSkill({ sourceDir: source, targetDir: target, version: '5.56.0' });

    expect(fs.readFileSync(path.join(target, 'blendsdk', 'SKILL.md'), 'utf-8')).toContain('v2');
    expect(readMarker(path.join(target, 'blendsdk'))?.version).toBe('5.56.0');
    const leftovers = fs
      .readdirSync(target)
      .filter((name) => name.startsWith('.blendsdk-skill'));
    expect(leftovers).toEqual([]);
  });

  it('never touches other skills in the target directory', () => {
    const source = makeSkill(path.join(workspace, 'source'));
    const target = path.join(workspace, 'skills');
    fs.mkdirSync(path.join(target, 'other-skill'), { recursive: true });
    fs.writeFileSync(path.join(target, 'other-skill', 'SKILL.md'), 'other\n', 'utf-8');

    installSkill({ sourceDir: source, targetDir: target, version: '5.55.0' });

    expect(fs.readFileSync(path.join(target, 'other-skill', 'SKILL.md'), 'utf-8')).toBe('other\n');
  });

  it('writes nothing in dry-run mode', () => {
    const source = makeSkill(path.join(workspace, 'source'));
    const target = path.join(workspace, 'skills');

    const result = installSkill({
      sourceDir: source,
      targetDir: target,
      version: '5.55.0',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('creates a symlink in link mode', () => {
    const source = makeSkill(path.join(workspace, 'source'));
    const target = path.join(workspace, 'skills');

    installSkill({ sourceDir: source, targetDir: target, version: '5.55.0', link: true });

    expect(fs.lstatSync(path.join(target, 'blendsdk')).isSymbolicLink()).toBe(true);
  });

  it('preserves the existing install when the source is missing', () => {
    const source = makeSkill(path.join(workspace, 'source'));
    const target = path.join(workspace, 'skills');
    installSkill({ sourceDir: source, targetDir: target, version: '5.55.0' });

    expect(() =>
      installSkill({
        sourceDir: path.join(workspace, 'missing'),
        targetDir: target,
        version: '5.56.0',
      })
    ).toThrow();
    expect(readMarker(path.join(target, 'blendsdk'))?.version).toBe('5.55.0');
  });
});

describe('uninstallSkill', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = tempDir('installer-');
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('removes only the blendsdk directory', () => {
    const source = makeSkill(path.join(workspace, 'source'));
    const target = path.join(workspace, 'skills');
    fs.mkdirSync(path.join(target, 'other-skill'), { recursive: true });
    installSkill({ sourceDir: source, targetDir: target, version: '5.55.0' });

    uninstallSkill({ targetDir: target });

    expect(fs.existsSync(path.join(target, 'blendsdk'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'other-skill'))).toBe(true);
  });
});
