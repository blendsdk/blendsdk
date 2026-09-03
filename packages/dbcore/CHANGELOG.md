# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json to include new dependencies and maintain version consistency.


## [5.50.0] - 2026-07-31

### Added
- Implement single-package distribution, consolidating all @blendsdk/* packages into a single npm package.
- Add Redis connection readiness with configurable timeout in the Cache Plugin.
- Add optional trustViewNullability flag for cleaner view types in database introspection.
- Implement onBeforeQuery and onAfterQuery hooks for parameter transformation and result filtering.

### Changed
- Migrate to ESM with NodeNext module resolution across all packages, updating import paths and TypeScript configurations.
- Refresh external dependencies and Yarn lockfile across all workspaces.
- Upgrade monorepo to TypeScript 7 and adjust CI environment settings.

### Fixed
- Address report issues related to dependency and file cleanup.
- Improve error handling and type safety in dbcore tests and hooks.

### Deprecated
- Remove deprecated _filter property from DeleteStatement and UpdateStatement, ensuring filter() uses _expressionBuilder exclusively. 

### Security
- Add .npmignore files to exclude test artifacts from npm publications while maintaining necessary files for TypeScript development.


## [5.49.0] - 2026-07-31

## Added
- Implement complete database abstraction layer with PostgreSQL support in the @blendsdk/dbcore package.
- Add query transformation hooks with onBeforeQuery and onAfterQuery methods to Statement base class.
- Enhance selectAll() to support column aliasing for complex select queries.
- Implement Redis connection readiness checking in the Cache Plugin.
- Add optional trustViewNullability flag for cleaner view types in PostgreSQL.

## Changed
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Replace old expression package with expression2 by renaming it in the dbcore package.
- Improve expression API usage and add re-exports in dbcore.

## Removed
- Remove deprecated _filter property from DeleteStatement and UpdateStatement classes.

## Fixed
- Add sanity tests for dbcore and fix TypeScript assertions in hooks tests.
- Address report issues including dependency and file cleanup for better modularization.
- Fix code quality issues in dbcore including redundant constructor assignments.

## Security
- Add .npmignore files to all public packages to prevent test artifacts from being published.


## [5.48.0] - 2026-06-14

### Added
- Implement query transformation hooks to Statement base class with `beforeQuery` and `afterQuery` methods.
- Add optional `trustViewNullability` flag to control database view column nullability.
- Enhance `selectAll()` in `FromStatement` to support column aliasing.

### Changed
- Migrate all packages to ESM with NodeNext module resolution and update TypeScript configurations.
- Implement Redis connection readiness checking in the Cache Plugin to prevent race conditions.

### Removed
- Remove deprecated `_filter` property from `DeleteStatement` and `UpdateStatement`.

### Fixed
- Address TypeScript type assertions in hooks tests for better type safety.
- Added sanity test for `@blendsdk/dbcore` package to ensure test infrastructure works.


## [5.47.0] - 2026-05-22

Added:
- Implement Redis connection readiness with configurable timeout to prevent race conditions.
- Add column aliasing support to FromStatement, enabling computed expressions as aliases.
- Add onBeforeQuery and onAfterQuery hooks for parameter transformation and result filtering.

Changed:
- Migrate all packages to ESM with NodeNext module resolution for proper ESM support.
- Replace the old expression package with expression2, updating all references.
- Enhance selectAll() to accept Record<string, any> for column aliases.

Deprecated:
- Remove the deprecated _filter property from DeleteStatement and UpdateStatement.

Fixed:
- Fix TypeScript type assertions in hooks tests for better type safety.
- Add basic sanity test for @blendsdk/dbcore package to ensure test infrastructure works.


## [5.46.0] - 2026-05-21

## Added
- Implement Redis connection readiness in the Cache Plugin to prevent race conditions.
- Add optional `trustViewNullability` flag for cleaner database view types.
- Implement `filterByExpression` for DELETE and UPDATE statements for complex WHERE clauses.
- Add query transformation hooks `onBeforeQuery` and `onAfterQuery` to Statement class.
- Introduce comprehensive ai-training documentation covering concepts, usage, and best practices.

## Changed
- Migrate to ESM with NodeNext module resolution, updating TypeScript configurations.
- Refactor and improve expression API usage, adding re-exports for convenience.

## Deprecated
- Remove deprecated `_filter` property from DeleteStatement and UpdateStatement.

## Fixed
- Address TypeScript type assertions in tests for improved type safety.
- Add basic sanity test for dbcore package to ensure test infrastructure is functioning.

## Security
- Add minimal `.npmignore` configuration to exclude test artifacts from npm publications while preserving necessary files.


## [5.45.0] - 2026-05-21

Added:
- Implement Redis connection readiness with configurable timeout to prevent race conditions in the Cache Plugin.
- Add ai-training documentation, including core concepts, advanced patterns, and best practices for dbcore.
- Add optional trustViewNullability flag for cleaner view types in database introspection.
- Implement onBeforeQuery and onAfterQuery hooks for query transformation in Statement base class.
- Add column aliasing support to FromStatement for enhanced select capabilities.

Changed:
- Migrate entire monorepo to ESM with NodeNext module resolution for better module support.
- Improve expression API usage with re-exports in dbcore for enhanced convenience.

Deprecated:
- Removed deprecated _filter property from DeleteStatement and UpdateStatement in dbcore package.

Fixed:
- Address TypeScript assertions in hooks tests for better type safety.
- Add sanity test for @blendsdk/dbcore package to ensure test infrastructure works.


## [5.44.1] - 2026-05-20

Added:
- Implement Redis connection readiness with configurable timeout in the Cache Plugin to prevent race conditions.
- Add optional trustViewNullability flag for cleaner view types in PostgreSQL.
- Implement complete database abstraction layer with PostgreSQL support in @blendsdk/dbcore.
- Add query transformation hooks onBeforeQuery and onAfterQuery in the Statement base class.
- Implement filterByExpression for DELETE and UPDATE statements to allow complex WHERE clauses.

Changed:
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Improve expression API usage and add re-exports in dbcore package.
- Enhance selectAll() in FromStatement to accept column aliases.

Deprecated:
- Remove the deprecated _filter property from DeleteStatement and UpdateStatement in the dbcore package.

Refactored:
- Fix code quality issues across dbcore package, including redundant constructor assignments and improved documentation.

Fixed:
- Address report issues related to dependency cleanup and version alignment in packages. 
- Fix TypeScript type assertions in hooks tests for better type safety. 

Security:
- Add minimal .npmignore configuration to exclude test artifacts from npm publications.


## [5.44.0] - 2026-05-20

### Added
- Implement complete database abstraction layer with PostgreSQL support in dbcore package.
- Add Redis connection readiness with configurable timeout in Cache Plugin.
- Introduced trustViewNullability option for cleaner view types in introspection.
- Implement onBeforeQuery and onAfterQuery hooks with comprehensive testing.

### Changed
- Migrate entire monorepo to ESM with NodeNext module resolution for proper ESM support.
- Added re-export of @blendsdk/expression in dbcore for convenience.
- Enhanced selectAll() in FromStatement for column aliasing support.

### Fixed
- Addressed various TypeScript type assertions in tests for better type safety.
- Fixed code quality issues, including removing deprecated properties and ensuring correct functionality.

### Deprecated
- Removed deprecated _filter property from DeleteStatement and UpdateStatement.


## [5.43.1] - 2026-05-20

Added:
- Implement Redis connection readiness with configurable timeout to the Cache Plugin.
- Add column aliasing support to FromStatement to enhance selectAll() functionality.
- Add optional trustViewNullability flag for cleaner view types in introspection.
- Introduced comprehensive JSDoc documentation across the dbcore package.

Changed:
- Renamed expression2 package to expression and updated all references.
- Migrated entire monorepo to ESM with NodeNext module resolution for improved compatibility.
- Enhanced filter() method in DELETE and UPDATE statements to support expression-based filtering.

Deprecated:
- Removed the deprecated _filter property from DeleteStatement and UpdateStatement.

Fixed:
- Addressed report issues by cleaning up dependencies and aligning package versions.
- Improved TypeScript assertions in test files for better type safety.


## [5.43.0] - 2026-05-19

## Changed
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Moved tests from src/tests/ to tests/ for dbcore, postgresql, webafx and updated import paths in moved files.
- Migrated entire monorepo to ESM with NodeNext module resolution for proper ESM support.

## Added
- Added proper Redis connection readiness checking in the Cache Plugin to prevent race conditions.
- Introduced optional trustViewNullability flag for cleaner view types in PostgreSQL.
- Implemented onBeforeQuery and onAfterQuery hooks with comprehensive testing.

## Fixed
- Fixed TypeScript type assertions in hooks tests for better type safety.
- Addressed code quality issues by removing redundant constructor assignments in statements.
- Improved expression API usage and added re-exports for convenience.

## Removed
- Removed the deprecated _filter property from DeleteStatement and UpdateStatement as part of a code clean-up.


## [5.42.0] - 2026-05-18

### Added
- Implement Redis connection readiness with configurable timeout in the Cache Plugin.
- Add optional trustViewNullability flag to control database views' nullable information.
- Enhance selectAll() in FromStatement to support column aliasing.

### Changed
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Improve expression API usage and add re-exports for convenience.

### Deprecated
- Removed deprecated _filter property from DeleteStatement and UpdateStatement.

### Fixed
- Addressed TypeScript type assertions in hooks tests for better type safety.
- Added basic sanity test for @blendsdk/dbcore package to ensure test infrastructure works.

### Security
- Added minimal .npmignore configuration to all public packages to exclude test artifacts from npm publications while preserving necessary files for TypeScript development.


## [5.41.0] - 2026-05-17

### Added
- Implement Redis connection readiness with configurable timeout in the Cache Plugin.
- Add trustViewNullability option for cleaner view types.
- Enhance selectAll() to support column aliasing.

### Changed
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Improve expression API usage and add re-exports for convenience.

### Deprecated
- Removed the deprecated `_filter` property from `DeleteStatement` and `UpdateStatement`.

### Fixed
- Addressed report issues and performed dependency and file cleanup.
- Fixed TypeScript assertions in hooks tests for better type safety.

### Security
- Added minimal `.npmignore` configuration to exclude test artifacts from npm publications.


## [5.40.0] - 2026-05-17

- Added comprehensive JSDoc documentation to dbcore package.
- Added ai-training documentation with structured guides on various topics.
- Implemented Redis connection readiness with configurable timeout in Cache Plugin.
- Implemented onBeforeQuery and onAfterQuery hooks with comprehensive testing.
- Implemented complete database abstraction layer with PostgreSQL support.
- Added column aliasing support to FromStatement.
- Added optional trustViewNullability flag for cleaner view types.
- Implemented filterByExpression for DELETE and UPDATE statements.
- Removed deprecated _filter property from DeleteStatement and UpdateStatement.
- Improved expression API usage and added re-exports.
- Fixed code quality issues in dbcore with redundant constructor assignments removed.
- Standardized test locations and added dbcore tests for better organization.
- Addressed report issues related to phase dependency and file cleanup.
- Upgraded dependency versions for better alignment and compatibility.
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package.
- Added minimal .npmignore configuration to all public packages to exclude test artifacts.


## [5.39.0] - 2026-05-07

Changed: Migrate entire monorepo to ESM with NodeNext module resolution across all packages.  
Changed: Rename expression2 package to expression and update all references throughout the codebase.  
Changed: Improve expression API usage and add re-exports in dbcore.  
Added: Implement Redis connection readiness checking in the Cache Plugin to prevent race conditions.  
Added: Implement complete database abstraction layer with PostgreSQL support in @blendsdk/dbcore.  
Added: Add column aliasing support to FromStatement to enhance selectAll() functionality.  
Added: Implement onBeforeQuery and onAfterQuery hooks with comprehensive testing in Statement class.  
Added: TrustViewNullability option for cleaner view types in introspection.  
Added: Comprehensive JSDoc documentation added to dbcore package.  
Fixed: Address TypeScript assertions in hooks tests for better type safety.  
Fixed: Remove deprecated _filter property from DeleteStatement and UpdateStatement.  
Fixed: Implement expression-based filtering capabilities for DELETE and UPDATE statements.  
Fixed: Improve code quality and fix architectural issues within dbcore package.  
Deprecated: The _filter property has been officially deprecated and should not be used in new code.  
Removed: The old expression package has been removed in favor of the new expression approach.  
Security: Add minimal .npmignore configuration to all public packages to ensure sensitive files are excluded from npm packages.


## [5.38.0] - 2026-04-13

- Added comprehensive JSDoc documentation to the dbcore package for interfaces and types.
- Added Redis connection readiness checking in the Cache Plugin to prevent race conditions.
- Added optional trustViewNullability flag for cleaner view types in PostgreSQL.
- Implemented single-package distribution for @blendsdk/* packages into a single 'blendsdk' npm package.
- Implemented onBeforeQuery and onAfterQuery hooks in the Statement base class.
- Implemented complete database abstraction layer with PostgreSQL support in the dbcore package.
- Added expression-based filtering capabilities to DELETE and UPDATE statements.
- Removed the deprecated _filter property from DeleteStatement and UpdateStatement.
- Enhanced selectAll() in FromStatement to support column aliasing.
- Improved expression API usage with re-exports for convenience.
- Migrated entire monorepo to ESM with NodeNext module resolution.
- Created ai-training folder with structured documentation covering various topics.
- Fixed TypeScript assertions in hooks tests for better type safety.
- Cleaned up and aligned various dependencies across packages.
- Refactored code quality issues within the dbcore package.
- Updated package.json files to include new package version.


## [5.37.0] - 2026-03-23

### Added
- Add ai-training documentation, including usage patterns and best practices.
- Implement onBeforeQuery and onAfterQuery hooks for statement transformations.
- Add column aliasing support to FromStatement enhancing selectAll() functionality.
- Introduce a complete database abstraction layer with PostgreSQL support in the dbcore package.

### Changed
- Migrate all packages to ESM with NodeNext module resolution for better compatibility.
- Rename expression2 package to expression and update all references.

### Removed
- Eliminate deprecated _filter property from DeleteStatement and UpdateStatement classes. 

### Fixed
- Address TypeScript type assertions in hooks tests for improved type safety.

### Security
- Add minimal .npmignore files to all public packages to exclude unnecessary files from npm publications.


## [5.36.0] - 2026-03-23

### Added
- Created ai-training documentation with structured guides, including overview and testing patterns.
- Implemented Redis connection readiness with configurable timeout in the Cache Plugin.
- Added column aliasing support to FromStatement for improved query flexibility.
- Introduced onBeforeQuery and onAfterQuery hooks in Statement class for query transformation.

### Changed
- Migrated entire monorepo to ESM with NodeNext module resolution for improved compatibility.
- Enhanced expression API with re-exports for better usage across packages.
- Updated the query transformation methods in the Statement base class.

### Deprecated
- Removed deprecated _filter property from DeleteStatement and UpdateStatement.

### Fixed
- Addressed TypeScript assertions in hooks tests for improved type safety.
- Fixed code quality issues across dbcore and postgresql packages.

### Security
- Added .npmignore files to all public packages to prevent unintended publication of sensitive files.


## [5.35.0] - 2026-03-20

## Added
- Implement single-package distribution for all @blendsdk packages into a single 'blendsdk' npm package with subpath exports.
- Implement public mirror infrastructure, adding publishConfig to all packages.
- Add Redis connection readiness checking in the Cache Plugin.
- Add optional trustViewNullability flag for cleaner view types.
- Add column aliasing support to FromStatement for enhanced query capabilities.
- Implement onBeforeQuery and onAfterQuery hooks with comprehensive testing.
- Implement complete database abstraction layer with PostgreSQL support.

## Changed
- Migrate entire monorepo to ESM with NodeNext module resolution.
- Improve expression API usage and add re-exports in dbcore.

## Deprecated
- Remove deprecated _filter property from DeleteStatement and UpdateStatement.

## Fixed
- Address TypeScript assertions in hooks tests for better type safety.
- Add basic sanity test for @blendsdk/dbcore package to ensure test infrastructure works.

## Refactored
- Fix code quality issues in dbcore by removing redundant constructor assignments and improving exports.
- Rename expression2 package to expression, updating all code references.
- Enhance selectAll() functionality in FromStatement to support aliases.

## Security
- Add .npmignore files to all public packages to prevent the inclusion of test artifacts in npm publications.


## [5.32.0] - 2026-02-11

### Added
- Database service builders: `DataServiceBase`, `QueryDataService`, and `createQueryService` factory
- Database introspection support with `DatabaseIntrospector` and related types
- Expression-based filtering: `filterByExpression()` for DELETE and UPDATE statements
- Query lifecycle hooks: `beforeQuery()` and `afterQuery()` methods in Statement base class
- Column aliasing support in `FromStatement.selectAll()` with Record<string, any> syntax
- Export of `FilterableStatement`, `QueryDataService`, `createQueryService`, and `ExpressionBuilder`
- Trust view nullability option for cleaner PostgreSQL view type generation
- Comprehensive JSDoc documentation across all interfaces, types, and classes
- `.npmignore` configuration to exclude test artifacts from npm publications
- Complete test suite: Statement base class, CRUD statements, FromStatement, QueryDataService (21 tests total)
- `test:fast` script to package.json

### Changed
- Migrated entire package to ESM with NodeNext module resolution and explicit .js extensions
- Moved tests from `src/tests/` to `tests/` directory and updated import paths
- Updated dependency versions: vitest to ^4.0.18, @types/node to ^22.0.0, typescript to ^5.9.2
- Moved typescript and prettier from dependencies to devDependencies
- Re-exported @blendsdk/expression in index.ts for convenience
- Improved expression API usage throughout codebase

### Removed
- Deprecated `_filter` property from DeleteStatement and UpdateStatement (now uses `_expressionBuilder` exclusively)
- Redundant constructor assignments in Statement and CrudStatement classes
- Unused ESLint dependencies

### Fixed
- Code quality issues: removed redundant assignments and improved type safety
- TypeScript type assertions in hooks tests for better type safety
- Import paths after test relocation


## [5.31.0] - 2026-02-11

### Added
- Database abstraction layer with connection management and transaction support
- Statement base class with execute methods (executeReturnSingle, executeReturnMany, executeReturnNone)
- CRUD statement classes (InsertStatement, UpdateStatement, DeleteStatement, FromStatement)
- Query transformation hooks (onBeforeQuery and onAfterQuery) for parameter and result manipulation
- Column aliasing support to FromStatement with 'value AS key' syntax and computed expressions
- Re-export of @blendsdk/expression for convenience
- Database service builders (DataServiceBase and QueryDataService)
- Database introspection types and interfaces
- Comprehensive JSDoc documentation for all interfaces, types, and classes
- FilterableStatement base class for shared filtering logic
- Expression-based filtering capabilities (filterByExpression) for DELETE and UPDATE statements
- Trust view nullability option for database introspection
- Comprehensive test suite including Statement, CRUD statements, FromStatement, and QueryDataService tests
- Test infrastructure with sanity tests and test:fast script

### Changed
- Migrated from CommonJS to ESM with explicit .js extensions and NodeNext module resolution
- Moved tests from src/tests/ to tests/ directory with updated import paths
- Upgraded vitest to ^4.0.18
- Aligned @types/node to ^22.0.0
- Aligned typescript devDependency to ^5.9.2
- Enhanced selectAll() to accept Record<string, any> for column aliases
- Updated expression package integration with instance-based API usage

### Removed
- Deprecated _filter property from DeleteStatement and UpdateStatement (replaced with _expressionBuilder)
- Unused ESLint dependencies
- TypeScript and prettier from runtime dependencies (moved to devDependencies)

### Fixed
- TypeScript type assertions in hooks tests for better type safety
- Import paths in moved test files
- Dependency version alignment across packages
