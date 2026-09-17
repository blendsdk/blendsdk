#!/usr/bin/env node
/**
 * Install and update the BlendSDK Agent Skill into coding agents.
 *
 * The skill ships inside the `blendsdk` package at `skills/blendsdk/`. This
 * installer copies it into the skill directories of the supported clients
 * (OpenCode, Codex, Claude Code, and the shared `.agents/skills` convention),
 * globally or per project, and replaces the namespaced `blendsdk/` directory on
 * update. It never touches any other skill.
 *
 * Usage (via the package bin):
 *   npx -y blendsdk@latest skill install [--all | --target DIR | --project]
 *   npx -y blendsdk@latest skill status
 *   npx -y blendsdk@latest skill uninstall
 *
 * @module skill/install-skill
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

/** The skill directory name installed into every client. */
export const SKILL_DIR_NAME = 'blendsdk';

/** The marker file written inside the installed skill directory. */
export const MARKER_FILE = '.blendsdk-skill.json';

/**
 * Supported clients and the path segments (relative to home or the project
 * root) where each looks for skills.
 */
export const CLIENTS = [
  { id: 'opencode', global: ['.config', 'opencode', 'skills'], project: ['.opencode', 'skills'] },
  { id: 'claude', global: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  { id: 'codex', global: ['.codex', 'skills'], project: ['.codex', 'skills'] },
  { id: 'agents', global: ['.agents', 'skills'], project: ['.agents', 'skills'] },
];

/**
 * Resolves the packaged skill directory.
 *
 * Works in both layouts: shipped (`<package>/dist/skill` -> `<package>/skills`)
 * and repository (`<repo>/scripts/skill` -> `<repo>/.agents/skills`).
 *
 * @param moduleUrl - `import.meta.url` of this module
 * @param override - Optional explicit source directory
 * @returns Absolute path to the skill directory
 */
export function resolveSourceDir(moduleUrl, override) {
  if (override) {
    return path.resolve(override);
  }

  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  const candidates = [
    path.join(moduleDir, '..', '..', 'skills', SKILL_DIR_NAME),
    path.join(moduleDir, '..', '..', '.agents', 'skills', SKILL_DIR_NAME),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) {
      return path.resolve(candidate);
    }
  }

  return path.resolve(candidates[0]);
}

/**
 * Detects which clients are present on the machine.
 *
 * @param options - Detection inputs
 * @param options.home - Home directory
 * @param options.cwd - Project root
 * @param options.exists - Existence predicate (injectable for tests)
 * @returns Detected clients with resolved global and project directories
 */
export function detectClients({ home, cwd, exists }) {
  const detected = [];

  for (const client of CLIENTS) {
    const globalDir = path.join(home, ...client.global);
    const projectDir = path.join(cwd, ...client.project);
    const present =
      exists(globalDir) || exists(path.dirname(globalDir)) || exists(projectDir);

    if (present) {
      detected.push({ id: client.id, globalDir, projectDir });
    }
  }

  return detected;
}

/**
 * Resolves the skills directories to operate on.
 *
 * @param options - Selection options
 * @param options.targets - Explicit target directories
 * @param options.project - Use project directories instead of global ones
 * @param detected - Detected clients
 * @returns Target skills directories
 */
export function resolveTargets(options, detected) {
  if (options.targets && options.targets.length > 0) {
    return options.targets.map((target) => path.resolve(target));
  }

  if (options.project) {
    return detected.map((client) => client.projectDir);
  }

  return detected.map((client) => client.globalDir);
}

/**
 * Reports whether a path exists as any entry type, including a dangling
 * symlink (which `fs.existsSync` reports as absent because it follows links).
 *
 * @param targetPath - Path to test
 * @returns True when an entry exists
 */
function entryExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads the installed marker, if present.
 *
 * @param targetDir - Installed skill directory
 * @returns The parsed marker, or undefined
 */
export function readMarker(targetDir) {
  const markerPath = path.join(targetDir, MARKER_FILE);

  if (!fs.existsSync(markerPath)) {
    return undefined;
  }

  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
  } catch {
    return undefined;
  }
}

