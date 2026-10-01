/**
 * Implementation tests for the skill source mapping.
 *
 * These tests cover internals and edge cases: the shape of the reference
 * mapping, package discovery across the repository, missing-source failures,
 * version resolution, and path-escape rejection for both `..` segments and
 * symlinks.
 *
 * @module skill/tests/mapping.impl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverDocumentablePackages } from '../../ai-training/change-detection.js';
import {
  REFERENCE_GROUPS,
  SkillGenerationError,
  assertWithinRoot,
  resolveReferenceGroups,
} from '../mapping.js';
import { createFixtureWorkspace } from './helpers/fixture-workspace.js';

import type { FixtureWorkspace } from './helpers/fixture-workspace.js';

describe('Skill source mapping (implementation)', () => {
  let workspace: FixtureWorkspace;

  beforeEach(() => {
    workspace = createFixtureWorkspace();
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('should map every ai-training source to exactly five unique references', () => {
    const destinations = REFERENCE_GROUPS.map(group => group.destination);

    expect(destinations).toEqual(['overview', 'usage', 'recipes', 'pitfalls', 'api']);
    expect(new Set(destinations).size).toBe(destinations.length);

    for (const group of REFERENCE_GROUPS) {
      expect(group.sources.length).toBeGreaterThan(0);
      expect(group.sources.every(source => source.endsWith('.md'))).toBe(true);
      expect(group.sources).not.toContain('README.md');
    }
  });

  it('should discover the nineteen publishable packages it must cover', () => {
    const packages = discoverDocumentablePackages(process.cwd());

    expect(packages).toHaveLength(19);
    expect(packages).toContain('api-client');
    expect(packages).toContain('authz');
    expect(packages).toContain('expression');
    expect(packages).toContain('webafx');
    expect(packages).toContain('webafx-authz');
    expect(packages).toContain('react');
  });

  it('should resolve five reference groups for the fixture package', () => {
    const groups = resolveReferenceGroups(workspace.packageDir);

    expect(groups).toHaveLength(REFERENCE_GROUPS.length);
    groups.forEach((group, index) => {
      expect(group.sourcePaths).toHaveLength(REFERENCE_GROUPS[index].sources.length);
      for (const sourcePath of group.sourcePaths) {
        expect(fs.existsSync(sourcePath)).toBe(true);
      }
    });
  });

  it('should fail when a package has no ai-training directory', () => {
    const emptyPackageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-skill-empty-'));
    try {
      expect(() => resolveReferenceGroups(emptyPackageDir)).toThrow(SkillGenerationError);
    } finally {
      fs.rmSync(emptyPackageDir, { recursive: true, force: true });
    }
  });

  it('should fail when a mapped source file is missing', () => {
    fs.rmSync(path.join(workspace.packageDir, 'ai-training', '08-api-reference.md'));

    expect(() => resolveReferenceGroups(workspace.packageDir)).toThrow(/08-api-reference\.md/);
  });

  it('should accept a path inside the root and reject a parent-directory escape', () => {
    expect(assertWithinRoot(workspace.packageDir, path.join(workspace.packageDir, 'src'))).toBe(
      path.join(workspace.packageDir, 'src')
    );
    expect(() => assertWithinRoot(workspace.packageDir, '..')).toThrow(SkillGenerationError);
  });

  it('should reject a symlink whose target lies outside the root', () => {
    const linkPath = path.join(workspace.packageDir, 'escaping-link');
    fs.symlinkSync(path.join(workspace.skillDir, 'SKILL.md'), linkPath);

    expect(() => assertWithinRoot(workspace.packageDir, linkPath)).toThrow(SkillGenerationError);
  });
});
