# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json for cmdline to reflect dependency updates and version bump.  
Changed: Refactored cmdline.ts to improve command parsing and error handling.  
Changed: Enhanced help-renderer.ts to support new command-line options.  
Changed: Modified types.ts to include additional type definitions for improved type safety.  
Changed: Updated invocation.impl.test.ts with new test cases for better coverage.


## [5.50.0] - 2026-07-31

Added:
- Implement single-package distribution with subpath exports.
- Add showHelp function to command options for programmatic help display.
- Implement custom validator execution for option values and automatic choices validation.

Changed:
- Upgrade monorepo to TypeScript 7 and refresh external dependencies.
- Regenerate MCP package documentation across all workspaces.
- Update command regex pattern to allow hyphens in command names.

Fixed:
- Harden registration and legacy selection to prevent configuration mutation.
- Fixed TypeScript error in cmdline tests by updating mockImplementation calls.
- Support for hyphenated command names.

Deprecated:
- None

Removed:
- None

Security:
- None


## [5.49.0] - 2026-07-31

Added: Implement custom validator execution for option values and choices validation.  
Added: Inject showHelp function into command options for programmatic help display.  
Added: Document strict failure handling with details on strict mode and error hooks.  
Changed: Harden registration and legacy selection to prevent invalid tokens from affecting later handlers.  
Changed: Align package training contract and add deterministic content checks.  
Changed: Activate aliases and global options in strict and legacy parsing modes.  
Changed: Enforce coverage thresholds for parser modules in tests.  
Removed: Unused property in cmdline implementation.  
Fixed: Address TypeScript errors in tests by adding missing function arguments.  
Fixed: Support hyphenated command names in command parsing.  
Fixed: Add typed aggregate failures and custom error presentation in diagnostics.  
Fixed: Ensure that strict parsing rejects unknown commands and malformed values before handlers run.  
Fixed: Updated command regex to allow hyphens in command names.


## [5.48.0] - 2026-06-14

Added:
- Implement custom validator and choices validation in command options.
- Inject showHelp function into command options for programmatic help display.
- Added new documentation for ai-training with structured guides and examples.

