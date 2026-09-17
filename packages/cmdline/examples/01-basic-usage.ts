#!/usr/bin/env node

/**
 * Basic Usage Examples for @blendsdk/cmdline
 *
 * This example demonstrates the fundamental concepts of using the CommandLineParser:
 * - Creating a parser
 * - Adding simple commands
 * - Handling basic options
 * - Running commands
 *
 * To run this example:
 * npx ts-node examples/01-basic-usage.ts hello --name=World
 * npx ts-node examples/01-basic-usage.ts greet -n Alice
 * npx ts-node examples/01-basic-usage.ts info
 */

import { CommandLineParser } from '../src/index';

// Create a new command line parser
const parser = new CommandLineParser({
  name: 'basic-cli',
  version: '1.0.0',
});

// Example 1: Simple command with string option
parser.addCommand({
  name: 'hello',
  description: 'Say hello to someone',
  options: [
    {
      name: 'name',
      short: 'n',
      type: 'string',
      description: 'Name of the person to greet',
      default: 'World',
    },
  ],
  handler: async options => {
    console.log(`Hello, ${options.name}!`);
    console.log('This is a basic greeting command.');
  },
});

// Example 2: Command with multiple option types
parser.addCommand({
  name: 'greet',
  description: 'Advanced greeting with multiple options',
  options: [
    {
      name: 'name',
      short: 'n',
      type: 'string',
      description: 'Name of the person to greet',
      required: true,
    },
    {
      name: 'times',
      short: 't',
      type: 'number',
      description: 'Number of times to greet',
      default: 1,
    },
    {
      name: 'uppercase',
      short: 'u',
      type: 'boolean',
      description: 'Use uppercase for the greeting',
    },
  ],
  handler: async options => {
    let greeting = `Hello, ${options.name}!`;

    if (options.uppercase) {
      greeting = greeting.toUpperCase();
    }

    const times = typeof options.times === 'number' ? options.times : 1;
    for (let i = 0; i < times; i++) {
      console.log(`${i + 1}. ${greeting}`);
    }
  },
});

// Example 3: Command without options
parser.addCommand({
  name: 'info',
  description: 'Display information about this CLI',
  handler: async () => {
    console.log('Basic CLI Example');
    console.log('================');
    console.log('This is a demonstration of basic command line parsing.');
    console.log('Available commands: hello, greet, info');
    console.log('Use --help with any command to see its options.');
  },
});

// Example 4: Default command (runs when no command is specified)
parser.addCommand({
  name: 'welcome',
  description: 'Welcome message (default command)',
  default: true,
  handler: async () => {
    console.log('Welcome to the Basic CLI Example!');
    console.log('Try running with --help to see available commands.');
    console.log('Example commands:');
    console.log('  hello --name=John');
    console.log('  greet -n Alice -t 3 -u');
    console.log('  info');
  },
});

// Execute the parser
if (require.main === module) {
  parser.execute().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

export { parser };
