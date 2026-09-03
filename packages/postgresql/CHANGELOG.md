# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json for @blendsdk/postgresql to reflect new dependencies and configurations.


## [5.50.0] - 2026-07-31

### Added
- Implement comprehensive ai-training documentation with examples and best practices.
- Introduce optional `trustViewNullability` flag for controlling view column nullability behavior.

### Changed
- Upgrade monorepo dependencies and align TypeScript version across all packages.
- Migrate codebase to ESM with NodeNext module resolution for improved compatibility.

### Fixed
- Fix memory leak in PostgreSQL execution context and improve connection pooling management.
- Resolve broken tests in all PostgreSQL test suites and ensure functionality for delete/update statements.

### Removed
- Temporarily remove fluentui package due to incompatibility with React 18.


## [5.49.0] - 2026-07-31

### Added
- Implemented initial ai-training documentation including various topics and examples.
- Added `trustViewNullability` option for cleaner view types in PostgreSQL.

### Changed
- Refactored the expression builder to enhance usage across packages.
- Updated all package.json files to align versioning and dependencies.
- Enhanced database abstraction layer with PostgreSQL support.

### Fixed
- Fixed critical bugs in the disconnect() method to prevent race conditions.
- Addressed various test failures and improved type assertion in tests.
- Resolved issues with package logging interfaces for enhanced visibility.
- Fixed updated test configurations and exeuctables for compatibility.

### Security
- Upgraded dependencies for improved security across all components.


## [5.48.0] - 2026-06-14

### Added
- Implemented comprehensive ai-training documentation including usage examples and best practices.

### Changed
- Consolidated ai-training files for PostgreSQL to improve organization and accessibility.
- Migrated configuration to use ESM format for all packages.

### Fixed
- Fixed critical bugs in disconnect() method in the PostgreSQL database to prevent race conditions.
- Resolved memory leak issues in the PostgreSQL execution context and tests.

### Security
- Upgraded dependencies to resolve known vulnerabilities and improve overall security.


## [5.47.0] - 2026-05-22

Changed: Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports, streamlining the distribution mechanism.

Added: Introduced ai-training documentation covering various topics such as core concepts, best practices, and API references.

Fixed: Resolved issues in connection pool management including race conditions and improved handling of client array access.

Fixed: Implemented additional tests for PostgreSQL statement builders including delete and update operations.

Fixed: Addressed memory leaks in PostgreSQL execution context tests and cleaned up various unused files and dependencies.

Fixed: Updated package dependencies and removed deprecated code across multiple packages, enhancing stability and performance.


## [5.46.0] - 2026-05-21

- Added ai-training documentation with comprehensive guides and examples for PostgreSQL.
- Changed connection pool management to include timeout protection and graceful shutdown features.
- Changed all packages to use ESM module resolution and updated TypeScript configurations for better module support.
- Fixed memory leak issues in PostgreSQL execution context and improved overall performance.
- Fixed incorrect handling in QueryDataService, addressing race conditions and logging issues.
- Fixed various tests in the PostgreSQL package for better stability and reliability.
- Fixed outdated dependency versions and resolved issues related to unused packages.


## [5.45.0] - 2026-05-21

Added:
- Implemented Redis connection readiness with configurable timeout.
- Added trustViewNullability option for cleaner view types.
- Created ai-training documentation with comprehensive guides for PostgreSQL integration.

Changed:
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Refactored expression builder to improve usability and add re-exports.
- Updated JSDoc documentation to follow best practices throughout the codebase.

Fixed:
- Fixed critical bugs in disconnect() method to prevent race conditions.
- Addressed performance issues by fixing memory leaks in PostgreSQL execution context.
- Updated test cases for DELETE and UPDATE statements with expression-based filtering capabilities.

Removed:
- Removed fluentui package due to incompatibility with React 18.


## [5.44.1] - 2026-05-20

Added:
- Implemented ai-training documentation for PostgreSQL with various usage scenarios and best practices.
- Introduced trustViewNullability option for cleaner view types in PostgreSQL.

Changed:
- Consolidated all @blendsdk packages into a single 'blendsdk' npm package with subpath exports.
- Enhanced connection pool management with timeout protection and graceful shutdown for PostgreSQL.
- Refactored PostgreSQL database service builders for better implementation.

