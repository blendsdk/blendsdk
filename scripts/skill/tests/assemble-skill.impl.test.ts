/**
 * Implementation tests for skill assembly.
 *
 * These cover internals the specification tests do not: repeated runs are
 * idempotent, and a missing source fails loudly instead of shipping an
 * empty skill.
 *
 * @module skill/tests/assemble-skill.impl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assembleSkill } from '../../assemble.js';
import { readTree } from './helpers/fixture-workspace.js';

/** Temporary directories created by the tests. */
const tempDirs: string[] = [];

/**
 * Creates a temporary directory and tracks it for cleanup.
 *
 * @returns Absolute path to the directory
 */
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-assemble-impl-'));
  tempDirs.push(dir);
  return dir;
}

describe('Skill assembly internals', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should be idempotent across repeated runs', () => {
    const source = tempDir();
    const destination = path.join(tempDir(), 'blendsdk');
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# Skill\n', 'utf-8');

    assembleSkill(source, destination);
    const first = readTree(destination);
    assembleSkill(source, destination);

    expect(readTree(destination)).toEqual(first);
  });

  it('should fail when the source tree is missing', () => {
    const destination = path.join(tempDir(), 'blendsdk');

    expect(() => assembleSkill(path.join(tempDir(), 'missing'), destination)).toThrow(
      /Skill source not found/
    );
  });
});
