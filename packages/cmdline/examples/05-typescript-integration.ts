#!/usr/bin/env node

/**
 * TypeScript Integration Examples for @blendsdk/cmdline
 *
 * This example demonstrates advanced TypeScript features:
 * - Strong typing with interfaces
 * - Type-safe option handling
 * - Generic command handlers
 * - Type inference
 * - Custom type guards
 *
 * To run this example:
 * npx ts-node examples/05-typescript-integration.ts build --env=production --optimize
 * npx ts-node examples/05-typescript-integration.ts deploy --target=staging --version=1.2.3
 * npx ts-node examples/05-typescript-integration.ts analyze --files=src/app.ts --files=src/utils.ts
 */

import { CommandLineParser, ICommand, ICommandOption } from '../src/index';

// Define strongly typed interfaces for different command options
interface BuildOptions {
  env: 'development' | 'production' | 'test';
  optimize: boolean;
  sourceMaps: boolean;
  outputDir: string;
  watch: boolean;
  verbose: boolean;
}

interface DeployOptions {
  target: 'staging' | 'production';
  version: string;
  dryRun: boolean;
  rollback: boolean;
  timeout: number;
  force: boolean;
}

interface AnalyzeOptions {
  files: string[];
  format: 'json' | 'table' | 'csv';
  includeTests: boolean;
  outputFile?: string;
  threshold: number;
}

// Type-safe command handler type
type TypedCommandHandler<T> = (options: T & { context?: any }) => Promise<void> | void;

// Utility type to create strongly typed command configurations
interface TypedCommand<T> extends Omit<ICommand, 'handler'> {
  handler: TypedCommandHandler<T>;
}

const parser = new CommandLineParser({
  name: 'typed-cli',
  version: '1.0.0',
});

// Example 1: Build command with strong typing
const buildCommand: TypedCommand<BuildOptions> = {
  name: 'build',
  description: 'Build the project with TypeScript type safety',
  options: [
    {
      name: 'env',
      short: 'e',
      type: 'string',
      description: 'Build environment',
      choices: ['development', 'production', 'test'],
      default: 'development',
    },
    {
      name: 'optimize',
      short: 'o',
      type: 'boolean',
      description: 'Enable optimizations',
    },
    {
      name: 'source-maps',
      short: 's',
      type: 'boolean',
      description: 'Generate source maps',
      default: true,
    },
    {
      name: 'output-dir',
      type: 'string',
      description: 'Output directory',
      default: './dist',
    },
    {
      name: 'watch',
      short: 'w',
      type: 'boolean',
      description: 'Watch for changes',
    },
    {
      name: 'verbose',
      short: 'v',
      type: 'boolean',
      description: 'Verbose output',
    },
  ] as ICommandOption[],
  handler: async (options: BuildOptions) => {
    console.log('🔨 TypeScript Build Process');
    console.log('===========================');

    // TypeScript knows the exact types of all options
    console.log(`🌍 Environment: ${options.env}`);
    console.log(`⚡ Optimize: ${options.optimize ? 'Yes' : 'No'}`);
    console.log(`🗺️  Source Maps: ${options.sourceMaps ? 'Yes' : 'No'}`);
    console.log(`📁 Output Directory: ${options.outputDir}`);
    console.log(`👀 Watch Mode: ${options.watch ? 'Yes' : 'No'}`);
    console.log(`📢 Verbose: ${options.verbose ? 'Yes' : 'No'}`);

    // Type-safe environment-specific logic
    if (options.env === 'production') {
      console.log('🚀 Production build optimizations enabled');
      if (!options.optimize) {
        console.warn('⚠️  Consider enabling optimizations for production');
      }
    }

    if (options.env === 'development' && options.watch) {
      console.log('👀 Development watch mode - monitoring for changes...');
    }

    // Simulate build process
    console.log('✅ Build completed successfully!');
  },
};