Fixed:
- Corrected memory leak in PostgreSQL execution context.
- Addressed race condition issues in the disconnect() method of PostgreSQL.
- Added query parameters for non-GET requests in clientkit.

Security:
- Upgraded vulnerable packages across the PostgreSQL package and its dependencies.


## [5.44.0] - 2026-05-20

## Added
- Implemented ai-training documentation with structured content for PostgreSQL.
- Added trustViewNullability option for cleaner view types.
- Added listByExpression for non-GET requests in clientkit.
- Added initial fluentui package.

## Changed
- Refactored the expression builder and adjusted related services.
- Updated PostgreSQL connection management and added new endpoint handlers.
- Changed handling of connection pool management with enhanced timeout protection.

## Removed
- Removed fluentui package due to compatibility issues with React 18.
- Removed deprecated code and unused packages.

## Fixed
- Fixed PG memory leak and updated transaction tests.
- Fixed critical bugs in disconnect() method and improved error handling.
- Addressed report issues with typescript assertions and improved type safety.

## Security
- Updated vulnerable package dependencies across several packages.


## [5.43.1] - 2026-05-20

## Changed
- Updated documentation in multiple files within the ai-training directory for better clarity and structure.

## Fixed
- Resolved critical bugs in the disconnect() method to prevent race conditions and ensure proper client array access.
- Addressed memory leaks in PostgreSQLExecutionContext tests.
- Refactored expression-related functions to improve compatibility and performance across multiple packages.

## Added
- Introduced comprehensive ai-training documentation covering various topics such as core concepts, usage patterns, and best practices.
- Implemented an optional trustViewNullability flag to control database view column nullability reporting.

## Deprecated
- Deprecated the old expression() API in favor of a unified query() API across the postgresql package.

## Removed
- Removed outdated files related to previous versions that are no longer needed for functionality.

## Security
- Upgraded packages to mitigate potential vulnerabilities by aligning with the latest version standards.


## [5.43.0] - 2026-05-19

### Added
- Implement Redis connection readiness with configurable timeout in the Cache Plugin.
- Create ai-training documentation with 11 structured docs for PostgreSQL.

