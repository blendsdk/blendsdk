#!/usr/bin/env node
/**
 * The `blendsdk` package bin dispatcher.
 *
 * Routes the `skill` subcommand to the skill installer, `api` to the client
 * generation CLI, and every other invocation to the existing codegen migration
 * CLI, so adding new commands does not change the behavior of the published
 * `blendsdk` migrate command.
 *
 * @module skill/bin
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Chooses the handler for a command line.
 *
 * @param argv - Arguments after the executable
 * @returns `'skill'` for the installer, `'api'` for the API CLI, `'codegen'` otherwise
 */
export function route(argv) {
  if (argv[0] === 'skill') {
    return 'skill';
  }
  if (argv[0] === 'api') {
    return 'api';
  }
  return 'codegen';
}

/**
 * Runs the chosen handler.
 *
 * The codegen CLI self-executes on import using `process.argv`, so forwarding
 * simply imports it. The API CLI exposes `main` and receives the arguments and
 * an output boundary.
 */
async function run() {
  const args = process.argv.slice(2);

  const target = route(args);
  if (target === 'skill') {
    const { main } = await import('../skill/install-skill.mjs');
    process.exitCode = await main(args.slice(1));
    return;
  }

  if (target === 'api') {
    const { main } = await import('../codegen/api/cli.js');
    process.exitCode = await main(args, {
      stdout: message => console.log(message),
      stderr: message => console.error(message),
    });
    return;
  }

  await import('../codegen/cli.js');
}

/**
 * True when this module is the process entry point.
 *
 * The comparison resolves symlinks because npm installs the bin as a symlink
 * in `node_modules/.bin`, so `process.argv[1]` is the link path, not this
 * module's real path.
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
  await run();
}