/**
 * Writes the version marker into a skill directory.
 *
 * @param dir - Skill directory
 * @param version - Installed package version
 */
function writeMarker(dir, version) {
  const marker = {
    version,
    source: 'blendsdk',
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n', 'utf-8');
}

/**
 * Installs the skill into one skills directory by replacing `blendsdk/`.
 *
 * @param options - Install inputs
 * @param options.sourceDir - Packaged skill directory
 * @param options.targetDir - Skills directory to install into
 * @param options.version - Package version recorded in the marker
 * @param options.link - Create a symlink instead of copying
 * @param options.dryRun - Report only, write nothing
 * @returns A summary of the action
 */
export function installSkill({ sourceDir, targetDir, version, link, dryRun }) {
  const dest = path.join(targetDir, SKILL_DIR_NAME);

  if (dryRun) {
    return { targetDir, dest, dryRun: true, action: link ? 'link' : 'install' };
  }

  if (link) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.symlinkSync(sourceDir, dest, process.platform === 'win32' ? 'junction' : 'dir');
    return { targetDir, dest, linked: true };
  }

  fs.mkdirSync(targetDir, { recursive: true });

  // Clean up leftovers from an interrupted previous run.
  for (const entry of fs.readdirSync(targetDir)) {
    if (entry.startsWith('.blendsdk-skill.tmp-') || entry.startsWith('.blendsdk-skill.bak-')) {
      fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
    }
  }

  const tmp = path.join(targetDir, `.blendsdk-skill.tmp-${process.pid}`);
  const backup = path.join(targetDir, `.blendsdk-skill.bak-${process.pid}`);

  try {
    fs.cpSync(sourceDir, tmp, { recursive: true });
    writeMarker(tmp, version);

    if (entryExists(dest)) {
      fs.renameSync(dest, backup);
    }

    fs.renameSync(tmp, dest);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (fs.existsSync(backup) && !fs.existsSync(dest)) {
      fs.renameSync(backup, dest);
    }
    throw error;
  }

  return { targetDir, dest, installed: true };
}

/**
 * Removes the installed skill from one skills directory.
 *
 * @param options - Uninstall inputs
 * @param options.targetDir - Skills directory
 * @param options.dryRun - Report only, write nothing
 * @returns A summary of the action
 */
export function uninstallSkill({ targetDir, dryRun }) {
  const dest = path.join(targetDir, SKILL_DIR_NAME);
  const existed = entryExists(dest);

  if (!dryRun && existed) {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  return { targetDir, dest, removed: existed, dryRun: Boolean(dryRun) };
}

/** Prints the CLI help and client table. */
function printUsage() {
  console.log(`Install and update the BlendSDK Agent Skill.

Usage:
  blendsdk skill install [options]     Install or update the skill
  blendsdk skill status [options]      Show the installed version
  blendsdk skill uninstall [options]   Remove the installed skill

Options:
  --all                 Install into every detected client
  --target <dir>        Install into a specific skills directory (repeatable)
  --project             Use project-level skill directories
  --link                Symlink to the source instead of copying
  --source <dir>        Override the skill source directory
  --dry-run             Show what would happen without writing
  -h, --help            Show this help

Clients:
  opencode  ~/.config/opencode/skills   .opencode/skills
  claude    ~/.claude/skills            .claude/skills
  codex     ~/.codex/skills             .codex/skills
  agents    ~/.agents/skills            .agents/skills`);
}

/**
 * Parses argv into a subcommand and options.
 *
 * @param argv - Arguments after `skill`
 * @returns Parsed command and options
 */
export function parseArgs(argv) {
  const options = { targets: [], project: false, link: false, dryRun: false };
  let command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'install';
  let error;

  for (let i = command === argv[0] ? 1 : 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') options.all = true;
    else if (arg === '--project') options.project = true;
    else if (arg === '--link') options.link = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--source' || arg === '--target') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        error = `${arg} requires a directory argument`;
        break;
      }
      if (arg === '--source') options.source = value;
      else options.targets.push(value);
      i += 1;
    } else if (arg === '-h' || arg === '--help') command = 'help';
    else {
      error = `unknown argument '${arg}'`;
      break;
    }
  }

  return { command, options, error };
}