### Changed
- Implement single-package distribution, consolidating all @blendsdk/* packages into a single 'blendsdk' npm package.

### Fixed
- Critical bugs in disconnect() method to prevent race conditions and correct client array access.
- Phase 4-6 fixes for dependency version alignment, code quality, and architecture.
- Address various report issues, including dependency and file cleanup.
- Type fixing across multiple packages.
- Logs updated in PostgreSQL package for debugging.

### Security
- Added sessions and database service builders to enhance security and efficiency in interactions.


## [5.42.0] - 2026-05-18

Changed: Consolidated all PostgreSQL-related files into a structured ai-training documentation folder.  
Added: New ai-training documentation covering core concepts, basic usage, advanced patterns, and best practices for PostgreSQL.  
Fixed: Resolved memory leak issues in PostgreSQL execution context tests.  
Fixed: Addressed critical bugs in the disconnect() method to prevent race conditions.  
Fixed: Corrected type definitions and upgraded package dependencies.  
Fixed: Removed deprecated code and updated package versions for PostgreSQL support.  
Fixed: Enhanced logging and error handling in PostgreSQL database connections.  
Fixed: Improved Redis connection readiness checking in the Cache Plugin for PostgreSQL.  
Fixed: Moved utility functions and refactored SQL functions for better organization.  
Fixed: Added list by expression functionality to PostgreSQL data services.


## [5.41.0] - 2026-05-17

- Added comprehensive AI training documentation for PostgreSQL, covering usage, troubleshooting, and examples.
- Added `trustViewNullability` option for cleaner view types in the PostgreSQL introspector.
- Added Redis connection readiness with configurable timeout in the Cache Plugin.
- Implemented single-package distribution, consolidating all @blendsdk/* packages into a single 'blendsdk' npm package.
- Fixed critical bugs in `disconnect()` method in the PostgreSQL database.
- Fixed issues with PostgreSQL transactions to prevent memory leaks.
- Fixed the logger interface across PostgreSQL and related packages.
- Refactored expression to use the new expression builder in PostgreSQL package.
- Removed unused packages from PostgreSQL and updated dependencies.
- Updated and moved various tests for better organization in PostgreSQL package.


## [5.40.0] - 2026-05-17

### Added
- Implemented ai-training documentation with structured guides for PostgreSQL.
- Added support for trustViewNullability option to control database views nullability.
- Added ability to filter DELETE and UPDATE statements by expression.

### Changed
- Refactored the distribution mechanism to consolidate all @blendsdk/* packages into a single 'blendsdk' NPM package with subpath exports.
- Upgraded dependency versions across packages for improved alignment and compatibility.

### Fixed
- Addressed race conditions and improved connection management in PostgreSQL's disconnect() method.
- Resolved memory leak issues in PostgreSQL execution context tests.

### Security
- Restricted access to internal packages and deprecated file paths to enhance security.


## [5.39.0] - 2026-05-07

Added:
- Implemented AI training documentation with comprehensive guides for concepts and usage.
- Added `trustViewNullability` flag for cleaner view types in PostgreSQL.
- Introduced connection pool management with timeout protection and graceful shutdown.
- Implemented Redis connection readiness with configurable timeout.
- Added `filterByExpression` for DELETE and UPDATE statements.

Changed:
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Refactored code for clearer separation between PostgreSQL and Datakit implementations.

Fixed:
- Resolved critical bugs in `disconnect()` method to prevent race conditions.
- Addressed memory leak issues in PostgreSQL execution context and associated tests.
- Fixed logger interface across multiple packages for consistency.
- Updated packages and removed deprecated code.
- Improved type definitions and fixed various typing issues.

Removed:
- Removed unused integrations and deprecated files from the PostgreSQL package.


## [5.38.0] - 2026-04-13

- Added comprehensive ai-training documentation with structured content for PostgreSQL support.
- Added trustViewNullability option for cleaner view types in PostgreSQL integration.
- Implemented filterByExpression for DELETE and UPDATE statements in PostgreSQL.
- Added initial fluentui package for enhanced UI components.
- Refactored the expression builder to improve stability and clarity in PostgreSQL.
- Fixed the logger interface, enhancing the data source compatibility with PostgreSQL.
- Fixed memory leak issues in PostgreSQL execution context.
- Fixed connection pool management, ensuring better timeout protection and graceful shutdown.
- Updated package versions across various dependencies including PostgreSQL.
- Removed unused or deprecated packages from PostgreSQL to streamline the codebase.
- Improved overall code quality and consistency across PostgreSQL related modules.


## [5.37.0] - 2026-03-23

## Added
- Implemented ai-training documentation with comprehensive guides and examples.

## Changed
- Updated connection management with timeout protection and graceful shutdown processes.
- Migrated all packages to ESM with NodeNext module resolution for better compatibility.

## Fixed
- Addressed critical bugs in disconnect() method: prevented race conditions and corrected client array access.
- Fixed transaction tests for PostgreSQLExecutionContext to resolve memory leaks and ensure accurate state handling.
- Updated missing types, sorting, and formatting across various packages.

## Security
- Updated dependencies including vitest, @types/node, and typescript to latest secure versions.


## [5.36.0] - 2026-03-23

## Added
- Add ai-training documentation including overview, concepts, usage, patterns, and API reference.

## Changed
- Updated monorepo configuration to use single-package distribution mechanism with subpath exports.

## Fixed
- Fix connection pool management for robustness.
- Address race condition and logging issues in PostgreSQL execution context.
- Resolve various data type alignment issues across packages.


## [5.35.0] - 2026-03-20

### Added
- Implemented Redis connection readiness with configurable timeout to ensure reliable plugin initialization.
- Introduced trustViewNullability option for cleaner view types in PostgreSQL.

### Changed
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports for improved distribution.
- Migrated entire monorepo to ESM with NodeNext module resolution to improve compatibility.

### Fixed
- Resolved critical bugs in `disconnect()` method to prevent race conditions and ensure correct client array access.
- Addressed PG memory leak issues and fixed transaction state in PostgreSQL tests.
- Corrected typing issues in various test files and improved expression API usage.
- Added support for expression-based filtering capabilities in DELETE and UPDATE statements.

### Security
- Upgraded dependencies for security improvements and better stability across packages.


## [5.32.0] - 2026-02-11

## Added

- Connection pool management with timeout protection and graceful shutdown
- Backward-compatible connection pool management with configurable timeouts
- Database introspection capabilities for generating TypeScript types and validators
- `trustViewNullability` option for cleaner view type generation in database introspection
- Database service builders (QueryDataService, DataServiceBase)
- Expression-based filtering for DELETE and UPDATE statements via `filterByExpression` method
- Column aliasing support in FromStatement with both simple and computed expressions
- Comprehensive JSDoc documentation following DocumentThis style conventions
- Complete database abstraction layer with PostgreSQL implementation
- Statement base classes with execute methods
- PostgreSQL-specific statement builders for CRUD operations
- Unit tests for statement building and database operations
- Test infrastructure for PostgreSQL with Docker Compose support
- `.npmignore` files to exclude test artifacts from npm publications

## Changed

- Migrated entire package to ESM with NodeNext module resolution and explicit `.js` extensions
- Moved tests from `src/tests/` to `tests/` directory for better organization
- Standardized test locations across packages
- Refactored expression API from `expression()` to `query()` with fluent methods
- Updated all import paths to use `.js` extensions for ESM compatibility
- Improved connection pool disconnect method to prevent race conditions and correct client array access
- Aligned dependency versions (vitest to ^4.0.18, @types/node to ^22.0.0, typescript to ^5.9.2)
- Upgraded pg driver and related packages
- Moved TypeScript and Prettier from dependencies to devDependencies

## Fixed

- Critical bugs in `disconnect()` method preventing race condition and correcting client array access
- Memory leak in PostgreSQL execution context
- Transaction state management issues
- Docker Compose configuration for CI/CD pipeline
- Test configurations and timeouts
- Code quality issues in PostgreSQL package (redundant constructor assignments)
- CI/CD configuration for PostgreSQL tests
- TypeScript type assertions in hooks tests

## Removed

- Redundant constructor assignments in Statement classes
- Old test files from deprecated locations
- Unused ESLint dependencies
- Deprecated code and unused packages


## [5.31.0] - 2026-02-11

### Added

- Connection pool management with timeout protection and graceful shutdown
- Backward-compatible connection pool configuration options
- Database introspection functionality for PostgreSQL
- `trustViewNullability` option for cleaner view types in database introspection
- `filterByExpression` method for DELETE and UPDATE statements
- Comprehensive JSDoc documentation following DocumentThis style
- Unit tests for PostgreSQL statement builders
- Integration tests for column aliasing in database operations
- Comprehensive tests for FromStatement functionality
- Tests for DELETE and UPDATE expression-based filtering
- Connection readiness checking with configurable timeout
- `.npmignore` file to exclude test artifacts from npm publications

### Changed

- Moved tests from `src/tests/` to `tests/` directory
- Updated all import paths in moved test files
- Migrated from CommonJS-style imports to ESM with explicit `.js` extensions
- Updated TypeScript configurations to use NodeNext module resolution
- Refactored expression API usage throughout codebase
- Migrated test files from old expression API to new query API
- Updated Docker Compose configurations for CI/CD pipeline
- Aligned vitest to ^4.0.18 across packages
- Aligned @types/node to ^22.0.0
- Aligned TypeScript devDep to ^5.9.2
- Updated Jose package version
- Upgraded various npm packages

### Fixed

- Critical race condition in `disconnect()` method
- Correct client array access in disconnect method
- Database logger interface
- Memory leak in PostgreSQL execution context
- Transaction state handling
- Docker volume mapping issues in CI/CD
- Test configuration and timeout settings
- CI/CD pipeline database port configuration
- Empty array return on `listByExpression` when no records found

### Removed

- Unused ESLint dependencies
- TypeScript from runtime dependencies (moved to devDependencies)
- Prettier from runtime dependencies
- `@types` packages from runtime dependencies (moved to devDependencies)
- Deprecated code and unused packages
- Old test files and deprecated yesql.js file
