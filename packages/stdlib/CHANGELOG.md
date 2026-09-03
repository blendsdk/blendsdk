# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json to include improved dependency management and versioning.


## [5.50.0] - 2026-07-31

Changed: Refresh external dependencies and Yarn lockfile across every workspace.  
Changed: Upgrade monorepo to TypeScript 7 and adjust compatibility accordingly.  
Changed: Migrate entire monorepo to ESM with NodeNext module resolution for all packages.  
Added: Implement single-package distribution to consolidate all @blendsdk/* packages into a single npm package.  
Added: Implement public mirror infrastructure, enabling public package publication.  
Added: Redis pub/sub integration and contract tests added for extensive coverage.  
Added: Comprehensive test coverage for utility functions in the stdlib package.  
Added: Micro templating functionality and enhanced valueIf with a custom check added.  
Added: New utility functions including arrayFilter, collection utils, and others to the stdlib package.  
Fixed: Address various issues including ESM import problems and undefined checks in utility functions.  
Fixed: Resolve formatting errors and improve the Jest timeout settings for stable testing.  
Fixed: Update error handling and logging functionality for better performance.  
Removed: Deprecated legacy code and packaging issues cleaned up in the stdlib package.  
Removed: CHANGELOG files from individual packages to consolidate documentation.  
Removed: Unused ESLint dependencies and refactored clientKit package for better structure.


## [5.49.0] - 2026-07-31

Added: Implemented valueIf utility function to handle conditional values based on a custom check.  
Added: Introduced arrayFilter function to filter arrays based on provided criteria.  
Added: Added initial implementation of micro templating functionality.  
Added: Introduced isEmpty utility method for checking empty values.  
Added: Included new utility functions such as filterObject and indexObject.  
Added: Enhanced the apply function to merge arrays correctly.  
Added: Added new utility isPromise to check if a value is a promise.  
Added: Implemented asyncForEach utility to handle asynchronous array iteration.  
Added: Added tests for utility functions for enhanced reliability and validation.  
Fixed: Resolved various issues with package imports and enhanced error handling.  
Fixed: Updated package versions to align with dependencies and improvements.  
Fixed: Corrected isDate utility to check for valid date objects accurately.  
Fixed: Addressed undefined checks in utility functions for robust performance.  
Fixed: Refactored several utilities for compatibility with TypeScript updates.  
Fixed: Improved error message details for better debugging and diagnostics.  
Fixed: Adjusted jest configuration for improved testing reliability and coverage.  
Fixed: Refactored the logger functionality for better streaming support in docker environments.  
Fixed: Fixes to ensure proper type handling in TypeScript, improving overall robustness.


## [5.48.0] - 2026-06-14

## Added
- Implemented single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Added comprehensive test coverage for utility functions including isBoolean, isNumeric, and isString.
- Added Redis connection readiness with configurable timeout in the Cache Plugin.
- Added arrayFilter utility function.
- Added initial fluentui package for UI component handling.
- Added valueIf utility function for conditional value assignment.
- Added filterObject utility for object manipulation.

## Changed
- Migrated entire monorepo to ESM with NodeNext module resolution for consistent imports.
- Updated the structure and functionality of the stdlib package, enhancing type safety and documentation.
- Enhanced JSDoc documentation throughout stdlib functions with practical examples and parameter descriptions.
- Updated Redis pub/sub implementation with enhanced integration.

## Fixed
- Fixed import statement issues to ensure proper module loading in ESM.
- Resolved ESM import issues related to missing .js extensions.
- Addressed undefined checking in utility functions and logger improvements.
- Fixed formatString functionality to ensure correct string formatting.
- Resolved issues with isDate checks and improved utility functions validation across the package.

## Deprecated
- Removed outdated methods and replaced with improved alternatives across various utilities.


## [5.47.0] - 2026-05-22

## Added
- Implemented arrayIntersect utility function and tests.
- Added arrayFilter utility function and tests.
- Introduced valueIf utility function with conditional behaviors.
- Added isEmpty utility function and tests.
- Added formatString utility function for flexible string formatting.
- Added CRC32 hash function.
- Implemented the base64 functionality for encoding and decoding.
- Added utility functions for collection operations.

## Changed
- Updated several utility methods for better type checking and formats.
- Refactored various source files for improved readability and maintainability.
- Enhanced error handling in utility functions.

## Fixed
- Corrected many utility functions for better edge case handling and performance.
- Fixed issues with undefined checks and improved overall robustness of functions.
- Resolved import statement errors across several files.
- Fixed test cases for utility functions to ensure comprehensive coverage.

## Security
- Upgraded dependencies to address potential vulnerabilities.


## [5.46.0] - 2026-05-21

Added: Implemented single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Added: Implemented public mirror infrastructure for publish configurations.  
Added: Comprehensive test coverage for utility functions including isBoolean, isNumeric, and isString.  
Added: Redis connection readiness with configurable timeout in the Cache Plugin.  
Added: New utility functions including arrayFilter, valueIf, and indexObject.  
Added: Micro templating functionality into the stdlib package.  
Added: CRC32 hash function and formatting features into stdlib.  
Changed: Refactored logger to create a dedicated package for improved streaming.  
Changed: Enhanced error handling to include generic error parsing and additional fields.  
Changed: Migration of stdlib utilities for improved structure and compatibility with ESM.  
Fixed: Resolved ESM import issues with proper .js extensions across various packages.  
Fixed: Addressed issue with undefined checks and improved error messaging.  
Fixed: Applied changes to the apply function to merge arrays correctly.  
Fixed: Revised valid checks for types including arrays and dates.  
Fixed: Various package upgrades to the latest stable versions across dependencies.  
Fixed: Comprehensive updates to JSDoc for enhanced utility function documentation and examples.  
Removed: Deprecated methods from the stdlib for a cleaner API surface.


## [5.45.0] - 2026-05-21

### Changed
- Migrated the entire stdlib package to a new structure with ESM module system and TypeScript strict mode.

### Added
- Introduced arrayIntersect utility for array intersection operations.
- Added additional utility functions: valueIf, filterObject, and isEmpty.
- Implemented async utilities and additional methods including base64 encoding and a new micro templating feature.

### Fixed
- Fixed issues with formatting functions including formatString and ensured better handling for various edge cases.
- Updated type checks and error handling across multiple utility functions.
- Corrected several imports and type definitions to meet recent standards and practices.

### Removed
- Cleaned up deprecated code and unnecessary files from the stdlib package, including changelog files.


## [5.44.1] - 2026-05-20

### Changed
- Consolidated all 12 @blendsdk/* packages into a single '@blendsdk/stdlib' npm package with subpath exports.

### Added
- Implemented utility functions `arrayFilter`, `valueIf`, `isEmpty`, and `indexObject`.
- Introduced `MicroTemplate` functionality for templating.
- Added `formatString` function as a replacement for `applyVariables`.
- Enhanced debugging options for services and translations.

### Fixed
- Resolved checksum discrepancies and ensured promise checks with `isPromise`.
- Addressed various utility function errors and updated Jest configurations.
- Fixed implementation issues in `isDate`, `isNumeric`, and `apply`.
- Improved handling of undefined checks in multiple functions.

### Removed
- Deprecated and unused functions removed from the utility library.


## [5.44.0] - 2026-05-20

Added: Added comprehensive test coverage for utility functions in the stdlib package, including isBoolean, isNumeric, and isString functions.  
Added: Implemented Redis connection readiness with configurable timeout in the Cache Plugin.  
Added: New utility function isEmpty added to the stdlib package.  
Added: New utility function filterObject added to the stdlib package.  
Added: New utility function arrayFilter added to the stdlib package.  
Added: New utility function valueIf added to the stdlib package.  
Added: New utility function indexObject added to the stdlib package.  
Added: New utility function asyncForEach added to the stdlib package.  
Added: New utility function base64 methods added to the stdlib package.  
Added: New utility function MicroTemplate added for templating functionality in the stdlib package.  
Changed: Migrated stdlib package to use ESM module system with TypeScript strict mode.  
Changed: Updated documentation in the stdlib package to enhance API reference.  
Changed: Refactored utility functions in the stdlib package for better performance and readability.  
Fixed: Fixed several issues with undefined checking in the stdlib package.  
Fixed: Added checks for valid dates in isDate function of the stdlib package.  
Fixed: Updated error handling in the stdlib package.  
Fixed: Updated return type of several utility functions in the stdlib package.  
Fixed: Resolved formatting issues in the formatString function of the stdlib package.  
Fixed: Fixed import issues for ESM compatibility across various utility functions in the stdlib package.


## [5.43.1] - 2026-05-20

### Added
- Implemented single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package.
- Added comprehensive test coverage for utility functions: isBoolean, isNumeric, and isString.
- Added Redis connection readiness checking with configurable timeout in Cache Plugin.
- Added valueIf utility to handle conditional logic more effectively.
- Added functionality for async processing with asyncForEach.
- Introduced filterObject utility to manipulate object keys/values.

### Changed
- Migrated entire monorepo to ESM with NodeNext module resolution for better compatibility.
- Enhanced JSDoc documentation across multiple functions with detailed examples.
- Updated package versioning and documentation for clarity and organization.

### Fixed
- Resolved ESM import issues with .js extensions across the codebase.
- Addressed various bugs related to function implementations and TypeScript type definitions.
- Fixed consistency issues in error messages and type checking across utility functions like isEmpty, formatString, and deep copy functions. 

### Deprecated
- Marked previous versions of certain utility functions that will be superseded by new implementations.

### Removed
- Deleted old CHANGELOG files to maintain a cleaner project structure.


## [5.43.0] - 2026-05-19

### Added
- Implemented single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package.
- Added arrayFilter utility function.
- Added valueIf function for conditional value assignment.

### Changed
- Refactored entire monorepo to ESM with NodeNext module resolution.
- Updated documentation for utility functions with comprehensive API references and usage examples.

### Fixed
- Addressed undefined checking issues in various utility functions.
- Added detailed error handling and improved error message clarity.
- Corrected formatting function and applied variable adjustments in various contexts.
- Updated multiple utility functions to enhance functionality and performance.

### Removed
- Deprecated and removed old codes and files related to previous package versions.


## [5.42.0] - 2026-05-18

### Added
- Implement utility function for array filtering in `stdlib`.
- Add micro templating functionality to `stdlib`.
- Introduced function `valueIf` to `stdlib`.
- Enhanced `valueIf` function with custom checks in `stdlib`.
- Added `arrayIntersect` utility function in `stdlib`.
- Implemented `isEmpty` utility and its test cases in `stdlib`.

### Changed
- Migrate `stdlib` to ESM with updated import paths.
- Improved type checks for array utilities in `stdlib`.

### Fixed
- Corrected implementation to merge arrays accurately in `apply` function of `stdlib`.
- Fixed undefined checks in `deepcopy`.
- Added error handling for non-numeric values in `formatString`.
- Resolved invalid checks and improved the type checks for date handling.

### Removed
- Deprecated signing feature from the clientkit.

### Security
- Updated package versions to patch known vulnerabilities in dependencies.


## [5.41.0] - 2026-05-17

## Added
- Added arrayFilter utility function and tests.
- Added arrayIntersect utility function and tests.
- Added isEmpty utility function and tests.
- Added indexObject utility function and tests.
- Added valueIf utility function and tests.
- Added FormatString function and replace functionality for templates.
- Added micro templating functionality to the stdlib package.

## Changed
- Cleaned out the changelog files.
- Enhanced isBoolean method to handle more cases.
- Refactored apply function to merge arrays correctly.

## Fixed
- Fixed import issues in the stdlib package.
- Fixed various undefined checks in utility functions.
- Fixed logging for errors in the clientkit.

## Removed
- Removed deprecated methods and outdated references in the stdlib.
- Removed fluentui package temporarily due to compatibility issues with React 18.

## Security
- Addressed potential vulnerabilities in dependencies and package updates.


## [5.40.0] - 2026-05-17

Changed: Migrated entire monorepo to ESM with NodeNext module resolution for all packages.  
Added: implement single-package distribution consolidating all 12 @blendsdk/* packages into a single 'blendsdk' npm package.  
Added: Added new utility functions: isEmpty, isPromise, arrayFilter, and valueIf to the stdlib package.  
Added: Introduced comprehensive test suites for utility functions including isBoolean, isNumeric, and isString.  
Added: Enhanced error handling with new error parsing functionality.  
Fixed: Resolved multiple type-checking and import issues related to ESM migration across packages.  
Fixed: Addressed and resolved undefined checking issues in various utility functions.  
Fixed: Updated several logging and error handling utilities for improved performance and clarity.


## [5.39.0] - 2026-05-07

Added: Added arrayFilter utility.  
Added: Added valueIf utility function.  
Added: Added isEmpty method and tests.  
Added: Added initial implementation for CRC32 hash function.  
Added: Added micro templating functionality.  
Added: Added isPromise utility and tests.  
Added: Added async methods and tests for value checking.  
Added: Added additional error handling and debugging functionalities.  
Fixed: Fixed import statement in ConsoleLogger.  
Fixed: Updated error message and functionality in error handling.  
Fixed: Fixed undefined checking in deepcopy utility.  
Fixed: Refactored HTTP request handling in ClientKit.  
Fixed: Enhanced valueIf to support custom checks.  
Fixed: Corrected implementation of array merging in apply function.  
Fixed: Updated code documentation for multiple utilities.  
Fixed: Updated package versions for dependencies.  
Removed: Removed deprecated fluentui package support.  
Changed: Refactored to cope with TypeScript updates and improved type checking.  
Changed: Updated package versioning scheme.  
Deprecated: Deprecated various utilities and code structure before major revision.  
Security: Addressed potential security vulnerabilities in HTTP requests.  
Security: Enhanced error logging and handling for sensitive information.


## [5.38.0] - 2026-04-13

### Added
- Implemented single-package distribution, consolidating all @blendsdk/* packages into a single npm package with subpath exports.
- Added Redis pub/sub integration and contract tests, including various test scenarios.
- Added comprehensive test coverage for utility functions in the stdlib package, covering edge cases.

### Changed
- Updated documentation to include TypeScript integration examples and a comprehensive API reference for utility functions.
- Migrated entire monorepo to ESM with NodeNext module resolution for improved compatibility.

### Fixed
- Addressed ESM import issues by adding .js extensions to all relevant imports.
- Resolved various issues in utility functions and ensured consistency in error handling and type definitions.
- Fixed import statement discrepancies to align with package structure changes.

### Removed
- Removed obsolete CHANGELOG files from individual packages to streamline documentation. 

### Security
- Conducted a review of dependencies to identify potential security vulnerabilities and updated packages accordingly.


## [5.37.0] - 2026-03-23

### Changed
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

### Added
- Implemented Redis connection readiness with configurable timeout in the Cache Plugin.
- Added arrayFilter utility function for filtering arrays.
- Added initial fluentui package for enhanced UI components.
- Added new utility functions: isEmpty, arrayIntersect, and micro templating functionality.

### Fixed
- Addressed several issues for undefined checking and formatting errors in utility methods.
- Fixed the import statement in the ConsoleLogger module.
- Updated error handling in various components to enhance robustness.

### Removed
- Removed some legacy features and cleaned up deprecated code across multiple packages.


## [5.36.0] - 2026-03-23

### Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

### Added
- Implemented Redis connection readiness with configurable timeout in the Cache Plugin.
- Added comprehensive test coverage for utility functions in the stdlib package, including tests for isBoolean, isNumeric, and isString functions.
- Enhanced JSDoc documentation with examples for utility functions in the stdlib package.
- Introduced a micro templating functionality in the stdlib package.
- Added collection utilities in the stdlib package.

### Fixed
- Addressed multiple import issues related to ESM compatibility.
- Resolved errors in utility functions and improved handling in various modules.
- Fixed formatting issues and improved TypeScript definitions across multiple files in stdlib.

### Removed
- Deprecated and removed unused code from various packages, including fluentui due to compatibility issues with React 18.


## [5.35.0] - 2026-03-20

### Added
- Implement single-package distribution for all @blendsdk packages, consolidating them into a single 'blendsdk' npm package with subpath exports.
- Implement public mirror infrastructure for package configurations, enabling public access to all packages.
- Add comprehensive test coverage for utility functions in the stdlib package, including isBoolean, isNumeric, and isString.
- Implement Redis connection readiness checking in the Cache Plugin.
- Add extended functionality to utility functions, including isNullOrUndef and wrapInArray.
- Add base64 methods, arrayFilter, valueIf, and filterObject to the stdlib package.
  
### Changed
- Migrate entire monorepo to ESM with NodeNext module resolution, enhancing compatibility with modern JavaScript.
- Updated README.md to include a complete API reference for utility functions and organized documentation by categories.
- Refactored the entire stdlib package, ensuring type safety and improving generic constraints across utility functions.
- Enhanced apply logic to better handle arrays and object merging.
  
### Fixed
- Address various issues related to ESM import compatibility, including updating import statements and ensuring proper usage of .js extensions.
- Fixed undefined checks and updated error handling within utility functions such as formatString and applyVariables.
- Corrected import and export statements causing failures in building the application.
- Resolved bugs in collection utilities, ensuring methods like arrayIntersect and isEmpty work correctly and reliably.
- Updated jest configuration across multiple packages to avoid timeout issues in tests.
  
### Removed
- Deprecated features and irrelevant code segments amidst cleanup processes, streamlining the codebase while enhancing performance.
- Removed the signing feature as part of refactoring and maintaining a simplified API.


## [5.32.0] - 2026-02-11

## Added
- Comprehensive test coverage for utility functions including isBoolean, isNumeric, and isString
- Test suites for isNullOrUndef and wrapInArray functions with 33 tests each
- Tests for apply, argumentsToArray, and arrayFilter functions
- MD5 hash function with tests and documentation
- CRC32 hash function
- splitArray function with tests
- attempt function with tests
- sortObjectArray function for sorting object arrays
- isPromise function with tests
- formatString function replacing applyVariables
- Generic error parser
- valueIf function with custom check support
- filterObject utility function with tests
- isEmpty method with tests
- indexObject utility function with tests
- find collection utility function with tests
- base64 encode/decode methods with tests
- arrayFilter function
- asyncForEach documentation

## Changed
- Migrated entire monorepo from CommonJS to ESM with NodeNext module resolution
- Updated all relative imports to include .js extensions for ESM compatibility
- Migrated from v3 to v4 package structure with strict TypeScript mode
- Migrated testing framework from Jest to Vitest
- Enhanced JSDoc documentation with 3-10 practical examples per function
- Upgraded vitest to ^4.0.18 across all packages
- Aligned @types/node to ^22.0.0
- Aligned typescript devDep to ^5.9.2
- Moved typescript from dependencies to devDependencies
- Moved prettier from dependencies
- Moved @types packages to devDependencies
- Enhanced valueIf with custom check functionality
- Improved apply function to merge arrays correctly
- Updated formatString for string interpolation
- Changed copyright owner in LICENSE files
- Upgraded package versions to maintain compatibility

## Fixed
- ESM import issues with .js extensions
- TypeScript configuration to use NodeNext module resolution
- Return type for splitArray function
- formatString interpolation formatting
- Debounce implementation replaced with simpler version
- isEmpty empty object check
- isBrowser detection check
- isNumeric invalid check
- Invalid Date check in isDate
- Undefined checking in camelCase
- Code quality issues across multiple files
- Dependency version alignment across packages
- Package version inconsistencies
- Jest configuration timeout settings

## Removed
- Unused ESLint dependencies
- RBAC (Role-Based Access Control) functionality
- Call signing and related cryptographic features
- Deprecated MicroTemplate code
- Old v3 packages before v4 rewrite
- CHANGELOG.md files from individual packages


## [5.31.0] - 2026-02-11

### Added
- Add comprehensive test coverage for utility functions (isBoolean, isNumeric, isString)
- Add test suites for isNullOrUndef and wrapInArray functions with 33+ tests each
- Add .npmignore files to all public packages
- Add CRC32 hash function
- Add MD5 hash implementation
- Add micro templating functionality (MicroTemplate.ts)
- Add splitArray utility function
- Add attempt function for error handling
- Add formatString for string interpolation (replacing applyVariables)
- Add generic error parser
- Add sortObjectArray utility
- Add isPromise utility function
- Add empty object check to numObjectProperties
- Add arrayFilter utility function
- Add valueIf utility with custom check support
- Add filterObject utility function
- Add isEmpty method
- Add indexObject utility function
- Add collection utilities (find functions)
- Add base64 encoding/decoding methods

### Changed
- Migrate entire monorepo to ESM with NodeNext module resolution
- Update all imports to use explicit .js extensions for ESM compatibility
- Upgrade vitest to ^4.0.18 across all packages
- Align @types/node to ^22.0.0 everywhere
- Align typescript devDep to ^5.9.2
- Refactor logger for streaming in docker environments
- Update return type for splitArray
- Enhance valueIf with custom check capability
- Improve isEmpty checking for arrays types
- Update formatString formatting implementation
- Simplify debounce implementation

### Fixed
- Phase 4-6: version alignment, code quality, and architecture fixes
- Address report issues: dependency and file cleanup (Phases 1-3)
- Move typescript from deps to devDeps (6 packages)
- Move/remove prettier from deps (4 packages)
- Move @types packages to devDeps (postgresql, codegen, webafx)
- Resolve ESM import issues with .js extensions
- Fix TypeScript configuration to use NodeNext module resolution
- Fix undefined checking in camelCase
- Fix splitArray return type
- Fix formatString interpolation testing
- Fix empty object handling in numObjectProperties
- Fix invalid check in isNumeric
- Fix isBrowser detection check
- Fix Invalid Date checking in isDate
- Fix deepcopy to check for undefined
- Fix Jest configuration timeout settings

### Removed
- Remove unused ESLint dependencies
- Remove RBAC functionality
- Remove signing feature from crypto package
- Remove deprecated MicroTemplate code
