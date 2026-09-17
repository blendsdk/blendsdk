/**
 * Specification tests for the `blendsdk` bin dispatcher.
 *
 * The dispatcher routes `skill …` to the installer and every other invocation
 * to the existing codegen CLI, so adding the installer does not change the
 * behavior of the published `blendsdk` command.
 *
 * @module skill/tests/bin-dispatcher.spec
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { route } from '../bin.mjs';

/** Absolute path to the dispatcher source. */
const BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin.mjs');

describe('blendsdk bin dispatcher', () => {
  it('routes the skill subcommand to the installer', () => {
    expect(route(['skill'])).toBe('skill');
    expect(route(['skill', 'install', '--all'])).toBe('skill');
  });

  it('routes every other invocation to the codegen CLI', () => {
    expect(route([])).toBe('codegen');
    expect(route(['migrate'])).toBe('codegen');
    expect(route(['--help'])).toBe('codegen');
  });

  it('routes the api subcommand to the API client CLI', () => {
    expect(route(['api'])).toBe('api');
    expect(route(['api', 'generate'])).toBe('api');
    expect(route(['api', 'check', '--config', 'blendsdk.api.ts'])).toBe('api');
  });

  it('runs the installer when invoked through a symlink', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-bin-link-'));
    try {
      const link = path.join(dir, 'blendsdk');
      fs.symlinkSync(BIN_PATH, link);

      const output = execFileSync(process.execPath, [link, 'skill', '--help'], {
        encoding: 'utf-8',
      });

      expect(output).toContain('Install and update the BlendSDK Agent Skill');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
