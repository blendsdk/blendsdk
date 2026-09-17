# @blendsdk/cmdline Examples Summary

This document provides a quick reference and summary of all the comprehensive examples created for the `@blendsdk/cmdline` package.

## 📁 Example Files Overview

### 1. **01-basic-usage.ts** - Foundation Concepts

**Purpose**: Learn the fundamentals of command line parsing
**Key Features**:

- Creating a parser instance
- Adding simple commands with options
- String, number, and boolean option types
- Short and long option names
- Default values and required options
- Default command behavior

**Quick Test**:

```bash
npx ts-node examples/01-basic-usage.ts hello --name=World
npx ts-node examples/01-basic-usage.ts greet -n Alice -t 3 -u
```

### 2. **02-advanced-options.ts** - Advanced Option Features

**Purpose**: Master complex option configurations and validation
**Key Features**:

- Multiple values (`multiple: true`)
- Choice restrictions (`choices` array)
- Custom validation functions
- Option conflicts and dependencies
- Complex validation logic
- Real-world deployment scenarios

**Quick Test**:

```bash
npx ts-node examples/02-advanced-options.ts deploy --env=production --files=app.js --files=config.json
npx ts-node examples/02-advanced-options.ts config --set-value=debug=true --set-value=port=3000
```

### 3. **03-error-handling.ts** - Robust Error Management

**Purpose**: Implement comprehensive error handling strategies
**Key Features**:

- Custom error types and categorization
- Validation error handling
- File system error handling
- Graceful error recovery with retry logic
- Error context and debugging information
- User-friendly error messages

**Quick Test**:

```bash
npx ts-node examples/03-error-handling.ts validate --email=invalid-email
npx ts-node examples/03-error-handling.ts recover --retry-count=2 --fail-fast
```

### 4. **04-real-world-app.ts** - Complete Application

**Purpose**: Build a full-featured CLI application
**Key Features**:

- Multi-command application structure
- Cross-entity validation (projects, tasks, users)
- Multiple output formats (table, JSON, CSV)
- Date handling and validation
- Complex filtering and reporting
- Realistic business logic

**Quick Test**:

```bash
npx ts-node examples/04-real-world-app.ts project-create --name="Test Project"
npx ts-node examples/04-real-world-app.ts task-add --project=1 --title="Sample Task" --priority=high
npx ts-node examples/04-real-world-app.ts report --type=summary
```

### 5. **05-typescript-integration.ts** - Type Safety

**Purpose**: Leverage TypeScript for type-safe CLI development
**Key Features**:

- Strongly typed option interfaces
- Generic command handlers
- Type inference and type guards
- Custom utility types
- Runtime type checking
- Type-safe option extraction

**Quick Test**:

```bash
npx ts-node examples/05-typescript-integration.ts build --env=production --optimize
npx ts-node examples/05-typescript-integration.ts demo-types --example=inference
```

### 6. **06-email-domain-validation.ts** - Built-in Validation Types

**Purpose**: Use the new email and domain validation option types
**Key Features**:

- Built-in email address validation (`type: 'email'`)
- Built-in domain name validation (`type: 'domain'`)
- Comprehensive validation error messages
- Multiple domain values support
- Real-world email configuration scenarios
- Practical validation patterns

**Quick Test**:

```bash
npx ts-node examples/06-email-domain-validation.ts setup -s admin@company.com -h smtp.gmail.com -d company.com
npx ts-node examples/06-email-domain-validation.ts validate -e user@example.com -d example.com
npx ts-node examples/06-email-domain-validation.ts setup -s invalid-email -h smtp.gmail.com  # Shows validation errors
```

## 🎯 Learning Path Recommendations

### Beginner Path

1. **Start with Basic Usage** (`01-basic-usage.ts`)
   - Understand parser creation and command structure
   - Learn about option types and defaults
   - Practice with simple commands

2. **Explore Advanced Options** (`02-advanced-options.ts`)
   - Master validation and constraints
   - Learn about multiple values and choices
   - Understand option relationships

3. **Study Error Handling** (`03-error-handling.ts`)
   - Implement robust error management
   - Learn about error categories and recovery
   - Practice with validation scenarios

### Intermediate Path

4. **Build Real Applications** (`04-real-world-app.ts`)
   - Apply concepts to realistic scenarios
   - Learn about complex data relationships
   - Practice with multiple output formats

5. **Master TypeScript Integration** (`05-typescript-integration.ts`)
   - Implement type-safe CLI applications
   - Use advanced TypeScript features
   - Create reusable type utilities

### Advanced Path