/**
 * Prompts the user to choose among the detected clients.
 *
 * @param detected - Detected clients
 * @returns The chosen clients
 */
async function promptSelection(detected) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Detected agent skill directories:');
    detected.forEach((client, index) => {
      console.log(`  ${index + 1}. ${client.id}  ${client.globalDir}`);
    });
    const answer = await rl.question('Install into which? (comma-separated numbers, empty = all): ');
    const trimmed = answer.trim();

    if (trimmed === '') {
      return detected;
    }

    const chosen = trimmed
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10) - 1)
      .filter((index) => index >= 0 && index < detected.length)
      .map((index) => detected[index]);

    return chosen.length > 0 ? chosen : detected;
  } finally {
    rl.close();
  }
}

/**
 * Runs the installer CLI.
 *
 * @param argv - Arguments after `skill`
 * @param io - Injectable environment
 * @param io.home - Home directory
 * @param io.cwd - Project root
 * @param io.isTTY - Whether interactive prompting is allowed
 * @param io.version - Package version
 * @returns Process exit code
 */
export async function main(argv, io = {}) {
  const home = io.home ?? os.homedir();
  const cwd = io.cwd ?? process.cwd();
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY);
  const version = io.version ?? readPackageVersion(import.meta.url);

  const { command, options, error } = parseArgs(argv);

  if (error) {
    console.error(`error: ${error}`);
    return 2;
  }

  if (command === 'help') {
    printUsage();
    return 0;
  }

  const sourceDir = resolveSourceDir(import.meta.url, options.source);
  const detected = detectClients({ home, cwd, exists: fs.existsSync });

  if (detected.length === 0 && options.targets.length === 0) {
    console.error('No known agent skill directories were found. Use --target <dir> to specify one.');
    printUsage();
    return 1;
  }

  let targets;
  if (options.targets.length > 0 || options.project || options.all || !isTTY) {
    targets = resolveTargets(options, detected);
  } else {
    const chosen = await promptSelection(detected);
    targets = chosen.map((client) => client.globalDir);
  }

  if (command === 'status') {
    for (const target of targets) {
      const dest = path.join(target, SKILL_DIR_NAME);
      const marker = readMarker(dest);

      if (marker) {
        console.log(`${target}: installed ${marker.version}`);
      } else if (entryExists(dest)) {
        console.log(`${target}: installed (linked)`);
      } else {
        console.log(`${target}: not installed`);
      }
    }
    return 0;
  }

  if (command === 'uninstall') {
    for (const target of targets) {
      const result = uninstallSkill({ targetDir: target, dryRun: options.dryRun });
      console.log(`${options.dryRun ? 'would remove' : 'removed'} ${result.dest}`);
    }
    return 0;
  }

  for (const target of targets) {
    const result = installSkill({
      sourceDir,
      targetDir: target,
      version,
      link: options.link,
      dryRun: options.dryRun,
    });
    console.log(`${options.dryRun ? 'would install' : 'installed'} ${result.dest}`);
  }

  return 0;
}

/**
 * Reads the installer package's own version.
 *
 * @param moduleUrl - `import.meta.url` of this module
 * @returns The version, or '0.0.0' when it cannot be read
 */
function readPackageVersion(moduleUrl) {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  for (const candidate of [
    path.join(moduleDir, '..', '..', 'package.json'),
    path.join(moduleDir, '..', '..', 'packages', 'blendsdk', 'package.json'),
  ]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf-8')).version ?? '0.0.0';
    } catch {
      // try the next candidate
    }
  }
  return '0.0.0';
}

/**
 * True when this module is the process entry point, resolving symlinks so the
 * guard also works through npm's `.bin` shims.
 *
 * @returns True when this file is the entry point
 */
function isMainModule() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