// Example 2: Deploy command with validation and type safety
const deployCommand: TypedCommand<DeployOptions> = {
  name: 'deploy',
  description: 'Deploy application with type-safe options',
  options: [
    {
      name: 'target',
      short: 't',
      type: 'string',
      description: 'Deployment target',
      choices: ['staging', 'production'],
      required: true,
    },
    {
      name: 'version',
      short: 'v',
      type: 'string',
      description: 'Version to deploy',
      required: true,
      validator: value => {
        const semverRegex = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/;
        return (
          semverRegex.test(value.toString()) ||
          'Version must follow semantic versioning (e.g., 1.2.3)'
        );
      },
    },
    {
      name: 'dry-run',
      type: 'boolean',
      description: 'Perform a dry run without actual deployment',
    },
    {
      name: 'rollback',
      type: 'boolean',
      description: 'Rollback to previous version',
      conflicts: ['version'],
    },
    {
      name: 'timeout',
      type: 'number',
      description: 'Deployment timeout in seconds',
      default: 300,
      validator: value => {
        const num = typeof value === 'number' ? value : parseInt(value.toString());
        return (num > 0 && num <= 3600) || 'Timeout must be between 1 and 3600 seconds';
      },
    },
    {
      name: 'force',
      type: 'boolean',
      description: 'Force deployment even if checks fail',
    },
  ] as ICommandOption[],
  handler: async (options: DeployOptions) => {
    console.log('🚀 TypeScript Deployment Process');
    console.log('================================');

    // Type-safe target handling
    const isProduction = options.target === 'production';
    console.log(`🎯 Target: ${options.target} ${isProduction ? '🔴' : '🟡'}`);

    if (options.rollback) {
      console.log('⏪ Rolling back to previous version...');
    } else {
      console.log(`📦 Version: ${options.version}`);
    }

    console.log(`⏱️  Timeout: ${options.timeout} seconds`);
    console.log(`🔍 Dry Run: ${options.dryRun ? 'Yes' : 'No'}`);
    console.log(`💪 Force: ${options.force ? 'Yes' : 'No'}`);

    // Type-safe production checks
    if (isProduction && !options.force) {
      console.log('🔒 Production deployment - running safety checks...');
      if (options.dryRun) {
        console.log('✅ Dry run completed - deployment would succeed');
        return;
      }
    }

    // Simulate deployment
    console.log('📤 Deploying application...');
    console.log('✅ Deployment completed successfully!');
  },
};

// Example 3: Analyze command with array handling and complex types
const analyzeCommand: TypedCommand<AnalyzeOptions> = {
  name: 'analyze',
  description: 'Analyze code with TypeScript type inference',
  options: [
    {
      name: 'files',
      short: 'f',
      type: 'string',
      description: 'Files to analyze',
      multiple: true,
      required: true,
    },
    {
      name: 'format',
      type: 'string',
      description: 'Output format',
      choices: ['json', 'table', 'csv'],
      default: 'table',
    },
    {
      name: 'include-tests',
      type: 'boolean',
      description: 'Include test files in analysis',
    },
    {
      name: 'output-file',
      short: 'o',
      type: 'string',
      description: 'Save results to file',
    },
    {
      name: 'threshold',
      type: 'number',
      description: 'Complexity threshold',
      default: 10,
      validator: value => {
        const num = typeof value === 'number' ? value : parseInt(value.toString());
        return (num >= 1 && num <= 100) || 'Threshold must be between 1 and 100';
      },
    },
  ] as ICommandOption[],
  handler: async (options: AnalyzeOptions) => {
    console.log('🔍 TypeScript Code Analysis');
    console.log('===========================');

    // TypeScript knows files is an array
    console.log(`📁 Files to analyze (${options.files.length}):`);
    options.files.forEach((file, index) => {
      console.log(`   ${index + 1}. ${file}`);
    });

    console.log(`📊 Format: ${options.format}`);
    console.log(`🧪 Include Tests: ${options.includeTests ? 'Yes' : 'No'}`);
    console.log(`📈 Complexity Threshold: ${options.threshold}`);

    if (options.outputFile) {
      console.log(`💾 Output File: ${options.outputFile}`);
    }

    // Type-safe format handling
    const results = {
      totalFiles: options.files.length,
      averageComplexity: Math.random() * 20,
      issues: Math.floor(Math.random() * 10),
      suggestions: Math.floor(Math.random() * 5),
    };

    switch (options.format) {
      case 'json':
        console.log('\n📋 Results (JSON):');
        console.log(JSON.stringify(results, null, 2));
        break;

      case 'csv':
        console.log('\n📋 Results (CSV):');
        console.log('Metric,Value');
        console.log(`Total Files,${results.totalFiles}`);
        console.log(`Average Complexity,${results.averageComplexity.toFixed(2)}`);
        console.log(`Issues,${results.issues}`);
        console.log(`Suggestions,${results.suggestions}`);
        break;

      case 'table':
      default:
        console.log('\n📋 Analysis Results:');
        console.log(`   📁 Total Files: ${results.totalFiles}`);
        console.log(`   📊 Average Complexity: ${results.averageComplexity.toFixed(2)}`);
        console.log(`   ⚠️  Issues Found: ${results.issues}`);
        console.log(`   💡 Suggestions: ${results.suggestions}`);
        break;
    }

    console.log('\n✅ Analysis completed!');
  },
};

// Custom type guard for runtime type checking
function isValidEnvironment(env: string): env is 'development' | 'production' | 'test' {
  return ['development', 'production', 'test'].includes(env);
}

// Generic utility function for type-safe option extraction
function extractTypedOptions<T>(options: any, defaults: Partial<T>): T {
  return { ...defaults, ...options } as T;
}

// Example 4: Configuration command with complex type handling
interface ConfigOptions {
  action: 'get' | 'set' | 'delete' | 'list';
  key?: string;
  value?: string;
  type?: 'string' | 'number' | 'boolean';
  global: boolean;
}

