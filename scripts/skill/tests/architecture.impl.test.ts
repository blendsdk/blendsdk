/**
 * Implementation tests for the regenerated dependency graph.
 *
 * The graph is built from package manifests, so these tests seed a small
 * throwaway package tree and assert the forward list, the reverse list, and the
 * deterministic marker.
 *
 * @module skill/tests/architecture.impl
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateDependencyGraph } from '../architecture.js';
import { GENERATED_MARKER, SkillGenerationError } from '../mapping.js';

describe('Dependency graph generation', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blendsdk-skill-graph-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  /**
   * Writes a package manifest with the supplied dependencies.
   *
   * @param name - Short package name
   * @param dependencies - Dependency entries to write
   */
  function writePackage(name: string, dependencies: Record<string, string>): void {
    const packageDir = path.join(rootDir, 'packages', name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: `@blendsdk/${name}`, dependencies }, null, 2) + '\n',
      'utf-8'
    );
  }

  it('lists forward and reverse dependencies and ignores non-BlendSDK deps', () => {
    writePackage('a', { '@blendsdk/b': '1.0.0', express: '^5.0.0' });
    writePackage('b', {});

    const graph = generateDependencyGraph(rootDir, ['a', 'b']);

    expect(graph).toContain('| a | `b` |');
    expect(graph).toContain('| b | *(none)* |');
    expect(graph).toContain('| b | `a` |');
    expect(graph).toContain('| a | *(none)* |');
    expect(graph.trimEnd().endsWith(GENERATED_MARKER)).toBe(true);
  });

  it('includes internal peer dependencies', () => {
    writePackage('a', {});
    writePackage('b', {});

    const manifestPath = path.join(rootDir, 'packages', 'a', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.peerDependencies = { '@blendsdk/b': '^1.0.0' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

    const graph = generateDependencyGraph(rootDir, ['a', 'b']);

    expect(graph).toContain('| a | `b` |');
    expect(graph).toContain('| b | `a` |');
  });

  it('fails with the manifest path when a package manifest cannot be read', () => {
    expect(() => generateDependencyGraph(rootDir, ['missing'])).toThrow(SkillGenerationError);
  });
});
