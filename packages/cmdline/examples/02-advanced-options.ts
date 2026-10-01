#!/usr/bin/env node

/**
 * Advanced Options Examples for @blendsdk/cmdline
 *
 * This example demonstrates advanced option features:
 * - Required options
 * - Multiple values
 * - Choices/enums
 * - Default values
 * - Custom validation
 * - Option dependencies and conflicts
 *
 * To run this example:
 * npx ts-node examples/02-advanced-options.ts deploy --env=production --files=app.js --files=config.json
 * npx ts-node examples/02-advanced-options.ts config --set-value=debug --set-value=verbose
 * npx ts-node examples/02-advanced-options.ts validate --email=user@example.com --age=25
 */

import { CommandLineParser } from '../src/index';

const parser = new CommandLineParser({
  name: 'advanced-cli',
  version: '2.0.0',
});

// Example 1: Deploy command with choices and multiple values
parser.addCommand({
  name: 'deploy',
  description: 'Deploy application to different environments',
  options: [
    {
      name: 'env',
      short: 'e',
      type: 'string',
      description: 'Target environment',
      required: true,
      choices: ['development', 'staging', 'production'],
    },
    {
      name: 'files',
      short: 'f',
      type: 'string',
      description: 'Files to deploy (can be specified multiple times)',
      multiple: true,
      required: true,
    },
    {
      name: 'dry-run',
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
    },
    {
      name: 'timeout',
      short: 't',
      type: 'number',
      description: 'Deployment timeout in seconds',
      default: 300,
      validator: value => {
        const num = typeof value === 'number' ? value : parseInt(value.toString());
        return num > 0 || 'Timeout must be a positive number';
      },
    },
    {
      name: 'force',
      type: 'boolean',
      description: 'Force deployment even if checks fail',
      conflicts: ['dry-run'],
    },
  ],
  examples: [
    'deploy --env=staging --files=app.js --files=config.json',
    'deploy -e production -f dist/bundle.js --timeout=600',
    'deploy --env=development --files=*.js --dry-run',
  ],
  handler: async options => {
    console.log(`🚀 Deploying to ${options.env}...`);

    if (options['dry-run']) {
      console.log('🔍 DRY RUN MODE - No actual deployment will occur');
    }

    if (options.force) {
      console.log('⚠️  FORCE MODE - Skipping safety checks');
    }

    const files = Array.isArray(options.files) ? options.files : [options.files];
    console.log('📁 Files to deploy:');
    files.forEach((file, index) => {
      console.log(`   ${index + 1}. ${file}`);
    });

    const timeout = typeof options.timeout === 'number' ? options.timeout : 300;
    console.log(`⏱️  Timeout: ${timeout} seconds`);

    if (!options['dry-run']) {
      console.log('✅ Deployment completed successfully!');
    } else {
      console.log('✅ Dry run completed - deployment would succeed');
    }
  },
});

// Example 2: Configuration command with multiple values and validation
parser.addCommand({
  name: 'config',
  description: 'Manage application configuration',
  options: [
    {
      name: 'set-value',
      short: 's',
      type: 'string',
      description: 'Set configuration values (key=value format)',
      multiple: true,
    },
    {
      name: 'get-value',
      short: 'g',
      type: 'string',
      description: 'Get configuration values',
      multiple: true,
      conflicts: ['set-value'],
    },
    {
      name: 'config-file',
      short: 'c',
      type: 'string',
      description: 'Configuration file path',
      default: './config.json',
    },
    {
      name: 'format',
      short: 'f',
      type: 'string',
      description: 'Output format',
      choices: ['json', 'yaml', 'env'],
      default: 'json',
    },
  ],
  handler: async options => {
    console.log('⚙️  Configuration Management');
    console.log(`📄 Config file: ${options['config-file']}`);
    console.log(`📋 Format: ${options.format}`);

    if (options['set-value']) {
      const values = Array.isArray(options['set-value'])
        ? options['set-value']
        : [options['set-value']];
      console.log('\n🔧 Setting values:');
      values.forEach(value => {
        const [key, val] = value.toString().split('=');
        console.log(`   ${key} = ${val || '(empty)'}`);
      });
    }

    if (options['get-value']) {
      const values = Array.isArray(options['get-value'])
        ? options['get-value']
        : [options['get-value']];
      console.log('\n🔍 Getting values:');
      values.forEach(key => {
        console.log(`   ${key} = (simulated value for ${key})`);
      });
    }

    if (!options['set-value'] && !options['get-value']) {
      console.log('\n📊 Current configuration:');
      console.log('   debug = true');
      console.log('   port = 3000');
      console.log('   env = development');
    }
  },
});

// Execute the parser
if (require.main === module) {
  parser.execute().catch(error => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
}

export { parser };
