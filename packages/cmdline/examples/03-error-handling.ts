#!/usr/bin/env node

import {
  CommandLineErrorHandlerError,
  CommandLineParser,
  CommandLineValidationError,
} from '../src/index.js';

/**
 * Strict mode rejects parser-owned failures instead of letting an invalid invocation continue.
 * A custom error handler replaces built-in invalid-input output and is awaited before rejection.
 */
const parser = new CommandLineParser({
  name: 'release-cli',
  version: '1.0.0',
  strict: true,
  errorHandler: async error => {
    console.error(error.message);
  },
});

parser.addCommand({
  name: 'deploy',
  description: 'Deploy a named release artifact.',
  options: [
    {
      name: 'output',
      short: 'o',
      type: 'string',
      required: true,
      description: 'Artifact name to deploy.',
    },
  ],
  handler: options => {
    console.log(`Deploying ${options.output}`);
  },
});

try {
  // `deploy --help` resolves cleanly without invoking the command handler.
  // Invalid input such as `deploy --outpt=release` remains rejected; a possible
  // "Did you mean [--output]?" message is diagnostic only and never corrects the input.
  await parser.execute();
} catch (error) {
  if (error instanceof CommandLineValidationError) {
    for (const issue of error.issues) {
      console.error(`[${issue.code}] ${issue.message}`);
    }
    // The consuming application owns its exit policy; the library never terminates the process.
    process.exitCode = 1;
  } else if (error instanceof CommandLineErrorHandlerError) {
    console.error('Unable to present the command-line error:', error.handlerError);
    console.error('Original parser error:', error.parserError.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
