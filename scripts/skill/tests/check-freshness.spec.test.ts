/**
 * Specification tests for the source-freshness gate.
 *
 * The gate proves the committed skill was built from the current package
 * sources. It fails when a package's source hashes changed since generation
 * and when the manifest is missing a package. The stored SDK version is inert
 * provenance and never invalidates freshness.
 *
 * @module skill/tests/check-freshness.spec
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computePackageHashes } from '../../ai-training/change-detection.js';
import { checkFreshness } from '../check-freshness.js';
import {
  FIXTURE_PACKAGE_NAME,
  createFixtureWorkspace,
  loadManifestFixture,
  writeManifest,
} from './helpers/fixture-workspace.js';

import type { FixtureWorkspace } from './helpers/fixture-workspace.js';

describe('Skill freshness gate', () => {
  let workspace: FixtureWorkspace;

  beforeEach(() => {
    workspace = createFixtureWorkspace();
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('should pass when the manifest matches the current source and version', () => {
    const hashes = computePackageHashes(workspace.packageDir);
    writeManifest(workspace.rootDir, loadManifestFixture('fresh', hashes));

    const report = checkFreshness(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('should fail naming the package when a source file changed after generation', () => {
    const hashes = computePackageHashes(workspace.packageDir);
    writeManifest(workspace.rootDir, loadManifestFixture('fresh', hashes));

    const sourcePath = path.join(workspace.packageDir, 'src', 'greeter.ts');
    fs.appendFileSync(sourcePath, '\n// a later source change\n');

    const report = checkFreshness(workspace.rootDir);
    const combined = report.problems.join('\n');

    expect(report.ok).toBe(false);
    expect(combined).toContain(FIXTURE_PACKAGE_NAME);
    expect(combined.toLowerCase()).toContain('stale');
  });

  it('should pass when only the manifest SDK version differs from the package version', () => {
    const hashes = computePackageHashes(workspace.packageDir);
    writeManifest(workspace.rootDir, loadManifestFixture('version-stale', hashes));

    const report = checkFreshness(workspace.rootDir);

    expect(report.ok).toBe(true);
    expect(report.problems).toEqual([]);
  });

  it('should fail naming the package when the manifest has no entry for it', () => {
    writeManifest(workspace.rootDir, {
      version: '1',
      lastRun: '2026-09-13T00:00:00.000Z',
      packages: {},
    });

    const report = checkFreshness(workspace.rootDir);
    const combined = report.problems.join('\n');

    expect(report.ok).toBe(false);
    expect(combined).toContain(FIXTURE_PACKAGE_NAME);
  });

  it('should fail when the stored source hashes are stale', () => {
    const hashes = computePackageHashes(workspace.packageDir);
    writeManifest(workspace.rootDir, loadManifestFixture('hash-stale', hashes));

    const report = checkFreshness(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain(FIXTURE_PACKAGE_NAME);
  });

  it('should fail naming the manifest path when the manifest is absent', () => {
    const report = checkFreshness(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('.ai-training-manifest.json');
  });

  it('should fail naming the manifest path when the manifest is not valid JSON', () => {
    fs.writeFileSync(
      path.join(workspace.rootDir, '.ai-training-manifest.json'),
      '{ not json',
      'utf-8'
    );

    const report = checkFreshness(workspace.rootDir);
    const combined = report.problems.join('\n');

    expect(report.ok).toBe(false);
    expect(combined).toContain('.ai-training-manifest.json');
    expect(combined).toContain('not valid JSON');
  });

  it('should fail when no documentable packages are discovered', () => {
    const hashes = computePackageHashes(workspace.packageDir);
    writeManifest(workspace.rootDir, loadManifestFixture('fresh', hashes));

    fs.rmSync(workspace.packageDir, { recursive: true, force: true });

    const report = checkFreshness(workspace.rootDir);

    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toContain('no documentable packages');
  });

});
