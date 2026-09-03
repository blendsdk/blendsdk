/**
 * Assembly Script for blendsdk Single-Package Distribution
 *
 * Copies compiled dist/ output from all sub-packages into packages/blendsdk/dist/
 * and rewrites @blendsdk/* import paths to relative paths so the assembled
 * package works as a standalone npm package with subpath exports.
 *
 * This script is called by the blendsdk package's build command:
 *   "build": "tsx ../../scripts/assemble.ts"
 *
 * It must run AFTER all sub-packages have been built (turbo handles ordering
 * via devDependencies in blendsdk's package.json).
 *
 * @author BlendSDK Team
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Defines a sub-package module to be assembled into the blendsdk distribution.
 */
interface ModuleMapping {
  /** Human-readable module name */
  name: string;
  /** Path to the sub-package's compiled dist/ folder (relative to monorepo root) */
  srcDir: string;
  /** Destination directory name inside packages/blendsdk/dist/ */
  destDir: string;
}

/**
 * Statistics collected during the assembly process for reporting.
 */
interface AssemblyStats {
  /** Number of files copied per module */
  filesCopied: Map<string, number>;
  /** Total number of import rewrites performed */
  totalRewrites: number;
  /** Number of rewrites per module */
  rewritesPerModule: Map<string, number>;
  /** Total files processed */
  totalFiles: number;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Monorepo root directory (assemble.ts is in scripts/, so go up one level) */
const ROOT = path.resolve(import.meta.dirname, '..');

/** Output directory for the assembled package */
const OUTPUT_DIR = path.join(ROOT, 'packages', 'blendsdk', 'dist');

/**
 * Module mapping: defines which sub-package dist/ folders to copy
 * and where they go in the assembled output.
 *
 * Note: i18n-node does NOT get its own copy — the i18n dist folder already
 * contains node.js and node.d.ts. The blendsdk/i18n-node export points
 * to ./dist/i18n/node.js.
 */
const MODULES: ModuleMapping[] = [
  { name: 'stdlib', srcDir: 'packages/stdlib/dist', destDir: 'stdlib' },
  { name: 'cmdline', srcDir: 'packages/cmdline/dist', destDir: 'cmdline' },
  { name: 'expression', srcDir: 'packages/expression/dist', destDir: 'expression' },
  { name: 'blendscript', srcDir: 'packages/blendscript/dist', destDir: 'blendscript' },
  { name: 'dbcore', srcDir: 'packages/dbcore/dist', destDir: 'dbcore' },
  { name: 'postgresql', srcDir: 'packages/postgresql/dist', destDir: 'postgresql' },
  { name: 'webafx', srcDir: 'packages/webafx/dist', destDir: 'webafx' },
  { name: 'webafx-cache', srcDir: 'packages/webafx-cache/dist', destDir: 'webafx-cache' },
  { name: 'webafx-mailer', srcDir: 'packages/webafx-mailer/dist', destDir: 'webafx-mailer' },
  {
    name: 'webafx-mailer-azure',
    srcDir: 'packages/webafx-mailer-azure/dist',
    destDir: 'webafx-mailer-azure',
  },
  { name: 'webafx-auth', srcDir: 'packages/webafx-auth/dist', destDir: 'webafx-auth' },
  { name: 'webafx-pino', srcDir: 'packages/webafx-pino/dist', destDir: 'webafx-pino' },
  { name: 'i18n', srcDir: 'packages/i18n/dist', destDir: 'i18n' },
  { name: 'webafx-i18n', srcDir: 'packages/webafx-i18n/dist', destDir: 'webafx-i18n' },
  { name: 'codegen', srcDir: 'packages/codegen/dist', destDir: 'codegen' },
  { name: 'react', srcDir: 'packages/react/dist', destDir: 'react' },
];

/**
 * File extensions that need import rewriting.
 * .js files contain runtime imports, .d.ts files contain type imports.
 * .js.map and .d.ts.map files are copied but NOT rewritten (they contain
 * local file references, not @blendsdk/ specifiers).
 */
const REWRITABLE_EXTENSIONS = ['.js', '.d.ts'];

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Checks if a file or directory exists.
 * @param p - Path to check
 * @returns True if the path exists
 */
function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copies a directory tree from src to dest.
 * Creates destination directories as needed.
 *
 * @param src - Source directory path
 * @param dest - Destination directory path
 * @returns Number of files copied
 */
function copyDirRecursive(src: string, dest: string): number {
  let fileCount = 0;

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories
      fileCount += copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      fileCount++;
    }
  }

  return fileCount;
}

