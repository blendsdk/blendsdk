# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

### Added
- Add practical migration tutorials covering project-local CLI, snapshot model, and daily migration workflow.
- Add user and production guides for database migrations.
- Add migration command routing to handle CLI commands.
- Add migration session lock for advisory lock management.
- Add migration ledger to create and validate migration history.
- Add migration contracts defining configuration, descriptor, status, safety, result, and error types.

### Changed
- Update various documentation files to reflect new migration workflows and CLI commands.
- Modify migration artifact generation and publication mechanics.

### Fixed
- Close gaps in migration release gate to ensure smoother transition.
- Harden baseline adoption proof and migration artifact publication mechanisms.
- Revalidate locked migration history for improved consistency.

### Security
- Sanitize database URLs to prevent sensitive information exposure in logs.

### Deprecated
- No entries. 

### Removed
- No entries.


## [5.50.0] - 2026-07-31

Added: Implemented single-package distribution for all @blendsdk/* packages.
Added: Implement public mirror infrastructure (Phases 1-3) with publish configurations.
Added: ai-training documentation with structured guides.
Fixed: Resolved TypeScript compilation errors and ensured passing tests.
Fixed: Corrected an issue with generating PostgreSQL view columns.
Fixed: Fixed a critical bug in the DatabaseSchema hooks system.
Changed: Upgraded monorepo dependencies to refresh external dependencies and Yarn lockfile.
Changed: Upgraded monorepo to TypeScript 7 and ensured compatibility updates.


## [5.49.0] - 2026-07-31

Added:
  - Implemented single-package distribution for all @blendsdk/* packages into a single 'blendsdk' npm package.
  - Added Zod pipe/transform type support to OpenAPI converter.
  - Added viewColumnNullability option for PostgreSQL introspection.
  - Added drop all tables functionality to DatabaseSchema.
  - Added functionality to include a record converter on the DAL methods.

Changed:
  - Consolidated documentation with 145 structured docs under ai-training directory.
  - Enhanced PostgreSQL introspection to support user-defined types, including composite types and enums.
  - Refactored PostgreSQLSchemaGenerator to support grouped DDL generation.

Fixed:
  - Fixed stale README version and codegen spelling typos.
  - Fixed issues with code generation regarding incorrect type handling and introspection.
  - Resolved workspace dependency issue and TypeScript compilation errors.
  - Fix for generating array type schemas with union types.

Security:
  - Upgraded dependencies to mitigate vulnerabilities.


## [5.48.0] - 2026-06-14

## [Unreleased]

### Added
- Implemented Zod v4 → OpenAPI schema conversion.
- Added comprehensive PostgreSQL user-defined type introspection support.
- Added ai-training documentation with 11 structured documents.
- Implemented single-package distribution for all @blendsdk/* packages.
- Added viewColumnNullability option for PostgreSQL introspection.

### Changed
- Reorganized generator architecture and added Zod schema generation support.
- Improved index name generation for PostgreSQL indexes.

### Fixed
- Fixed various bugs in the code generation process, including array type generation.
- Resolved issues related to missing imports and undefined return types.
- Addressed problems with the database schema builder and validation logic.

### Security
- Upgraded dependencies to address vulnerabilities and ensure compliance with security practices.


## [5.47.0] - 2026-05-22

### Added
- Implemented comprehensive PostgreSQL user-defined type introspection support including composite types, enum types, and domain types.
- Added Zod pipe/transform type support to OpenAPI converter for Zod v4.
- Implemented a unified global registry for DB and type schemas with automatic schema registration.
- Added new documentation for ai-training, enhancing understanding of core concepts and usage.

### Changed
- Refactored code generation types and replaced loading of database schemas, using a generation-first model.
- Updated the package structure to support ESM with NodeNext module resolution for improved compatibility.
- Enhanced index name generation logic to eliminate suffixes for the first index.

### Fixed
- Fixed various bugs in type generation including multi-column primary keys and foreign key constraints.
- Resolved issues with schema reference detection and error handling in Zod integration.
- Corrected logging issues and clarified error messages throughout the application.
- Addressed numerous TypeScript compilation errors across multiple packages.

### Deprecated
- Deprecated the old code generation methods in favor of a new streamlined architecture for managing schemas.

### Removed
- Deleted obsolete code related to prior multi-schema management and associated complexity.

### Security
- Addressed a potential vulnerability by updating dependencies and improving configuration across packages.


## [5.46.0] - 2026-05-21

### Added
- Implemented single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Added support for Zod v4 pipe/transform types in OpenAPI converter.
- Created documentation for AI training scenarios, including overview, core concepts, and best practices.
- Introduced comprehensive PostgreSQL user-defined type introspection support, including composite, enum, and domain types.
- Added comprehensive index support in PostgreSQLSchemaGenerator.
- Implemented complete database schema builder for programmatic SQL generation with PostgreSQL support.

### Changed
- Updated routing, component generation, and documentation structures to improve code maintainability and developer experience.
- Refactored code generation architecture for improved extensibility and maintainability.
- Migrated codebase to ESM with NodeNext module resolution.

### Fixed
- Resolved various issues related to code generation, including missing types, incorrect schema references, and improved async handling.
- Corrected pluralization issues in autogenerated REST API endpoints and added comprehensive tests.
- Fixed bugs related to PostgreSQL views and schema types.
- Enhanced error handling in database access layer methods.

### Security
- Improved handling of sensitive data, including configurations to ensure proper encryption and access control for generated APIs.


## [5.45.0] - 2026-05-21

### Added
- Implemented single-package distribution for all @blendsdk/* packages into a consolidated 'blendsdk' npm package.
- Added AI training documentation covering overview, concepts, usage, patterns, API reference, and best practices.
- Added support for Zod v4 pipe and transform types in OpenAPI converter.

### Changed
- Consolidated API generation methods and improved structure for flexibility.
- Adjusted PostgreSQL introspection configuration to enhance functionality.

### Fixed
- Fixed issues with generated code including type definitions and SQL generation errors.
- Resolved bugs in unit tests related to TypeScript compilation and schema validation.
- Corrected ENUM handling to avoid duplicate type definitions.

### Removed
- Deprecated old schema and generation methods to streamline project structure.
- Unused dependencies and packages to optimize project performance.

### Deprecated
- Marked certain database-related functions and types as deprecated in favor of more efficient alternatives.


## [5.44.1] - 2026-05-20

Changed: Consolidated distribution method by merging all @blendsdk packages into a single 'blendsdk' npm package with subpath exports.
Added: Implemented single-package distribution for @blendsdk packages.
Added: Implemented public mirror infrastructure for package publishing.
Added: Comprehensive PostgreSQL user-defined type introspection support.
Added: Enhanced database views functionality includes materialized views and comments.
Added: Updated ai-training documentation with comprehensive guides and examples.
Fixed: Fixed stale README version and codegen spelling typos.
Fixed: Resolved various TypeScript compilation issues.
Fixed: Fixed bugs resulting from incorrect handling of PostgreSQL identity columns.


## [5.44.0] - 2026-05-20

- Added AI training documentation with structured guides and usage patterns.
- Added support for Zod v4 types in OpenAPI conversion, including pipe/transform types.
- Added comprehensive PostgreSQL user-defined type introspection support.
- Added unified global registry for database schemas and TypeScript type schemas.
- Fixed the handling of nullable columns in PostgreSQL introspection.
- Fixed bugs related to array type generation and union types.
- Fixed validation for database columns and allowed empty schemas in the generator.
- Removed obsolete and deprecated files from the codebase.
- Changed the structure of the code generation system to improve maintainability.


## [5.43.1] - 2026-05-20

## Changed
- Consolidated the code generation workflow into a unified system supporting both TypeScript and PostgreSQL.
- Refactored database schema handling to improve maintainability and testability.

## Added
- Introduced comprehensive ai-training documentation with modules covering overview, concepts, and usage patterns.
- Implemented support for PostgreSQL user-defined types during introspection, enhancing type mapping capabilities.

## Removed
- Deprecated methods and refactored existing code to streamline the API.

## Fixed
- Addressed various bugs in type generation and schema mapping, including ensuring proper handling of nullable types.
- Resolved issues with JSON schema generation and improved overall stability in the code generation process.


## [5.43.0] - 2026-05-19

## Added
- Implemented single-package distribution by consolidating all @blendsdk/* packages into a single 'blendsdk' npm package.
- Added ai-training documentation with comprehensive guides and best practices.
- Implemented Zod v4 → OpenAPI schema conversion support.
- Added support for Zod pipe/transform types in the OpenAPI converter.
- Added a drop-all-tables functionality to the DatabaseSchema class.

## Changed
- Enhanced PostgreSQL introspection to fully support user-defined types (UDTs).
- Improved handling of view columns in PostgreSQL schema generation.

## Fixed
- Resolved issues with TypeScript compilation and type generation for PostgreSQL schemas.
- Fixed spelling typos and README version discrepancies.
- Corrected logic for handling nullable view columns in database introspection.
- Fixed deletion bugs in DataService methods.

## Removed
- Deprecated and removed several legacy components and configurations from the codebase to streamline functionality.


## [5.42.0] - 2026-05-18

### Added
- Implement single-package distribution by merging all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Implement public mirror infrastructure for package configuration and public access.

### Changed
- Consolidated documentation structure for better clarity and navigation.
- Updated dependencies across multiple packages to their latest versions for improved performance and security.

### Fixed
- Addressed missing JSON schema and API Handling issues across various components.
- Resolved multiple bugs related to type generation, database interaction, and validation.

### Security
- Updated dependencies with known vulnerabilities to mitigate potential risks.


## [5.41.0] - 2026-05-17

Changed: Consolidated all @blendsdk/* packages into a single '@blendsdk/codegen' npm package with subpath exports for streamlined distribution.

Added: Implemented support for Zod v4 pipe types in OpenAPI conversion and created new API methods for advanced type handling.

Added: Comprehensive PostgreSQL schema support with cross-schema foreign key resolution and automatic schema creation statements.

Fixed: Addressed multiple issues with code generation, including type mapping and foreign key handling during database schema introspection.

Fixed: Renamed methods in data access layer for consistency and clarity, ensuring proper operation of data services across various types.

Fixed: Resolved TypeScript compilation errors and enhanced unit test coverage.

Fixed: Updated SQL schema generation to accommodate new requirements and constraints, ensuring compatibility with existing databases and applications.

Fixed: Improved documentation across multiple files, including detailed code comments and JSDoc for better maintainability.


## [5.40.0] - 2026-05-17

### Changed
- Consolidated all 12 @blendsdk/* packages into a single '@blendsdk' npm package with subpath exports.
- Updated package repository URL in root package.json to github.com/blendsdk/blendsdk.

### Added
- Implemented single-package distribution for better management.
- Added support for Zod v4 pipe types in OpenAPI converter.
- Added comprehensive PostgreSQL visitor schema with new methods for validation and type definition.
- Created ai-training documentation covering usage patterns, API references and advanced patterns.
- Added Redis pub/sub integration and contract tests to enhance testing capabilities.

### Fixed
- Fixed postgreSQL introspection support for user-defined types (UDTs), ensuring comprehensive schema handling.
- Resolved issues with stale README version and typos in codegen spelling.
- Fixed types for all 26 PostgreSQL column types, ensuring proper size and scale parameters.
- Addressed multiple module imports failures in the pricing engine tests.

### Security
- Applied updates for dependency vulnerabilities across multiple packages, including @blendsdk/codegen.


## [5.39.0] - 2026-05-07

### Added
- Implemented single-package distribution for @blendsdk/* packages into 'blendsdk' npm package with subpath exports.
- Added ai-training documentation with structured guides for core concepts, usage, and best practices.
- Implemented comprehensive PostgreSQL user-defined type introspection support, enhancing schema introspection capabilities.
- Added Zod pipe/transform type support to OpenAPI converter for handling Zod v4 pipe types.
- Added createComponent command for generating components in the CLI.
- Added additional properties to the REST API handling within the Data Service.

### Changed
- Updated package versioning across all related modules for better dependency management.
- Refactored database schema builder to allow for more modular and flexible schema definitions.

### Fixed
- Fixed various issues with documentation typos and outdated references across multiple files.
- Resolved PostgreSQL schema export errors and improved support for view generation.
- Fixed Zod integration issues regarding schema mapping and handling of imports, ensuring a smooth development experience.

### Removed
- Deprecated old uni-directional data service methods in favor of a more streamlined interface.
- Removed obsolete validations and type checks that were no longer applicable to current functionality.

### Security
- Updated dependencies to mitigate vulnerabilities and ensure compliance with current standards.


## [5.38.0] - 2026-04-13

### Added
- Implemented AI training documentation with comprehensive structure and examples.
- Implemented single-package distribution consolidating all @blendsdk/* packages into a unified 'blendsdk' NPM package.
- Added Zod type support to OpenAPI converter and functionality to convert complex types.
- Added support for PostgreSQL user-defined types (UDTs) including composite and enum types.
- Added view support with complete comment handling for PostgreSQL schema generator.

### Changed
- Updated the internal structure for handling database introspection and type conversions.
- Enhanced code generation to support new database and type schema rules, refining the overall architecture.

### Fixed
- Fixed numerous typos and inconsistencies across README documentation and code comments.
- Resolved various bugs related to type generation and method handling in the data access layer.
- Corrected issues with PostgreSQL schema handling to ensure proper integration with existing services.

### Deprecated
- Marked certain features as deprecated in response to internal refactoring and architecture improvements.

### Removed
- Eliminated obsolete files and deprecated functionalities from the codebase, streamlining project structure and dependencies.


## [5.37.0] - 2026-03-23

### Changed
- Implemented single-package distribution, consolidating all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

### Added
- Comprehensive PostgreSQL schema support with cross-schema foreign key resolution.
- New configuration options: `viewColumnNullability` and `trustViewNullability` for PostgreSQL introspection to control column treatment.
- Zod v4 → OpenAPI schema conversion and support for handling Zod v4 pipe types in OpenAPI representation.
- AI-training documentation with detailed guides on usage, best practices, and common scenarios.
- Redis pub/sub integration and contract tests for various scenarios.

### Fixed
- Stale README version and typos corrected in codegen.
- Various type generation and database schema fixes, including handling of identity columns and view generation.

### Removed
- Obsolete export verification test and disabled playground tests due to changes in development focus.


## [5.36.0] - 2026-03-23

### Added
- Add AI-training documentation with 11 structured documents covering concepts, usage, and API reference.
- Implement single-package distribution consolidating @blendsdk/* packages into a single 'blendsdk' npm package.
- Implement comprehensive PostgreSQL user-defined type introspection support including composite types, enum types, and domain types.
- Add new configuration options for PostgreSQL introspection regarding view columns and schema naming.
- Introduce Zod v4 pipe/transform type support for OpenAPI converter and comprehensive index support to PostgreSQLSchemaGenerator.

### Changed
- Consolidate classes in the generator architecture and improve directory structure for better maintainability.
- Refactor type generation and validation systems for better adherence to TypeScript patterns.

### Fixed
- Correct spelling typos in README and code generation documentation.
- Fix stale README version and address multiple issues in PostgreSQL type handling and validation checks.
- Resolve various discrepancies in introspection for PostgreSQL and schema definitions to ensure accuracy.

### Security
- Address improper handling of certain database schema constraints potentially leading to injection vulnerabilities in specific use cases.


## [5.35.0] - 2026-03-20

- Added comprehensive PostgreSQL user-defined type introspection support.
- Added Zod pipe/transform type support to OpenAPI converter.
- Added option to control view columns' nullability during database introspection.
- Added comprehensive database schema builder with PostgreSQL support.
- Added support for multi-column primary keys and foreign keys.
- Added the ability to read SQL files in the query for DAL.
- Added virtual delete functionality for CRUD operations.
- Implemented repository generator with comprehensive documentation.
- Implemented single-package distribution, consolidating all @blendsdk/* packages.
- Updated package versions across all packages for dependencies and devDependencies.
- Fixed stale README version and codegen spelling typos.
- Fixed the test failures related to multi-column keys.
- Fixed issues with the database schema export for views.
- Fixed various TypeScript compilation issues across codebase.
- Fixed broken REST API generation by adjusting the default behavior.
- Removed deprecated files and functionality from the codebase.


## [5.32.0] - 2026-02-11

## Added
- PostgreSQL user-defined type introspection support including composite types, enum types, and domain types
- Comprehensive schema builder with fluent API for programmatic schema definition
- PostgreSQL schema generator with support for all 26 column types
- Database views functionality with materialized views and comments support
- Generated columns support (GENERATED ALWAYS AS expressions)
- Identity columns with UUID support as alternative to SERIAL types
- Comprehensive index support with auto-generated names for all major index types
- Multi-column primary keys and foreign keys support with composite key helpers
- View column nullability control with `trustViewNullability` option
- Schema name prefixing configuration for database introspection
- Constant Type Generator for PostgreSQL enums and custom types
- PostgreSQL schema support with cross-schema foreign key resolution
- Zod schema generation and validation support
- Code comments generation for database objects
- JSDoc documentation support with TypeDoc compatibility
- Import file option for generated code
- Validation rule system and comprehensive validation infrastructure
- RecordSchema, PickSchema, OmitSchema, ArraySchema implementations
- Date, BigInt, Any, and Unknown primitive schema types
- Database seed stub creator and CSV import templates
- Grouped DDL generation for better deployment control

## Changed
- Upgraded vitest to ^4.0.18 across all packages
- Aligned @types/node to ^22.0.0 and typescript to ^5.9.2
- Migrated entire monorepo to ESM with NodeNext module resolution
- Moved typescript from dependencies to devDependencies
- Refactored expression to separate ExpressionBuilder package
- Simplified codegen architecture by removing complex multi-registry system
- Restructured generator architecture with new abstract base classes
- Index name generation now omits position 0 suffix for cleaner names
- Changed enum values to improve code generation
- Renamed methods to follow `define*` naming convention
- Refactored type builder to eliminate duplicate code and improve maintainability

## Deprecated
- GeneratorConfig references removed from documentation

## Removed
- Unused ESLint dependencies
- Deprecated packages (types, validation - functionality moved to codegen)
- Console output from production code
- Old schema and type generation system files
- Duplicate barrel file generators
- Export verification test for non-existent RepositoryGenerator

## Fixed
- Phase 4-6 version alignment, code quality, and architecture fixes
- Dependency version alignment and file cleanup
- Hooks system to properly apply metadata-driven columns
- Multi-column key constraint generation
- Circular dependency detection in schema references
- Array type generation with proper parentheses for union types
- Schema reference detection for clean TypeScript types
- Foreign key constraint generation in PostgreSQL
- Database column type mapping for accurate type conversion
- Quoted defaults handling in code generation
- View generation and column nullability handling
- Module import paths and ESM compatibility
- Test failures for multi-column keys and database connections
- Validation schema generation and template rendering
- Recursive JSON serialization errors
- REST API parameter location and payload type handling

## Security
- No security-related changes in these commits


## [5.31.0] - 2026-02-11

### Added
- Added Constant Type Generator for database constant types
- Added comprehensive PostgreSQL user-defined type introspection support including composite types, enum types, and domain types
- Added database schema reintroduction with schema/view/table/column classes
- Added PostgreSQL schema generator for DDL generation
- Added comprehensive index support to PostgreSQLSchemaGenerator with auto-generated names
- Added identity columns with UUID support
- Added comprehensive view support with materialized views and comments
- Added PostgreSQL generated columns support
- Added all 26 PostgreSQL column types with proper size, scale, and precision parameters
- Added drop all tables functionality to DatabaseSchema
- Added code comments to ctype-generator
- Added formatter to ctype-generator
- Added `viewColumnNullability` option for PostgreSQL introspection to control how view columns are treated
- Added automatic schema registration via `.db()` and `.types()` extension methods
- Added introspect types export
- Added database schema builder implementation
- Added comprehensive JSDoc documentation following DocumentThis style
- Added Date, BigInt, Any, and Unknown primitive schema types
- Added PickSchema and OmitSchema with comprehensive TypeScript utility type support
- Added RecordSchema implementation
- Added ArraySchema with comprehensive JSDoc documentation
- Added validation rule system and ValidatorBuilder
- Added reference schema support for object references
- Added enum builder functionality

### Changed
- Moved database schema functionality into introspect folder
- Upgraded vitest to ^4.0.18 across all packages
- Aligned @types/node to ^22.0.0 everywhere
- Aligned typescript devDep to ^5.9.2
- Move typescript from deps to devDeps (6 packages)
- Move prettier from deps (4 packages)
- Move @types packages to devDeps
- Migrated entire monorepo to ESM with NodeNext module resolution
- Refactored generator architecture with new abstract base class
- Restructured generator architecture and added Zod schema generation
- Enhanced Pick and Omit schemas to support both string names and direct schema variable references
- Enhanced schema system with reference support and improved type generation
- Separated type generation from validator generation as per original design
- Refactored expression builder and renamed to ExpressionBuilder

### Fixed
- Fixed ctype generator implementation
- Fixed ctype relation names in introspection
- Fixed database schema paths
- Fixed schema extraction and template rendering issues
- Fixed schema reference detection and error handling
- Fixed array syntax error handling
- Fixed schema reference registry for clean TypeScript types
- Fixed Prettier formatting implementation in TypeScript generator
- Fixed multi-column keys TypeScript module declaration conflicts
- Fixed foreign key constraint generation
- Fixed schema extending functionality
- Fixed duplicate types when extending a type
- Fixed hooks system to properly apply metadata-driven columns
- Fixed view generation and relationship type generation
- Fixed invalid cheking in TypeSchema
- Fixed payload type handling to allow builtin types
- Fixed integer type mapping in PostgreSQL schema builder

### Removed
- Removed unused ESLint dependencies
- Removed old deprecated packages and files
- Removed RBAC functionality temporarily
- Removed signing feature
- Removed glob dependency
- Removed dictionary enums

### Security
- Updated dependencies to address security vulnerabilities