6. **Combine All Concepts**
   - Build your own CLI applications
   - Implement custom patterns
   - Contribute to the library

## 🔧 Common Patterns Reference

### Basic Command Structure

```typescript
parser.addCommand({
  name: 'command-name',
  description: 'Command description',
  options: [
    {
      name: 'option-name',
      short: 'o',
      type: 'string',
      description: 'Option description',
      required: true,
      default: 'default-value',
    },
  ],
  handler: async options => {
    // Command implementation
  },
});
```

### Built-in Validation Types

```typescript
// Email validation
{
    name: 'email',
    type: 'email',
    description: 'User email address',
    required: true
}

// Domain validation
{
    name: 'domain',
    type: 'domain',
    description: 'Server domain name',
    required: true
}

// Multiple domains
{
    name: 'allowed-domains',
    type: 'domain',
    multiple: true,
    description: 'Allowed domains for recipients'
}
```

### Custom Validation Pattern

```typescript
{
    name: 'custom-field',
    type: 'string',
    validator: (value) => {
        const customRegex = /^[A-Z]{2,4}-\d{3,6}$/;
        return customRegex.test(value.toString()) || 'Invalid format (expected: XX-123)';
    }
}
```

### Multiple Values Pattern

```typescript
{
    name: 'files',
    type: 'string',
    multiple: true,
    description: 'Files to process'
}
```

### Error Handling Pattern

```typescript
import { isCommandLineError, ErrorCategory } from '@blendsdk/cmdline';

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

### TypeScript Integration Pattern

```typescript
interface MyOptions {
  env: 'development' | 'production';
  verbose: boolean;
}

type TypedHandler<T> = (options: T & { context?: any }) => Promise<void>;

const handler: TypedHandler<MyOptions> = async options => {
  // TypeScript knows exact types
  console.log(`Environment: ${options.env}`);
  console.log(`Verbose: ${options.verbose}`);
};
```

## 🧪 Testing Your Examples

### Run Individual Examples

```bash
# Basic usage
npx ts-node examples/01-basic-usage.ts --help

# Advanced options
npx ts-node examples/02-advanced-options.ts deploy --help

# Error handling
npx ts-node examples/03-error-handling.ts validate --help

# Real-world app
npx ts-node examples/04-real-world-app.ts --help

# TypeScript integration
npx ts-node examples/05-typescript-integration.ts --help
```

### Run Package Tests

```bash
cd packages/cmdline
yarn test
```

## 📚 Additional Resources

### Documentation Files

- **README.md** - Main package documentation
- **TUTORIAL.md** - Comprehensive tutorial guide
- **examples/README.md** - Detailed examples documentation

### Source Code

- **src/cmdline.ts** - Main parser implementation
- **src/types.ts** - TypeScript type definitions
- **src/errors.ts** - Error classes and handling
- **tests/** - Comprehensive test suite

### Key Concepts Covered

#### Parser Configuration

- Application name and version
- Custom error handlers
- Help system configuration
- Global options

#### Command Design

- Command naming conventions
- Description and examples
- Default commands
- Command categories

#### Option Types

- String, number, boolean types
- Built-in email and domain validation types
- Multiple values and arrays
- Choice restrictions (enums)
- Custom validation functions

#### Advanced Features

- Option dependencies and conflicts
- Hidden options
- Context passing
- Custom help formatting

#### Error Management

- Built-in error types
- Custom error handling
- Error categorization
- Recovery strategies

#### TypeScript Integration

- Strongly typed interfaces
- Generic command handlers
- Type guards and utilities
- Runtime type checking

## 🎉 Next Steps

1. **Practice with Examples**: Run through each example to understand the concepts
2. **Build Your Own CLI**: Apply the patterns to create your own applications
3. **Explore Advanced Features**: Dive deeper into TypeScript integration and error handling
4. **Contribute**: Consider contributing improvements or additional examples
5. **Share**: Share your CLI applications with the community

## 💡 Tips for Success

### Command Design

- Use clear, descriptive names
- Provide comprehensive help text
- Include usage examples
- Group related commands logically

### Option Design

- Follow consistent naming conventions
- Provide both short and long forms
- Set sensible defaults
- Validate input thoroughly

### Error Handling

- Provide clear, actionable error messages
- Include helpful suggestions
- Use appropriate exit codes
- Log errors appropriately

### Testing

- Write comprehensive tests
- Test error scenarios
- Use integration tests
- Mock external dependencies

### Documentation

- Keep documentation up to date
- Provide real-world examples
- Explain complex concepts clearly
- Include troubleshooting guides

Happy CLI building! 🚀
