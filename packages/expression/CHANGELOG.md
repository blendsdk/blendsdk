# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json for improved dependency management.  
_CHANGED:_ Revised documentation in several files for clarity and accuracy.


## [5.50.0] - 2026-07-31

### Changed
- Migrated monorepo to TypeScript 7 and updated compatibility across packages.
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Renamed expression2 package to expression, updating all references throughout the codebase.

### Added
- Implemented single-package distribution for all @blendsdk packages.
- Added production-ready SQL WHERE clause builder with Yesql parameter format to the expression package.
- Introduced Redis connection readiness checking to the Cache Plugin to prevent race conditions.

### Fixed
- Fixed type issues by aligning dependency versions and removing unused ESLint dependencies.
- Addressed missing types and updates to sorting and formatting across multiple packages.
- Corrected SQL List return type in the expression package.

### Deprecated
- Removed fluentui package temporarily due to compatibility issues with React 18.

### Security
- Conducted security audits and updated dependencies to mitigate potential vulnerabilities in several packages.


## [5.49.0] - 2026-07-31

Added:
- Implemented single-package distribution to consolidate all @blendsdk/* packages into a single 'blendsdk' npm package.

Changed:
- Updated API to support SQL dialect system with global configurations.
- Refactored expression API usage and added re-exports.
- Improved expression method exports in sqlkit.


Fixed:
- Addressed issues with SQL LIKE expressions and added case insensitivity.
- Fixed type issues in SQL methods and updated types.
- Enhanced support for wrapping operands with ILIKE.

Removed:
- Removed fluentui package temporarily due to compatibility with React 18.


## [5.48.0] - 2026-06-14

Added: Implemented a production-ready SQL WHERE clause builder with yesql parameter format in the expression package.  
Added: Enhanced configuration, parameter handling, and BETWEEN operator in the expression package.  
Added: TypeScript generics support for type-safe expressions in the expression package.  
Added: Implemented EXISTS and NOT EXISTS operators in the expression package.  
Added: Added support for ANY, ALL, SOME operators in the expression package.  
Changed: Refactored expression to use new ExpressionBuilder structure for better organization and maintainability.  
Changed: Updated expression package resolution to ESM and NodeNext module imports.  
Changed: Renamed the old expression package to expression2, moving it to its own package for clarity.  
Fixed: Addressed report issues related to dependency management and configuration cleanup.  
Fixed: Updated and fixed types for various expressions in the expression package.  
Removed: Deprecated the old expression package, moving all functionalities to the new expression package structure.  
Security: Addressed potential security issues in dependency management and tightened configurations across packages.


## [5.47.0] - 2026-05-22

Changed: Consolidated `@blendsdk/*` packages into a single `blendsdk` npm package with subpath exports.  
Added: Implemented Redis connection readiness with configurable timeout in the Cache Plugin.  
Added: Enhanced support for TypeScript generics in the expression package for type-safe expressions.  
Added: Implemented ANY/ALL/SOME operators for SQL expressions in the expression package.  
Added: Implemented EXISTS and NOT EXISTS operators in the expression package.  
Fixed: Corrected return type for `sql_list` in the expression package.  
Fixed: Addressed issues with case insensitivity in LIKE comparisons in the expression package.  
Removed: Removed `fluentui` package due to compatibility issues with React 18.  
Fixed: Refactored the expression builder for better organization and maintainability.  
Fixed: Exported expression methods for improved accessibility in the expression package.


## [5.46.0] - 2026-05-21

## [Changed]
- Moved expression to its own package to improve modularity and organization.

## [Added]
- Implemented export of expression methods in the new expression package.
- Added case insensitive support for LIKE expressions.
- Enhanced LIKE expression with an additional implementation detail.

## [Fixed]
- Addressed SQL list return type issue.
- Refactored expressionBuilder for improved structure and functionality.
- Added null element filtering to expressions.
- Fixed wrapping operands for ILIKE and renderComparison functions.


## [5.45.0] - 2026-05-21

- Added support for SQL dialects with global configuration options for various databases.
- Added new `LIKE` expression methods to enhance SQL capabilities.
- Added `fluentui` package to the project with initial support for React.
- Changed expression handling to support enhanced configurations and dialect-specific settings.
- Fixed buffer handling to allow filtering null elements.
- Fixed to allow proper functionality for `ILIKE` expressions and ensure correct operand wrapping.
- Fixed various types and added necessary comments across multiple files for clarity.


## [5.44.1] - 2026-05-20

* Added implementation of ANY/ALL/SOME operators for SQL expressions.
* Added support for TypeScript generics in expression.
* Added EXISTS and NOT EXISTS support in expressions.
* Added a LIKE expression and a case-insensitive LIKE implementation.
* Added initial fluentui package.
* Fixed issues with wrapping operands for ILIKE and renderComparison.
* Fixed SQL list return types and ensured to utilize expression in sqlkit.
* Refactored expression to expression builder, improving code structure.
* Refactored to allow overriding and alternative prefix in ExpressionBuilder.
* Added export for expression methods in sqlkit.
* Improved documentations for ai-training in the expression package.
* Updated package versions across all packages for dependency alignment.


## [5.44.0] - 2026-05-20

### Added
- Implemented a complete rewrite of the expression package as a new version with a modern architecture, including immutable AST and comprehensive type safety.
- Moved expression to its own package, facilitating better separation and modularization.

### Changed
- Renamed the compile() function to where() for clarity and updated related types accordingly.
- Migrated the entire monorepo to ESM with NodeNext module resolution for improved compatibility.

### Fixed
- Addressed the issue with null elements in filtering for expression methods.
- Enhanced the Like expression to support case insensitivity.
- Corrected the SQL list return type in the expression package.
- Added comprehensive tests for expression-building logic to ensure correctness.

### Removed
- Removed the fluentui package temporarily due to incompatibility issues with React 18.


## [5.43.1] - 2026-05-20

Added: Implement single-package distribution to consolidate all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Added: Implement public mirror infrastructure for package configuration and publishing.  
Added: Redis connection readiness check with configurable timeout in the Cache Plugin.  
Added: ANY/ALL/SOME operators for SQL expressions now supported.  
Added: TypeScript generics support for type-safe expressions.  
Added: EXISTS and NOT EXISTS operators for SQL expressions.  
Added: Enhanced configuration and parameter handling including BETWEEN operator.  
Changed: Updated expression API usage and added re-exports in dbcore.  
Changed: Refactored the expression package structure and file organization.  
Changed: Renamed `compile` function to `where` for better semantic clarity.  
Changed: Migration from CommonJS to ESM with NodeNext module resolution in all packages.  
Fixed: Addressed various issues including dependency cleanup and type errors in the expression package.  
Fixed: Allow wrapping operands for ILIKE and renderComparison in the expression package.  
Fixed: Allow filtering of null elements in expression evaluations.  
Fixed: Added Like expression support in the expression package.  
Removed: FluentUI package temporarily due to incompatibility with React 18.  
Security: Addressed vulnerabilities discovered in dependencies across packages.  
Security: Upgraded various dependencies to resolve known vulnerabilities.


## [5.43.0] - 2026-05-19

### Added  
- Implemented Redis connection readiness with configurable timeout in Cache Plugin to prevent race conditions.  
- Introduced ANY/ALL/SOME operators for SQL expressions with full operator support and convenience methods.  
- Added TypeScript generics support for type-safe expressions.  
- Enhanced configuration and parameter handling in expressions, including BETWEEN operator.  
- Created SQL dialect system and global dialect configuration for handling multiple SQL dialects.

### Changed  
- Migrated the entire monorepo to ESM with NodeNext module resolution for improved import statements.  
- Renamed `expression2` package to `expression` and updated all references throughout the codebase.  
- Improved API usage and added re-exports in the expression package for better flexibility.  
- Updated the `compile` function to `where` for better semantic clarity and fixed related types.  
- Refactored expression builders into separate factory functions for improved code organization and maintainability.

### Fixed  
- Addressed issues with SQL expression handling including LIKE expression case sensitivity and null filtering.  
- Fixed false positives in tests regarding expressions by updating tests and refining logic.  
- Improved type alignments and ensured proper handling in function return types.  
- Fixed several type mismatches and ensured consistent usage of types across different packages.  
- Added missing types and improved formatting for better readability and consistency.

### Removed  
- Temporarily removed fluentui package due to compatibility issues with React 18.


## [5.42.0] - 2026-05-18

Changed: Migrated the entire monorepo to ESM with NodeNext module resolution for improved compatibility with modern JavaScript standards.  
Changed: Refactored expression package to include an expression builder for more structured expression creation.  
Changed: Renamed and modularized expression builders into separate factory functions to enhance maintainability and testability.  
Changed: Updated the TCompileResult interface to use 'whereClause' for better semantic clarity in query handling.  
Changed: Enhanced API to offer more intuitive usage and added re-exports from the expression package in other modules.  
Changed: Improved compatibility by making the expression methods available for use in the SQL kit.  
Added: Introduced generic type parameter support in the expression function for type-safe expression building.  
Added: Implemented new SQL operators (ANY, ALL, SOME, EXISTS, NOT EXISTS) to support additional query patterns within the expression package.  
Fixed: Corrected issues allowing null elements in filter expressions to enhance query flexibility.  
Fixed: Addressed missing types, sorting, and formatting issues across various packages for improved consistency and reliability.  
Fixed: Enhanced jest configuration to extend timeout settings for better handling of asynchronous tests.


## [5.41.0] - 2026-05-17

Changed: Moved expression functionality to its own package to enhance modularity and maintainability.  
Added: Implemented a comprehensive SQL dialect system with global dialect configuration support.  
Added: Introduced new expression methods for SQL including EXISTS, NOT EXISTS, and LIKE with case insensitivity.  
Added: Added support for TypeScript generics, improving type safety in expression construction.  
Fixed: Corrected SQL LIST return type and improved flexibility of Overriding and alternative prefixes.  
Fixed: Addressed compatibility and type issues across various packages.  
Fixed: Implemented enhancements to jest configurations for improved test reliability and coverage.


## [5.40.0] - 2026-05-17

Added: Implement single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Added: Add support for ANY/ALL/SOME operators in SQL expressions.  
Added: Enhanced configuration with dialect-specific settings and parameter handling.  
Added: Initial implementation of fluentui package.  
Changed: Updated the API for the expression package to support new features and improvements.  
Changed: Renamed expression2 package back to expression and updated references throughout the codebase.  
Fixed: Allow filtering of null elements in expressions.  
Fixed: Added Like expression to comparison functionality.  
Fixed: Updated missing types in various packages for better compatibility.  
Fixed: Refactored expression to expression builder for improved structure and ease of use.  
Removed: Temporarily removed fluentui package due to React 18 compatibility issues.  
Security: Addressed vulnerabilities by upgrading dependencies across multiple packages.


## [5.39.0] - 2026-05-07

### Added
- Implement single-package distribution for all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Implement public mirror infrastructure with publishConfig for all packages.
- Add production-ready SQL WHERE clause builder with yesql parameter format.
- Implement ANY/ALL/SOME operators for SQL expressions and type-safe expression interface.
- Add case insensitive support for LIKE expressions.

### Changed
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Rename expression2 package to expression with updated references and structures.

### Removed
- Removed fluentui package temporarily due to compatibility issues with React 18.

### Fixed
- Address various bugs including type fixing, formatting issues, and operational bugs in the expression and SQL kit packages.
- Allow filtering of null elements and improved the expression builder functionality.
- Correct error handling with enhanced logging for performance tests.

### Security
- No security vulnerabilities reported in this release.


## [5.38.0] - 2026-04-13

Changed: Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Changed: Migrated entire monorepo to ESM with NodeNext module resolution.  
Changed: Renamed `compile` function to `where` for better semantic clarity.  
Fixed: Corrected return type for `sql_list` method in the expression package.  
Fixed: Addressed various type issues and enhanced formatting across multiple packages.  
Fixed: Exported expression methods for better usability in SQLKit.  
Fixed: Added support for SQL 'LIKE' expression along with case insensitivity.  
Fixed: Removed the `fluentui` package due to compatibility issues with React 18.  
Fixed: Enhanced Redis connection readiness checks to prevent race conditions in the Cache Plugin.


## [5.37.0] - 2026-03-23

### Changed
- Migrated entire monorepo to ESM with NodeNext module resolution across all packages.
- Consolidated all 12 `@blendsdk/*` packages into a single `blendsdk` npm package with subpath exports.

### Added
- Implemented Redis connection readiness with configurable timeout in the Cache Plugin.
- Introduced ANY/ALL/SOME operators for SQL expressions.
- Added production-ready SQL WHERE clause builder with yesql parameter format.
- Enhanced configuration for expression methods with better parameter handling.
- Implemented EXISTS and NOT EXISTS operators to handle complex subqueries.

### Fixed
- Refactored the expression builder to address missing types and improve sorting and formatting.
- Fixed SQL_LIST return type and support for ILIKE comparisons.
- Addressed issues in jest configurations for all packages.


## [5.36.0] - 2026-03-23

Added: Implement single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Added: Implement public mirror infrastructure including root package.json repository URL updates and public access configuration for all packages.  
Added: Create DSL support with SQL dialect system and global dialect configuration.  
Added: Implemented enhanced configuration, parameter handling, and BETWEEN operator.  
Added: Implement case insensitive to LIKE expressions.  
Added: Export expression methods for easier method access.  
Changed: Migrated entire monorepo to ESM with NodeNext module resolution for improved compatibility.  
Changed: Refactored expression API to improve usage and support for TypeScript generics.  
Changed: Updated packages to align version requirements across all related packages.  
Fixed: Addressed multiple issues with expression builder to enhance functionality and reliability.  
Fixed: Updated test cases and added support for new SQL expression features.  
Fixed: Resolving type issues and enhancing syntax for better TypeScript integration.  
Fixed: Refactored the expression builder for improved structure and maintainability.  
Removed: Deprecated fluentui package due to compatibility issues with React 18.


## [5.35.0] - 2026-03-20

## [Added]
- Implement single-package distribution consolidating all `@blendsdk/*` packages into a single `blendsdk` npm package.
- Implement public mirror infrastructure with package configuration for npm registry.
- Add Redis pub/sub integration and contract tests.
- Implement Redis connection readiness checking in the Cache Plugin.
- Add production-ready SQL WHERE clause builder with yesql parameter format.
- Implement ANY/ALL/SOME operators for SQL expressions.
- Implement TypeScript generics support for type-safe expressions.
- Implement EXISTS and NOT EXISTS operators.
- Enhance configuration, parameter handling, and BETWEEN operator.

## [Changed]
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Rename `compile` function to `where` for better clarity.
- Improve expression API usage and add re-exports for convenience.

## [Fixed]
- Addressed several issues in the expression builder, including allowing filter null elements and supporting case-insensitive LIKE.
- Refactored the expression builder to support overriding and alternative prefixes.
- Fixed various types and updated SQL list return types.

## [Removed]
- Removed the fluentui package due to compatibility issues with React 18.


## [5.32.0] - 2026-02-11

## Changed

- Upgraded vitest to ^4.0.18 across all packages
- Aligned @types/node to ^22.0.0 everywhere
- Aligned typescript devDep to ^5.9.2
- Migrated entire monorepo to ESM with NodeNext module resolution
- Updated all imports to use explicit .js extensions for ESM compatibility
- Moved typescript from deps to devDeps
- Moved prettier from deps to devDeps
- Moved @types packages to devDeps
- Renamed `compile()` function to `where()` for better semantic clarity
- Updated `TCompileResult` interface to use 'whereClause' instead of 'sql' property
- Removed Hungarian notation prefixes from all type and interface names
- Modularized expression builders into separate factory functions
- Refactored expression builder architecture for better maintainability

## Added

- Added .npmignore files to all public packages
- Implement production-ready SQL WHERE clause builder with yesql parameter format
- Added SQL dialect system supporting PostgreSQL, MySQL, MSSQL, SQLite
- Added global dialect management with setGlobalDialect/getGlobalDialect
- Implemented BETWEEN operator with Between() and NotBetween() methods
- Implemented EXISTS and NOT EXISTS operators
- Implemented ANY/ALL/SOME operators for SQL expressions
- Added TypeScript generics support for type-safe expressions
- Added Like expression operator
- Added case insensitive ILIKE operator support
- Added comprehensive examples and documentation

## Removed

- Removed unused ESLint dependencies
- Removed outdated planning and implementation documentation files
- Removed old expression package directory (replaced by expression2)

## Fixed

- Fixed Phase 4-6 version alignment, code quality, and architecture issues
- Allow filtering null elements in expressions
- Allow wrapping operands for ILIKE and renderComparison
- Fixed sql_list return type
- Fixed missing types, sorting, and formatting issues
- Fixed jest configuration timeouts


## [5.31.0] - 2026-02-11

### Changed
- Upgraded vitest to ^4.0.18 and aligned TypeScript to ^5.9.2 across all packages
- Migrated entire monorepo to ESM with NodeNext module resolution and explicit .js extensions
- Modularized expression builders into separate factory functions following the factory pattern
- Removed Hungarian notation prefixes (I/T) from all type and interface names
- Renamed `compile()` function to `where()` for better semantic clarity
- Updated `TCompileResult` interface to use `whereClause` instead of `sql` property
- Replaced old expression package with expression2 by renaming directory and updating references

### Added
- Production-ready SQL WHERE clause builder with yesql parameter format
- Immutable AST architecture with fluent API and comprehensive type safety
- TypeScript generics support for type-safe expressions with compile-time validation
- EXISTS and NOT EXISTS operators with complex and correlated subquery support
- ANY/ALL/SOME operators with full operator support and convenience methods
- BETWEEN operator with enhanced configuration and parameter handling
- SQL dialect system supporting PostgreSQL, MySQL, MSSQL, and SQLite
- Global dialect management with setGlobalDialect/getGlobalDialect functions
- Dialect-specific configurations for parameter prefixes and quote characters
- LIKE and ILIKE operators with case-insensitive comparison support
- Re-export of @blendsdk/expression in dbcore/index.ts for convenience
- .npmignore files to all public packages excluding test artifacts
- Comprehensive examples and documentation including tutorials and API guides

### Fixed
- Dependency version alignment and moved typescript/prettier from deps to devDeps
- Removed unused ESLint dependencies and cleaned up package.json files
- Allow null elements in filter expressions
- Allow wrapping operands for ILIKE and renderComparison operations
- Code quality improvements and architecture fixes across packages

### Removed
- Outdated planning and implementation documentation files
- Performance tests (skipped)