Changed:
- Consolidate all @blendsdk/* packages into a single `blendsdk` npm package with subpath exports.
- Updated command regex pattern to allow hyphens in command names for better command support.

Fixed:
- Addressed TypeScript issue by adding missing function argument to mockImplementation() calls in cmdline tests.
- Corrected context handling in cmdline implementation to ensure proper command execution.


## [5.47.0] - 2026-05-22

### Added
- Implement custom validator and choices validation for option values.
- Introduce `showHelp` function in command options to enhance user guidance.
- Add multiple AI training documentation files for enhanced usage guidance.
- Include new examples for cmdline usage, showcasing basic to advanced scenarios.

### Changed
- Consolidate all 12 `@blendsdk/*` packages into a single 'blendsdk' npm package while maintaining monorepo workflow.
- Update command regex pattern to allow hyphenated command names, enhancing flexibility.

### Fixed
- Correct TypeScript errors in cmdline tests by adding missing function arguments to `mockImplementation()`.
- Modify command regex to support hyphenated command names, aligning with other validation patterns.
- Address various context issues in the commandline implementation.

### Security
- Not applicable.


## [5.46.0] - 2026-05-21

Added:
- Implement custom validator and choices validation for option values.
- Add ai-training documentation with structured guides and examples.
- Inject showHelp function into command options for programmatic help display.
- Add examples for email and domain validation scenarios.

Changed:
- Consolidate all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Standardize indentation and formatting across command types.

Fixed:
- Update command regex pattern to allow hyphens in command names.
- Fixed TypeScript error in cmdline tests due to missing function argument in mockImplementation().
- Removed unused properties and corrected context handling in cmdline implementation.


## [5.45.0] - 2026-05-21

### Added
- Implement custom validator and choices validation for option values.
- Added showHelp function to command options and improved code formatting.
- Created ai-training documentation with multiple structured guides.
- Added examples for basic usage, advanced options, error handling, and TypeScript integration.
- Added email and domain types for validation.

### Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated command regex pattern to allow hyphens in command names.

### Fixed
- Addressed TypeScript error in cmdline tests by adding missing function arguments to mockImplementation() calls.
- Supported hyphenated command names by updating command validation regex.
- Removed unused properties and fixed dependency version alignment across packages.

### Security
- Implemented public mirror infrastructure, ensuring package configuration is secure for public access.


## [5.44.1] - 2026-05-20

Added:
- Implement custom validator and choices validation for option values.
- Add `showHelp` function to command options for programmatic help display.
- Created structured ai-training documentation with multiple guides.

Changed:
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated command regex pattern to allow hyphens in command names.

Fixed:
- Addressed TypeScript errors by ensuring `mockImplementation()` calls receive all required arguments.
- Support for hyphenated command names in command regex.
- Removed unused properties from cmdline implementation.

Security:
- Updated dependencies for improved security, including alignment of various package versions.


## [5.44.0] - 2026-05-20

### Added
- Implemented showHelp function in command options for programmatic help display.
- Added support for custom validators and automatic choices validation in cmdline options.
- Created ai-training documentation including core concepts, usage scenarios, and API reference.
- Added examples for basic usage, advanced options, error handling, and TypeScript integration in cmdline.

### Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Standardized indentation and formatting across cmdline's types.ts.
- Updated command regex pattern to support hyphenated command names.

### Fixed
- Addressed TypeScript error by fixing mockImplementation() calls in cmdline tests.
- Updated command regex to allow hyphens in command names ensuring consistency with validateCommandConfiguration() pattern.
- Removed unused properties and fixed variable naming in cmdline implementation.

### Security
- Aligned dependencies to ensure security vulnerabilities are addressed across all packages, including vitest and typescript updates.


## [5.43.1] - 2026-05-20

Added:
- Implement custom validator and choices validation for option values.
- Add showHelp function to command options and currentCommand property to track the running command.
- Add ai-training documentation with structured guides and examples.

Changed:
- Consolidate all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Update command regex pattern to allow hyphenated command names.

Fixed:
- Add missing function argument to mockImplementation() calls in cmdline tests, ensuring TypeScript compatibility.
- Reverse context management in command line handling for improved functionality.
- Support hyphenated command names in command validation regex.

Deprecated:
- No entries in this category.

Removed:
- No entries in this category.

Security:
- No entries in this category.


## [5.43.0] - 2026-05-19

Added: Implement custom validator and choices validation in command options.  
Added: Inject showHelp function into command options for programmatic help display.  
Added: CurrentCommand property to track the running command.  
Added: Comprehensive documentation for ai-training with structured content.  
Added: Example scripts for command line usage under examples directory.  
Changed: Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Changed: Updated command regex pattern to support hyphenated command names.  
Fixed: Addressed TypeScript errors in cmdline tests by adding missing function arguments.  
Fixed: Revised command context handling and removed unused properties.  
Fixed: All 82 tests passing after fixes in cmdline.


## [5.42.0] - 2026-05-18

### Added
- Implemented custom validator and choices validation for option values.
- Added `showHelp` function to command options for programmatic help display.
- Created structured documentation for AI training including overview, concepts, and usage examples.

### Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

### Fixed
- Addressed TypeScript error by adding missing function argument to `mockImplementation()` calls in cmdline tests.
- Updated command regex pattern to support hyphenated command names.

### Security
- Improved code quality and security by aligning dependency versions and removing unused ESLint dependencies.


## [5.41.0] - 2026-05-17

Added:
- Implement showHelp function in command options for programmatic help display.
- Add support for custom validators and choices validation in command options.
- Introduced ai-training documentation with structured guides.

Changed:
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated command regex to support hyphenated command names.

Fixed:
- Corrected TypeScript error in cmdline tests by ensuring all mockImplementation() calls have required function arguments.
- Fixed context renaming issues in cmdline implementation.
- Addressed missing function arguments in mock implementation, ensuring all tests pass.

Deprecated:

Removed:

Security:


## [5.40.0] - 2026-05-17

### Added
- Implement single-package distribution to consolidate all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Add `showHelp` function to command options for programmatic help display.
- Implement custom validator execution for option values and choices validation.
- Add structured AI training documentation with comprehensive examples.

### Changed
- Standardized indentation and formatting across `types.ts`.
- Updated command regex pattern to support hyphenated command names.

### Fixed
- Fixed TypeScript error where `mockImplementation()` was called without a required function argument.
- Addressed regex pattern to validate command names including hyphens.
- Corrected missing function argument in cmdline tests.
- Aligned dependency versions and cleaned project files.

### Security
- No security issues addressed in this release.


## [5.39.0] - 2026-05-07

Changed: Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

Added: ShowHelp function injected into command options for programmatic help display.

Added: Custom validator execution for option values.

Added: Automatic choices validation when the choices property is set.

Fixed: TypeScript error in cmdline tests due to missing function argument in mockImplementation() calls.

Fixed: Command regex pattern updated to allow hyphens in command names.


## [5.38.0] - 2026-04-13

- Added ai-training documentation with 11 structured docs covering various topics.
- Added showHelp function to command options for programmatic help display.
- Added support for custom validators and automatic choices validation for option values.
- Fixed TypeScript error by adding missing function argument to mockImplementation() calls in tests.
- Fixed command regex pattern to allow hyphenated command names.
- Fixed issues related to context renaming and removal of unused properties.
- Fixed command implementation to utilize a parser library effectively.
- Improved code formatting and standardized indentation across source files.
- Regenerated documentation with an updated package index and comprehensive examples.


## [5.37.0] - 2026-03-23

Added:
- Implement custom validator and choices validation for command options.
- Add showHelp function to command options for programmatic help display.
- Created ai-training documentation with structured guides and best practices.

Changed:
- Consolidate all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Update command regex pattern to allow hyphens in command names.
- Standardize indentation and formatting across command types.

Fixed:
- Addressed TypeScript errors in cmdline tests by providing missing function arguments in mockImplementation().
- Support for hyphenated command names by updating command regex pattern.
- Removed unused property in cmdline implementation.

Security:
- Updated dependency versions for improved security and code quality aligning @types/node and TypeScript devDependencies.


## [5.36.0] - 2026-03-23

Added:
- Added ai-training documentation with 11 structured documents covering overview, concepts, usage, and API reference.
- Added `showHelp` function to command options for programmatic help display.
- Implemented custom validator and choices validation for option values.
- Added support for hyphenated command names in command regex pattern.

Changed:
- Implemented single-package distribution consolidating all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated command regex pattern to allow hyphens in command names for consistency.
- Updated package versioning and metadata across multiple files.

Fixed:
- Fixed TypeScript errors in cmdline tests by adding missing function arguments to `mockImplementation()` calls.
- Addressed issues with missing function arguments in cmdline tests resulting in 82 tests passing.
- Removed unused property and aligned dependency versions across the package.
- Fixed regex pattern to ensure command names with hyphens are now supported.


## [5.35.0] - 2026-03-20

Added:
- Implemented single-package distribution, consolidating all @blendsdk/* packages into a single 'blendsdk' npm package.
- Added custom validator execution for option values in cmdline.
- Added automatic choices validation when the choices property is set in cmdline.
- Added email and domain types in cmdline.
- Added cmdline examples for various usage scenarios, including basic usage and advanced options.
- Introduced showHelp function for programmatic help display in cmdline options.

Changed:
- Updated root package.json repository URL to github.com/blendsdk/blendsdk for all packages.
- Enhanced cmdLine and added ServiceBus to Redis.
- Standardized indentation and formatting across cmdline's types.ts.

Fixed:
- Addressed TypeScript error in cmdline tests by adding missing function argument in mockImplementation() calls.
- Updated command regex pattern to support hyphenated command names in cmdline.
- Resolved various context-related issues in cmdline implementation.
- Removed unused properties in cmdline to streamline the codebase.
- Fixed TypeScript errors and ensured all tests are passing with improvements.

Removed:
- Removed unused ESLint dependencies across all packages during cleanup.


## [5.32.0] - 2026-02-11

## Added
- Email and domain validation types and validators
- Custom validator execution for option values
- Automatic choices validation when choices property is set
- `showHelp` function injected into command options for programmatic help display
- `currentCommand` property to track the running command
- Comprehensive examples demonstrating basic usage, advanced options, error handling, real-world applications, and TypeScript integration

## Changed
- Moved TypeScript from dependencies to devDependencies
- Moved Prettier from dependencies (cleanup)
- Moved `@types` packages to devDependencies
- Upgraded vitest to ^4.0.18
- Aligned `@types/node` to ^22.0.0
- Aligned TypeScript devDependency to ^5.9.2
- Standardized indentation and formatting across types.ts

## Fixed
- Command regex pattern now allows hyphens in command names (changed from `/^\w+$/` to `/^[a-zA-Z][a-zA-Z0-9_-]*$/`)
- Missing function argument in `mockImplementation()` calls in tests (updated 16 instances to use `mockImplementation(() => {})`)
- Choices validation now runs before custom validators
- Dependency version alignment across packages
- Removed unused ESLint dependencies


## [5.31.0] - 2026-02-11

### Added
- Email and domain validation types with built-in validators
- Custom validator support for option values with automatic choices validation
- `showHelp` function injected into command options for programmatic help display
- Comprehensive examples demonstrating basic usage, advanced options, error handling, real-world applications, and TypeScript integration
- Support for hyphenated command names (pattern: `/^[a-zA-Z][a-zA-Z0-9_-]*$/`)

### Changed
- Moved TypeScript from dependencies to devDependencies
- Upgraded vitest to ^4.0.18
- Aligned @types/node to ^22.0.0
- Aligned TypeScript devDependency to ^5.9.2
- Command regex pattern updated to allow hyphens in command names
- Standardized indentation and formatting across type definitions

### Fixed
- Missing function argument in `mockImplementation()` calls in tests (16 instances updated)
- Choices validation now applies to both provided values and default values
- Package version alignment across monorepo
- Code quality and architecture improvements
- Context handling in command execution
