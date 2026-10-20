# @blendsdk/cmdline Examples

This directory contains comprehensive examples demonstrating the capabilities of the `@blendsdk/cmdline` package. Each example focuses on different aspects and use cases of command line parsing.

## 📚 Example Overview

### 1. Basic Usage (`01-basic-usage.ts`)

**What you'll learn:**

- Creating a command line parser
- Adding simple commands with options
- Handling different option types (string, number, boolean)
- Using short and long option names
- Setting default values
- Creating default commands

**Key Features Demonstrated:**

- Simple string options with defaults
- Required vs optional options
- Multiple option types in one command
- Commands without options
- Default command behavior

**Run Examples:**

```bash
npx ts-node examples/01-basic-usage.ts hello --name=World
npx ts-node examples/01-basic-usage.ts greet -n Alice -t 3 -u
npx ts-node examples/01-basic-usage.ts info
npx ts-node examples/01-basic-usage.ts  # Runs default command
```

### 2. Advanced Options (`02-advanced-options.ts`)

**What you'll learn:**

- Required options and validation
- Multiple values for single options
- Choice restrictions (enums)
- Custom validation functions
- Option conflicts and dependencies
- Complex option combinations

**Key Features Demonstrated:**

- `choices` array for restricting values
- `multiple: true` for array values
- `validator` functions for custom validation
- `conflicts` array for mutually exclusive options
- `required: true` for mandatory options
- Complex validation logic

**Run Examples:**

```bash
npx ts-node examples/02-advanced-options.ts deploy --env=production --files=app.js --files=config.json
npx ts-node examples/02-advanced-options.ts config --set-value=debug --set-value=verbose
npx ts-node examples/02-advanced-options.ts deploy --env=staging --dry-run --force  # Shows conflict error
```

### 3. Error Handling (`03-error-handling.ts`)

**What you'll learn:**

- Comprehensive error handling strategies
- Custom error types and categorization
- Validation error handling
- File system error handling
- Graceful error recovery
- Retry mechanisms

**Key Features Demonstrated:**

- `isCommandLineError()` type guard
- Error categories (VALIDATION, PARSING, CONFIGURATION)
- Custom error handlers
- Validation error messages
- File system validation
- Retry logic with exponential backoff
- Error context and debugging information

**Run Examples:**

```bash
npx ts-node examples/03-error-handling.ts validate --email=invalid-email
npx ts-node examples/03-error-handling.ts process --input=nonexistent.txt
npx ts-node examples/03-error-handling.ts demo-errors --error-type=validation
npx ts-node examples/03-error-handling.ts recover --retry-count=2 --fail-fast
```

### 4. Real-World Application (`04-real-world-app.ts`)

**What you'll learn:**

- Building a complete CLI application
- Multiple related commands
- Data validation and relationships
- Realistic business logic
- Report generation
- Configuration management

**Key Features Demonstrated:**

- Project management system
- Task tracking with assignments
- User management with roles
- Cross-entity validation (project exists, user exists)
- Multiple output formats (table, JSON, CSV)
- Date handling and validation
- Complex filtering and reporting

**Run Examples:**

```bash
# Project management
npx ts-node examples/04-real-world-app.ts project-create --name="My Project" --description="A sample project"
npx ts-node examples/04-real-world-app.ts project-list --status=active --format=json

# Task management
npx ts-node examples/04-real-world-app.ts task-add --project=1 --title="Implement feature" --priority=high --due-date=2024-12-31
npx ts-node examples/04-real-world-app.ts task-list --project=1 --status=todo

# User management
npx ts-node examples/04-real-world-app.ts user-add --name="John Doe" --email="john@example.com" --role=developer

# Reporting
npx ts-node examples/04-real-world-app.ts report --type=summary --format=json
npx ts-node examples/04-real-world-app.ts report --type=overdue-tasks
```

### 5. TypeScript Integration (`05-typescript-integration.ts`)

**What you'll learn:**

- Strong typing with TypeScript
- Type-safe option handling
- Generic command handlers
- Interface definitions
- Type inference

**Key Features Demonstrated:**

- Strongly typed option interfaces
- Generic command handlers
- Type inference from option definitions
- Custom type guards
- Interface composition

### 6. Email and Domain Validation (`06-email-domain-validation.ts`)

**What you'll learn:**

- Using the new `email` and `domain` option types
- Built-in validation for email addresses and domain names
- Handling validation errors with detailed messages
- Multiple validation types in one command
- Practical email configuration scenarios