const configCommand: TypedCommand<ConfigOptions> = {
  name: 'config',
  description: 'Manage configuration with TypeScript type safety',
  options: [
    {
      name: 'action',
      short: 'a',
      type: 'string',
      description: 'Configuration action',
      choices: ['get', 'set', 'delete', 'list'],
      required: true,
    },
    {
      name: 'key',
      short: 'k',
      type: 'string',
      description: 'Configuration key',
    },
    {
      name: 'value',
      short: 'v',
      type: 'string',
      description: 'Configuration value',
    },
    {
      name: 'type',
      short: 't',
      type: 'string',
      description: 'Value type for type-safe storage',
      choices: ['string', 'number', 'boolean'],
      default: 'string',
    },
    {
      name: 'global',
      short: 'g',
      type: 'boolean',
      description: 'Use global configuration',
    },
  ] as ICommandOption[],
  handler: async (options: ConfigOptions) => {
    console.log('⚙️  TypeScript Configuration Manager');
    console.log('===================================');

    // Type-safe action handling
    switch (options.action) {
      case 'get':
        if (!options.key) {
          console.error('❌ Key is required for get action');
          return;
        }
        console.log(`🔍 Getting value for key: ${options.key}`);
        console.log(`📍 Scope: ${options.global ? 'Global' : 'Local'}`);
        break;

      case 'set':
        if (!options.key || !options.value) {
          console.error('❌ Key and value are required for set action');
          return;
        }
        console.log(`🔧 Setting ${options.key} = ${options.value}`);
        console.log(`📊 Type: ${options.type}`);
        console.log(`📍 Scope: ${options.global ? 'Global' : 'Local'}`);

        // Type-safe value conversion
        let typedValue: string | number | boolean = options.value;
        if (options.type === 'number') {
          typedValue = parseFloat(options.value);
          if (isNaN(typedValue)) {
            console.error('❌ Invalid number value');
            return;
          }
        } else if (options.type === 'boolean') {
          typedValue = options.value.toLowerCase() === 'true';
        }

        console.log(`✅ Value set: ${typedValue} (${typeof typedValue})`);
        break;

      case 'delete':
        if (!options.key) {
          console.error('❌ Key is required for delete action');
          return;
        }
        console.log(`🗑️  Deleting key: ${options.key}`);
        console.log(`📍 Scope: ${options.global ? 'Global' : 'Local'}`);
        break;

      case 'list':
        console.log('📋 Configuration List:');
        console.log(`📍 Scope: ${options.global ? 'Global' : 'Local'}`);
        console.log('   debug = true (boolean)');
        console.log('   timeout = 30 (number)');
        console.log('   environment = development (string)');
        break;
    }
  },
};

// Add all typed commands to the parser
parser.addCommand(buildCommand as unknown as ICommand);
parser.addCommand(deployCommand as unknown as ICommand);
parser.addCommand(analyzeCommand as unknown as ICommand);
parser.addCommand(configCommand as unknown as ICommand);

// Example 5: Demonstration of type inference and utilities
parser.addCommand({
  name: 'demo-types',
  description: 'Demonstrate TypeScript type features',
  options: [
    {
      name: 'example',
      short: 'e',
      type: 'string',
      description: 'Type example to demonstrate',
      choices: ['inference', 'guards', 'generics', 'utilities'],
      required: true,
    },
  ],
  handler: async options => {
    console.log('🎭 TypeScript Type Demonstration');
    console.log('===============================');

    switch (options.example) {
      case 'inference':
        console.log('🔍 Type Inference Example:');
        const inferredOptions = extractTypedOptions<BuildOptions>(options, {
          env: 'development',
          optimize: false,
          sourceMaps: true,
          outputDir: './dist',
          watch: false,
          verbose: false,
        });
        console.log('   TypeScript automatically infers option types');
        console.log(`   Environment: ${inferredOptions.env} (inferred as literal type)`);
        break;

      case 'guards':
        console.log('🛡️  Type Guards Example:');
        const testEnv = 'production';
        if (isValidEnvironment(testEnv)) {
          console.log(`   ${testEnv} is a valid environment (type narrowed)`);
        } else {
          console.log(`   ${testEnv} is not a valid environment`);
        }
        break;

      case 'generics':
        console.log('🔧 Generic Functions Example:');
        console.log('   Generic command handlers provide type safety');
        console.log('   TypedCommandHandler<T> ensures option type consistency');
        break;

      case 'utilities':
        console.log('🛠️  Utility Types Example:');
        console.log('   TypedCommand<T> extends ICommand with typed handler');
        console.log('   extractTypedOptions<T> provides type-safe option extraction');
        break;
    }
  },
});

// Execute the parser with enhanced error handling
if (require.main === module) {
  parser.execute().catch(error => {
    console.error('❌ TypeScript CLI Error:', error.message);
    if (error.stack) {
      console.error('📚 Stack trace:', error.stack);
    }
    process.exit(1);
  });
}

export {
  AnalyzeOptions,
  BuildOptions,
  ConfigOptions,
  DeployOptions,
  extractTypedOptions,
  isValidEnvironment,
  parser,
  TypedCommand,
  TypedCommandHandler,
};