/**
 * Recursively collects all file paths in a directory that match given extensions.
 *
 * @param dir - Directory to search
 * @param extensions - File extensions to match (e.g., ['.js', '.d.ts'])
 * @returns Array of absolute file paths
 */
function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];

  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push(...findFiles(fullPath, extensions));
    } else {
      // Check if file matches any of the target extensions
      // Special handling: .d.ts must match before .ts to avoid false positives
      const matchesExtension = extensions.some(ext => entry.name.endsWith(ext));
      if (matchesExtension) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

// ============================================================================
// IMPORT REWRITING
// ============================================================================

/**
 * Rewrites @blendsdk/* import specifiers in a file to relative paths.
 *
 * Handles all import/export forms:
 *   - import { X } from '@blendsdk/expression';
 *   - import type { X } from '@blendsdk/expression';
 *   - export { X } from '@blendsdk/i18n/node';
 *   - const mod = await import('@blendsdk/stdlib');
 *
 * The relative path is computed based on the file's location within
 * the assembled dist/ structure. For example, a file at
 * dist/dbcore/from-statement.js importing @blendsdk/expression
 * becomes ../expression/index.js.
 *
 * @param filePath - Absolute path to the file being rewritten
 * @param content - File content
 * @returns Object with rewritten content and number of rewrites performed
 */
function rewriteImports(filePath: string, content: string): { content: string; rewrites: number } {
  let rewrites = 0;

  /**
   * Regex pattern to match @blendsdk/* import specifiers in string literals.
   *
   * Captures:
   *   $1 = opening quote (' or ")
   *   $2 = package name (e.g., "expression", "webafx-cache")
   *   $3 = optional subpath (e.g., "/node" for @blendsdk/i18n/node)
   *   $4 = closing quote
   */
  const importPattern = /(['"])@blendsdk\/([a-z0-9-]+)(\/[a-z0-9-]+)?(['"])/g;

  // Compute the directory of the current file relative to the output dist/ root
  const fileDir = path.dirname(filePath);

  const rewritten = content.replace(importPattern, (_match, q1, pkgName, subpath, q2) => {
    rewrites++;

    // Determine the target file path within the assembled dist/
    let targetFile: string;
    if (subpath) {
      // Secondary entry point: @blendsdk/i18n/node → i18n/node.js
      targetFile = `${pkgName}${subpath}.js`;
    } else {
      // Primary entry point: @blendsdk/expression → expression/index.js
      targetFile = `${pkgName}/index.js`;
    }

    // Compute the absolute path of the target file in the output dir
    const targetAbsolute = path.join(OUTPUT_DIR, targetFile);

    // Compute relative path from the current file's directory to the target
    let relativePath = path.relative(fileDir, targetAbsolute);

    // Normalize path separators to forward slashes (for Windows compat)
    relativePath = relativePath.split(path.sep).join('/');

    // Ensure the path starts with ./ or ../ (required by Node.js ESM resolution)
    if (!relativePath.startsWith('.')) {
      relativePath = `./${relativePath}`;
    }

    return `${q1}${relativePath}${q2}`;
  });

  return { content: rewritten, rewrites };
}

// ============================================================================
// VERIFICATION
// ============================================================================

/**
 * Scans all assembled .js and .d.ts files for remaining @blendsdk/ references
 * inside actual import/export statements (string literals). References in
 * comments and JSDoc are harmless and ignored.
 *
 * @returns Array of file paths with remaining @blendsdk/ import references
 */
function verifyNoRemainingReferences(): string[] {
  const violatingFiles: string[] = [];
  const filesToCheck = findFiles(OUTPUT_DIR, REWRITABLE_EXTENSIONS);

  /**
   * Matches @blendsdk/ inside string literals (single or double quotes).
   * This catches real import/export specifiers while ignoring comments.
   */
  const importRefPattern = /['"]@blendsdk\/[^'"]+['"]/;

  for (const filePath of filesToCheck) {
    const content = fs.readFileSync(filePath, 'utf8');

    // Only flag files with @blendsdk/ inside string literals (actual imports)
    if (importRefPattern.test(content)) {
      violatingFiles.push(path.relative(OUTPUT_DIR, filePath));
    }
  }

  return violatingFiles;
}

/**
 * Verifies that all export paths in the blendsdk package.json resolve
 * to actual files in the assembled dist/ directory.
 *
 * @returns Array of export paths that don't resolve to existing files
 */
function verifyExportPaths(): string[] {
  const pkgJsonPath = path.join(ROOT, 'packages', 'blendsdk', 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const missingPaths: string[] = [];

  const exports = pkgJson.exports || {};
  const pkgDir = path.dirname(pkgJsonPath);

  for (const [exportPath, conditions] of Object.entries(exports)) {
    const conditionMap = conditions as Record<string, string>;

    // Check the 'import' entry point
    if (conditionMap.import) {
      const resolvedPath = path.join(pkgDir, conditionMap.import);
      if (!exists(resolvedPath)) {
        missingPaths.push(`${exportPath} → ${conditionMap.import}`);
      }
    }

    // Check the 'types' entry point
    if (conditionMap.types) {
      const resolvedPath = path.join(pkgDir, conditionMap.types);
      if (!exists(resolvedPath)) {
        missingPaths.push(`${exportPath} → ${conditionMap.types} (types)`);
      }
    }
  }

  return missingPaths;
}

/**
 * Verifies the single published executable and its runtime dependency boundary.
 *
 * The CLI is copied from TypeScript output, whose executable bit is not portable. Assembly sets
 * that bit explicitly before checking the same path npm will package.
 *
 * @returns Human-readable contract failures; an empty list means the binary is publishable.
 */
function verifyBinContract(): string[] {
  const packagePath = path.join(ROOT, 'packages', 'blendsdk', 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const failures: string[] = [];
  const binEntries = Object.entries(packageJson.bin ?? {});

  if (binEntries.length !== 1 || binEntries[0]?.[0] !== 'blendsdk') {
    failures.push('package.json must declare exactly one "blendsdk" executable');
    return failures;
  }

  const target = binEntries[0][1];
  if (target !== './dist/codegen/cli.js') {
    failures.push('the "blendsdk" executable must target ./dist/codegen/cli.js');
    return failures;
  }

  const binPath = path.join(path.dirname(packagePath), target);
  if (!exists(binPath)) {
    failures.push(`the executable target does not exist: ${target}`);
    return failures;
  }

  fs.chmodSync(binPath, fs.statSync(binPath).mode | 0o111);
  if (!fs.readFileSync(binPath, 'utf8').startsWith('#!/usr/bin/env node\n')) {
    failures.push('the executable target must start with the Node.js shebang');
  }
  if ((fs.statSync(binPath).mode & 0o111) === 0) {
    failures.push('the executable target must have an executable mode');
  }
  if (packageJson.dependencies?.jiti !== '^2.7.0') {
    failures.push('jiti must be a regular runtime dependency');
  }
  if (
    typeof packageJson.peerDependencies?.pg !== 'string' ||
    packageJson.peerDependenciesMeta?.pg?.optional !== true
  ) {
    failures.push('pg must remain an optional peer dependency');
  }

  return failures;
}

// ============================================================================
// MAIN ASSEMBLY FUNCTION
// ============================================================================

/**
 * Main assembly entry point.
 *
 * 1. Cleans the output directory
 * 2. Copies each sub-package's dist/ into the assembled output
 * 3. Rewrites @blendsdk/* imports to relative paths
 * 4. Verifies no remaining @blendsdk/ references
 * 5. Verifies package export paths
 * 6. Verifies the published executable contract
 * 7. Reports assembly statistics
 */
function assemble(): void {
  console.log('🔧 Assembling blendsdk package...\n');

  const stats: AssemblyStats = {
    filesCopied: new Map(),
    totalRewrites: 0,
    rewritesPerModule: new Map(),
    totalFiles: 0,
  };

  // Step 1: Clean output directory
  if (exists(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log('✔ Cleaned output directory');

  // Step 2: Copy each sub-package's dist/ into the assembled output
  for (const mod of MODULES) {
    const srcPath = path.join(ROOT, mod.srcDir);
    const destPath = path.join(OUTPUT_DIR, mod.destDir);

    // Validate that the source dist/ exists (means sub-package was built)
    if (!exists(srcPath)) {
      console.error(`❌ Package "${mod.name}" not built. Missing: ${mod.srcDir}`);
      console.error('   Run "yarn build" to build all sub-packages first.');
      process.exit(1);
    }

    const fileCount = copyDirRecursive(srcPath, destPath);
    stats.filesCopied.set(mod.name, fileCount);
    stats.totalFiles += fileCount;
  }

  console.log(`✔ Copied ${MODULES.length} modules (${stats.totalFiles} files)\n`);

  // Step 3: Rewrite @blendsdk/* imports in .js and .d.ts files
  console.log('📝 Rewriting import paths...');

  for (const mod of MODULES) {
    const modDir = path.join(OUTPUT_DIR, mod.destDir);
    const filesToRewrite = findFiles(modDir, REWRITABLE_EXTENSIONS);
    let moduleRewrites = 0;

    for (const filePath of filesToRewrite) {
      const original = fs.readFileSync(filePath, 'utf8');
      const { content: rewritten, rewrites } = rewriteImports(filePath, original);

      if (rewrites > 0) {
        fs.writeFileSync(filePath, rewritten);
        moduleRewrites += rewrites;
      }
    }

    stats.rewritesPerModule.set(mod.name, moduleRewrites);
    stats.totalRewrites += moduleRewrites;
  }

  console.log(`✔ Rewrote ${stats.totalRewrites} import references\n`);

  // Step 4: Verify no remaining @blendsdk/ references
  console.log('🔍 Verifying assembly...');

  const remainingRefs = verifyNoRemainingReferences();
  if (remainingRefs.length > 0) {
    console.error('❌ Found remaining @blendsdk/ references in:');
    for (const file of remainingRefs) {
      console.error(`   - ${file}`);
    }
    process.exit(1);
  }
  console.log('✔ No remaining @blendsdk/ references');

  // Step 5: Verify all export paths resolve to existing files
  const missingExports = verifyExportPaths();
  if (missingExports.length > 0) {
    console.error('❌ Export paths that do not resolve to existing files:');
    for (const missing of missingExports) {
      console.error(`   - ${missing}`);
    }
    process.exit(1);
  }
  console.log('✔ All export paths resolve to existing files');

  // Step 6: Verify the executable after import rewriting and set its packaged mode.
  const binFailures = verifyBinContract();
  if (binFailures.length > 0) {
    console.error('❌ Invalid executable contract:');
    for (const failure of binFailures) console.error(`   - ${failure}`);
    process.exit(1);
  }
  console.log('✔ Executable target, mode, and runtime dependencies are valid');

  // Step 7: Print summary
  console.log('\n' + '─'.repeat(60));
  console.log('📦 Assembly Summary\n');

  for (const mod of MODULES) {
    const files = stats.filesCopied.get(mod.name) || 0;
    const rewrites = stats.rewritesPerModule.get(mod.name) || 0;
    const rewriteInfo = rewrites > 0 ? `, ${rewrites} imports rewritten` : '';
    console.log(`  ✔ ${mod.name}: ${files} files${rewriteInfo}`);
  }

  console.log(`\n  Total: ${stats.totalFiles} files, ${stats.totalRewrites} imports rewritten`);
  console.log('  ✅ Assembly complete — package ready for publishing');
  console.log('─'.repeat(60));
}

// ============================================================================
// EXECUTION
// ============================================================================

assemble();