**Key Features Demonstrated:**

- `type: 'email'` for email address validation
- `type: 'domain'` for domain name validation
- Multiple domain values with `multiple: true`
- Comprehensive validation error messages
- Real-world email configuration use case

**Run Examples:**

```bash
# Valid email and domain
npx ts-node examples/06-email-domain-validation.ts setup -s admin@company.com -h smtp.gmail.com -d company.com -d partner.org

# Email validation
npx ts-node examples/06-email-domain-validation.ts validate -e user@example.com -d example.com

# Invalid examples (will show validation errors)
npx ts-node examples/06-email-domain-validation.ts setup -s invalid-email -h smtp.gmail.com
npx ts-node examples/06-email-domain-validation.ts validate -e user@invalid -d .invalid.domain
```

## 🚀 Getting Started

### Prerequisites

- Node.js 14+
- TypeScript 4+
- ts-node for running examples

### Installation

```bash
# Install dependencies
npm install

# Install ts-node globally (if not already installed)
npm install -g ts-node
```

### Running Examples

Each example can be run independently:

```bash
# Basic usage
npx ts-node examples/01-basic-usage.ts --help

# Advanced options
npx ts-node examples/02-advanced-options.ts deploy --help

# Error handling
npx ts-node examples/03-error-handling.ts validate --help

# Real-world app
npx ts-node examples/04-real-world-app.ts --help
```

## 📖 Learning Path

### Beginner

1. Start with **Basic Usage** to understand fundamental concepts
2. Explore **Advanced Options** to learn about validation and constraints
3. Study **Error Handling** to build robust applications

### Intermediate

4. Examine **Real-World Application** for practical implementation patterns
5. Review **TypeScript Integration** for type safety
6. Practice with **Testing Examples** for quality assurance

### Advanced

7. Combine concepts from multiple examples
8. Build your own CLI applications
9. Contribute improvements and additional examples

## 🛠️ Common Patterns

### Option Validation

```typescript
{
    name: "email",
    type: "string",
    required: true,
    validator: (value) => {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(value.toString()) || "Invalid email format";
    }
}
```

### Multiple Values

```typescript
{
    name: "files",
    type: "string",
    multiple: true,
    description: "Files to process (can be specified multiple times)"
}
```

### Choices/Enums

```typescript
{
    name: "environment",
    type: "string",
    choices: ["development", "staging", "production"],
    default: "development"
}
```

### Conflicting Options

```typescript
{
    name: "watch",
    type: "boolean",
    conflicts: ["production-build"]
}
```

### Custom Error Handling

```typescript
parser.execute().catch(error => {
  if (isCommandLineError(error)) {
    console.error(`CLI Error [${error.code}]: ${error.message}`);
    // Handle specific error categories
  } else {
    console.error('Unexpected error:', error);
  }
  process.exit(1);
});
```

## 🔧 Best Practices

### Command Design

- Use clear, descriptive command names
- Group related functionality
- Provide helpful descriptions
- Include usage examples

### Option Design

- Use consistent naming conventions
- Provide both short and long forms
- Set sensible defaults
- Validate input thoroughly

### Error Handling

- Provide clear error messages
- Include helpful suggestions
- Use appropriate exit codes
- Log errors appropriately

### Documentation

- Include comprehensive help text
- Provide usage examples
- Document validation rules
- Explain option relationships

## 🤝 Contributing

Feel free to contribute additional examples or improvements:

1. Create new example files following the naming convention
2. Update this README with example descriptions
3. Include comprehensive comments in your code
4. Add usage examples and expected outputs
5. Test your examples thoroughly

## 📝 Example Template

When creating new examples, use this template:

```typescript
#!/usr/bin/env node

/**
 * [Example Name] for @blendsdk/cmdline
 *
 * This example demonstrates:
 * - Feature 1
 * - Feature 2
 * - Feature 3
 *
 * To run this example:
 * npx ts-node examples/[filename].ts [command] [options]
 */

import { CommandLineParser } from '../src/index';

const parser = new CommandLineParser({
  name: 'example-cli',
  version: '1.0.0',
});

// Add your commands here

// Execute the parser
if (require.main === module) {
  parser.execute().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}

export { parser };
```

## 📚 Additional Resources

- [Main Documentation](../README.md)
- [API Reference](../src/types.ts)
- [Test Suite](../tests/)
- [Package Source](../src/)

Happy coding! 🎉
