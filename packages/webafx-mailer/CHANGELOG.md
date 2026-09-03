# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package dependencies in `webafx-mailer/package.json` for improved performance and compatibility.


## [5.50.0] - 2026-07-31

Added: Implemented new email sending plugin for WebAFX with SMTP and In-Memory backends.  
Added: More SMTP options included in Mailer.  
Added: AI training documentation for webafx-mailer covering various topics including usage and best practices.  
Changed: Upgraded monorepo dependencies and updated TypeScript to version 7.  
Changed: Consolidated all packages into a single 'blendsdk' npm package with subpath exports.  
Fixed: Updated packages and removed deprecated code.  
Fixed: Refactored serverside error handling for better logging.  
Fixed: Updated logger to produce targetten logs for better traceability.  
Fixed: Reverted axios due to compatibility issues with React 18.


## [5.49.0] - 2026-07-31

Added: New email sending plugin for WebAFX with SMTP and In-Memory backends, including a MailProvider abstract base class.  
Added: ai-training documentation folder with multiple structured documents for usage and best practices.  
Changed: Implemented single-package distribution for all @blendsdk/* packages into a single 'blendsdk' npm package.  
Changed: Updated SMTP options in the Mailer module for enhanced functionality.  
Fixed: Resolved various issues in automated tests and package dependencies.  
Fixed: Updated logger to produce more comprehensive target logs.  
Removed: Deprecated code removed during package updates.  
Security: Upgraded libraries and patched known vulnerabilities across packages.


## [5.48.0] - 2026-06-14

## Added
- Implemented a new email sending plugin for WebAFX with SMTP and In-Memory backends.

## Changed
- Updated the `ai-training` documentation with additional sections for examples and best practices.
- Enhanced the SMTP configuration options in the Mailer to include more parameters.

## Fixed
- Resolved typing issues for various components within the mailer package.
- Updated tests to better align with the current structure and functionality after recent changes.


## [5.47.0] - 2026-05-22

## [Unreleased]
### Added
- Implemented @blendsdk/webafx-mailer package, a new email sending plugin for WebAFX with SMTP and In-Memory backends.
- Added more SMTP options in Mailer implementation.

### Changed
- Updated ai-training documentation in the webafx-mailer package, covering new usage patterns and best practices.

### Fixed
- Refactored SMTP mail provider tests for reliability.
- Fixed import issues in the modules due to updated package infrastructure.

### Removed
- Removed deprecated code in multiple packages as part of the clean-up process.


## [5.46.0] - 2026-05-21

## Added
- Implemented a new email sending plugin for WebAFX with SMTP and In-Memory backends.
- Added ai-training documentation with multiple new articles covering usage, advanced patterns, and best practices.

## Changed
- Updated documentation and README files across multiple packages.
- Implemented public mirror infrastructure for package configuration.

## Fixed
- Added more SMTP options for better mail configuration.
- Refactored serverside error handling for improved stability.

## Removed
- Removed unused packages to reduce bloat and improve performance.


## [5.45.0] - 2026-05-21

## Added
- Implemented @blendsdk/webafx-mailer package with SMTP and In-Memory backends.
- Added MailProvider abstract base class with send/health/shutdown contract.
- Added new documentation for ai-training, covering various scenarios and API references.

## Changed
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated README and CHANGELOG for @blendsdk/webafx-mailer to reflect new features and usage examples.
- Improved tests for the smtp-mail-provider with additional assertions.

## Fixed
- Added additional SMTP options for enhanced customization within the mailer.
- Fixed formatting issues and updated missing types in various code files.
- Resolved errors related to dependency versions and improved package compatibility.


## [5.44.1] - 2026-05-20

Added: Implemented a new email sending plugin for WebAFX with SMTP and In-Memory backends, including a MailProvider abstract base class.  
Added: Documentation for ai-training, covering an overview, core concepts, basic usage, advanced patterns, best practices, common scenarios, testing patterns, troubleshooting, API reference, and examples library.  
Changed: The WebAFX mailer now supports more SMTP options for enhanced configuration.  
Fixed: Updated types and format in several core files to improve type checking and standardization.  
Fixed: Resolved issues with the logger to produce targetten logs.  
Fixed: Corrected configurations and added additional Jest options to increase timeout limits for tests.  
Fixed: Reverted axios updates due to compatibility issues with React 18.  
Removed: Deprecated code from previous versions, ensuring cleaner and more efficient functionality.


## [5.44.0] - 2026-05-20

Added: Implemented @blendsdk/webafx-mailer package with SMTP and In-Memory backends.  
Added: Enhanced ai-training documentation including examples library.  
Changed: Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Changed: Updated multiple documentation files for clarity and organization.  
Fixed: Added more SMTP options to improve email configuration flexibility.  
Fixed: Resolved issues with Jest configuration across multiple packages.  
Fixed: Refactored serverside error handling for improved reliability.  
Fixed: Updated types and formatting in various package code files.  
Fixed: Corrected errors in the mailer tests to enhance test reliability.  
Fixed: Upgraded dependencies and fixed related package issues.


## [5.43.1] - 2026-05-20

Added: Implemented @blendsdk/webafx-mailer package providing SMTP and In-Memory email sending capabilities.  
Added: AI-training documentation with structured guides covering overview, concepts, usage, patterns, and API reference.  
Changed: Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Fixed: Added more SMTP options for configuring the Mailer.  
Fixed: Updated logger to produce targetten logs, improving error handling and traceability.  
Fixed: Resolved issues with email plugin tests to ensure reliability.  
Fixed: Updated remaining packages to their latest versions.


## [5.43.0] - 2026-05-19

### Added
- Implemented `@blendsdk/webafx-mailer` package, an email sending plugin with SMTP and In-Memory backends.
- Added comprehensive AI training documentation for the `webafx-mailer` package.

### Changed
- Consolidated all sub-packages under `@blendsdk/*` into a single 'blendsdk' npm package with subpath exports.
- Introduced additional configuration options, including more SMTP options for enhanced flexibility in `webafx-mailer`.

### Fixed
- Updated tests to ensure compatibility and functionality of new features.
- Corrected bugs related to email processing in the `webafx-mailer`, including issues with SMTP setups.

### Removed
- Deprecated and unused code segments to streamline functionality and reduce complexity within the `webafx-mailer`.


## [5.42.0] - 2026-05-18

Added: Implemented a new email sending plugin for WebAFX with SMTP and In-Memory backends, including an abstract MailProvider base class.  
Added: Extensive documentation for ai-training covering concepts, usage, patterns, and API reference for the WebAFX mailer package.  
Changed: Consolidated multiple @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.  
Fixed: Added more SMTP options to the Mailer class to enhance email sending capabilities.  
Fixed: Corrected various issues with test configurations and package dependencies.  
Removed: Deprecated code has been removed in preparation for the next major release.  
Removed: Unused packages cleaned up from the project to streamline the codebase.


## [5.41.0] - 2026-05-17

Added: New email sending plugin for WebAFX with SMTP and In-Memory backends, following the same architecture as @blendsdk/webafx-cache.  
Added: AI training documentation with structured guides including usage patterns and API reference.  
Fixed: Updated Mailer to add additional SMTP options.  
Fixed: Reverted axios changes due to compatibility issues with React 18.  
Fixed: Refactored server-side error handling.  
Fixed: Updated logger to produce targetten logs.  
Removed: Fluent UI package due to issues with React 18 compatibility.  
Changed: Consolidated all @blendsdk packages into a single 'blendsdk' npm package with appropriate subpath exports.


## [5.40.0] - 2026-05-17

- Added: New email sending plugin for WebAFX with SMTP and In-Memory backends, including MailProvider abstract class.
- Added: AI training documentation with structured guides and best practices for using the WebAFX Mailer.
- Changed: Implemented single-package distribution for blendsdk packages with subpath exports.
- Fixed: Added more SMTP options to enhance email sending capabilities.
- Fixed: Updated logger to produce targetten logs for better debugging.


## [5.39.0] - 2026-05-07

### Added
- Implemented a new email sending plugin for WebAFX with SMTP and In-Memory backends, including the MailProvider abstract base class.  
- Added AI training documentation covering overview, core concepts, basic usage, advanced patterns, best practices, common scenarios, testing patterns, troubleshooting, and API reference.

### Changed
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated README and related documentation for the new AI training folder structure.

### Fixed
- Addressed missing SMTP options in the Mailer.
- Enhanced error handling and server-side error management in related components.
- Refactored unit tests to improve stability and coverage across modules.


## [5.38.0] - 2026-04-13

## Added
- Implemented @blendsdk/webafx-mailer package, a new email sending plugin for WebAFX with SMTP and In-Memory backends.
- Added new ai-training documentation with structured guides and examples for MailProvider.

## Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

## Fixed
- Updated SMTP options in the Mailer for enhanced configuration support.
- Fixed various tests within the webafx-mailer, including email-related functionalities.


## [5.37.0] - 2026-03-23

### Added
- Implemented @blendsdk/webafx-mailer package for email sending with SMTP and In-Memory backends.
- Added new ai-training documentation in the webafx-mailer package with various topics.

### Changed
- Implemented single-package distribution by consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated README and documentation in the webafx-mailer package for clarity and complete coverage.

### Fixed
- Resolved issues in SMTP mail provider tests to ensure reliability.
- Added missing SMTP options in Mailer module.
- Updated packages and fixed dependency errors across several modules.

### Removed
- Deprecated certain code and removed related dependency packages from the project.


## [5.36.0] - 2026-03-23

Added:
- Added ai-training documentation with 11 structured docs covering usage, concepts, and API reference for the mailer package.

Changed:
- Implemented single-package distribution consolidating all `@blendsdk/*` packages into a single 'blendsdk' npm package with subpath exports.
- Enhanced `@blendsdk/webafx-mailer` with additional SMTP options for more flexible email configurations.

Fixed:
- Fixed various tests in the `@blendsdk/webafx-mailer` package to ensure consistent behavior.
- Resolved issue where non-GET requests would not correctly handle query parameters. 
- Updated logger to produce targetten logs for better debugging and traceability.


## [5.35.0] - 2026-03-20

## Added
- Implemented public mirror infrastructure (Phases 1-3).
- Introduced `@blendsdk/webafx-mailer` package with email sending capabilities including SMTP and In-Memory backends.

## Changed
- Consolidated all `@blendsdk/*` packages into a single `blendsdk` npm package with subpath exports.
- Added more SMTP options to `@blendsdk/webafx-mailer`.

## Fixed
- Resolved multiple test issues in the `webafx-mailer` tests.
- Refactored the server-side error handling in the application.
- Updated logger to produce targetten logs for better debugging.
- Fixed formatting and type definitions across various modules.

## Removed
- Removed the `fluentui` package temporarily due to compatibility issues with React 18.
- Deleted old and unused packages to clean up the codebase.
