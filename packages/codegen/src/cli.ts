#!/usr/bin/env node

import { main } from './migration/cli.js';

const exitCode = await main(process.argv.slice(2), {
  stdout: message => console.log(message),
  stderr: message => console.error(message),
});
process.exitCode = exitCode;
