# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json to reflect new version 5.51.1 and dependencies for webafx.


## [5.50.0] - 2026-07-31

### Changed
- Upgraded TypeScript to version 7 and refreshed external dependencies across the monorepo.
- Added a new `terminal` hook to the Plugin interface for fallback middleware.

### Added
- Introduced `staticFilesPlugin` for serving static files with configurable options and SPA fallback capabilities.
- Created comprehensive AI training material in the form of documents for various AI training topics.

### Fixed
- Resolved TypeScript build errors related to CORS configuration.
- Fixed validation issues for CORS middleware to correctly handle string origins.
- Corrected failing tests related to middleware and parameter handling.

### Security
- Added support for helmet security headers, including X-Content-Type-Options and Strict-Transport-Security.
- Implemented rate limiting middleware to enhance security measures in the application.


## [5.49.0] - 2026-07-31

### Added
- Introduced an optional `terminal` hook to the Plugin interface for middleware management.
- Added `staticFilesPlugin` for serving static files and SPA fallback with configuration options.
- Added comprehensive AI training material for LLMs in the `packages/webafx/ai-training` directory.
- Implemented single-package distribution, consolidating all `@blendsdk/*` packages into a single `blendsdk` npm package.
- Added OpenAPI metadata support to `RouteBuilder` with new interfaces and fluent methods.

### Changed
- Refactored `start()` method to use clean async/await pattern.
- Improved dependency injection and error handling across the framework.
- Refactored logging system and enhanced console logging capabilities.

### Fixed
- Fixed CORS middleware behavior to validate request origins correctly.
- Resolved TypeScript build errors related to CORS origin configuration.
- Fixed several bugs related to request parameter handling and validation across different modules.
- Corrected service container lifecycle issues and improved application stability during shutdown.

### Security
- Completed security hardening efforts, including the addition of helmet security headers and a rate limiting middleware.


## [5.48.0] - 2026-06-14

- Added an optional `terminal` hook to the Plugin interface for fallback middleware support.
- Added `staticFilesPlugin` for serving static files and SPA fallback capabilities.
- Implemented a comprehensive logging system with configuration management enhancements across the framework.
- Implemented single-package distribution to consolidate all @blendsdk/* packages into one.
- Implemented OpenAPI metadata support to RouteBuilder with new interfaces and methods.
- Implemented rate limiting middleware with configurable limits for enhanced security.
- Fixed CORS middleware to validate request origins properly when a single string is configured.
- Fixed TypeScript build errors stemming from CORS origin callback modifications.
- Fixed various tests related to CORS and plugin registration to match updated method signatures and expected behaviors.
- Fixed several critical bugs impacting the HTTP routing and request handling logic.


## [5.47.0] - 2026-05-22

### Changed
- Consolidated all 12 @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

### Added
- New staticFilesPlugin() with typed StaticFilesConfig interface for serving static files and SPA fallback.
- Added extensive JSDoc documentation to ConfigService class and related interfaces for improved developer experience.
- Implemented Redis connection readiness with configurable timeout to ensure reliable plugin initialization.
- Added OpenAPI metadata support to RouteBuilder with new interfaces and methods for improved API documentation generation.
- Enhanced logging system and improved application configuration management across the WebAFX framework.

### Fixed
- Fixed CORS middleware to properly validate request origins when a single string is configured.
- Updated CorsConfig interface to accept origin parameter as string | undefined, fixing TypeScript build errors.
- Fixed the registerController() argument order across all CORS tests.
- Updated logging configurations and fixed incorrect behavior related to logging levels.
- Resolved critical issues with middleware responses and improved error handling across the framework.

### Security
- Added helmet security headers and implemented rate limiting middleware with configurable limits for enhanced application security.


## [5.46.0] - 2026-05-21

Added:
  - New staticFilesPlugin() with typed StaticFilesConfig interface to serve static files and enable SPA fallback mode.
  - Comprehensive AI training material for LLMs with structured documents.
  - Phase 1 demo application and documentation for REST API features.

Changed:
  - Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
  - Refactored application architecture to enhance logging, configuration management, and error handling.

Fixed:
  - Fixed CORS middleware to validate request origins when a single string is configured.
  - Resolved TypeScript build errors due to updated CorsConfig interface.
  - Corrected inaccuracies in tests related to CORS and controller arguments.

Security:
  - Implemented security hardening measures including helmet security headers and rate limiting middleware.


## [5.45.0] - 2026-05-21

## Changed
- Refactored middleware and routing for improved handling in WebAFX framework.
- Enhanced request validation and parameter handling for better type safety.

## Added
- Introduced staticFilesPlugin for serving static files and SPA fallback in WebAFX framework.
- Included comprehensive AI training material to enhance user understanding.

## Fixed
- Resolved CORS origin validation issue with string configuration.
- Fixed TypeScript build errors related to the CORS origin callback.

## Security
- Implemented security hardening measures including helmet security headers and rate limiting middleware.


## [5.44.1] - 2026-05-20

## Added
- Add staticFilesPlugin for serving static files and SPA fallback.
- Create robust logging system with logger service and dynamic configurations.
- Load multiple config files for flexible application setup.

## Changed
- Refactor token validation and introduce new authentication flow.
- Improve the request validation and parameter handling system for better type safety.

## Fixed
- Fix issues with CORS origin validation and configuration, improving middleware functionality.
- Fix TypeScript build errors related to CORS origin callback.
- Fix crashing scenarios for missing translation files during runtime.

## Deprecated
- Mark old CORS handling methods as deprecated in favor of new configurations.

## Security
- Implement security header configurations using helmet for enhanced application security.
- Fix vulnerabilities by updating package dependencies and eliminating deprecated functions.


## [5.44.0] - 2026-05-20

### Added
- Implemented staticFilesPlugin for serving static files and SPA fallback mode.
- Added comprehensive AI training material for LLMs with structured training documents.
- Added logger improvements and observability features, enhancing the console logger.
- Implemented session-level middleware support and standardized error response format.

### Changed
- Updated documentation across multiple modules for clarity and consistency.
- Refactored the routing and error handling modules for improved structure and reliability.
- Improved logging system to capture detailed context information.

### Fixed
- Resolved critical CORS origin validation issues.
- Fixed TypeScript build errors and ensured compatibility with latest libraries.
- Addressed various bugs regarding request handling and context management.
- Corrected issues with token authentication and parameters processing.

### Security
- Enhanced security by introducing helmet headers and implementing robust logging of sensitive operations.


## [5.43.1] - 2026-05-20

### Added
- Implemented staticFilesPlugin for serving static files and SPA fallback.

### Changed
- Improved logging system with new custom logger features and configurations.
- Refactored application settings to use more streamlined configuration loading.

### Fixed
- Fixed CORS origin validation with string configuration.
- Addressed TypeScript build errors in CORS origin callback.
- Corrected errors in how request parameters are parsed and validated.

### Deprecated
- Deprecated custom CORS implementation in favor of `cors` package. 

### Removed
- Removed deprecated files and modules from the project structure. 

### Security
- Added security headers for enhanced application security using helmet. 
- Implemented rate limiting middleware to prevent abuse of routes.


## [5.43.0] - 2026-05-19

- Added `staticFilesPlugin` for serving static files and SPA fallback, with a typed `StaticFilesConfig` interface.
- Implemented single-package distribution, consolidating all `@blendsdk/*` packages into a single `blendsdk` npm package with subpath exports.
- Enhanced request validation and parameter handling for better type safety and prevention of runtime errors.
- Added middleware for session management, including session priority handling.
- Improved logger functionality by implementing logger improvements and observability features.
- Added CORS middleware that validates request origins correctly and improved handling of CORS settings.
- Introduced OpenAPI metadata support to `RouteBuilder` with new interfaces for route definitions.
- Fixed CORS origin validation with string configuration, ensuring proper request origins are validated.
- Fixed TypeScript errors and updated interfaces for better compatibility with the `cors` package.
- Updated multiple packages to their latest versions to enhance overall stability and security.
- Improved overall documentation, including adding comprehensive AI training material for LLMs and detailed usage guides.
- Added Redis connection readiness checking in the Cache Plugin to prevent race conditions and ensure reliable plugin initialization.


## [5.42.0] - 2026-05-18

### Added
- New staticFilesPlugin() with typed StaticFilesConfig interface for serving static files and SPA fallback.

### Changed
- Implemented logging system improvements and updated error handling across WebAFX framework.
- Refactored service container to eliminate global state and enhance lifecycle management.

### Fixed
- Fixed CORS middleware to properly validate request origins for single string configuration.
- Updated logging configurations to produce accurate log outputs.

### Removed
- Removed deprecated code related to older authentication mechanisms.


## [5.41.0] - 2026-05-17

### Added
- Added staticFilesPlugin for serving static files and SPA fallback with typed StaticFilesConfig interface.
- Phase 1 - Demo Application created full REST API demo app in packages/playground/src/demo-app/.
- Implemented single-package distribution to consolidate all packages into a single npm package with subpath exports.
- Added OpenAPI metadata support to RouteBuilder with new interfaces and methods.
- Added Redis pub/sub integration and contract tests for better coverage.
- Added logger improvements and observability features to enhance logging across the framework.

### Changed
- Refactored the start() method to use a clean async/await pattern.
- Improved error handling and standardized error response format across the framework.
- Updated dependency versions across several packages for improved stability.
- Configuration management enhancements implemented for better developer experience.

### Fixed
- Fixed CORS middleware to properly validate request origins when a single string is configured.
- Corrected TypeScript build errors by updating CorsConfig interface.
- Addressed various issues in routing and parameter handling across different modules.
- Fixed failing tests to match current implementation behavior and improve test coverage.
- Updated logging to ensure correct information is captured and displayed.

### Security
- Implemented security improvements with helmet to add security headers and created rate limiting middleware.


## [5.40.0] - 2026-05-17

### Added
- Added staticFilesPlugin for serving static files and SPA fallback.
- Implemented single-package distribution for all @blendsdk/* packages.
- Implemented public mirror infrastructure for package publishing.
- Added OpenAPI metadata support to RouteBuilder.
- Added logger improvements and observability features.
- Added middleware & routing enhancements.

### Changed
- Consolidated all related functionality into the `webafx` package structure.
- Updated package versions and dependencies across modules.

### Fixed
- Fixed critical bugs related to CORS origin validation and handling.
- Resolved TypeScript build errors in CORS origin callback.
- Fixed route-level parameter handling in Application.
- Fixed various tests to reflect actual implementations.

### Security
- Completed Phase 6 security hardening with helmet integration for security headers and configurable rate limiting middleware.


## [5.39.0] - 2026-05-07

### Added
- Add staticFilesPlugin for serving static files and SPA fallback.
- Implement single-package distribution by consolidating all 12 @blendsdk/* packages into a single 'blendsdk' npm package.
- Implement public mirror infrastructure with package configuration updates.
- Add OpenAPI metadata support to RouteBuilder, including interfaces and fluent method.
- Added demo application and comprehensive documentation with REST API examples.
- Add logger improvements and observability features to enhance logging system.

### Changed
- Consolidate and refactor the code base to use modern asynchronous patterns.
- Improved the overall architecture with service dependency injection, enabling better modularity.
- Refactored start method in WebAfx to use async/await for improved readability.
- Updated README files for clear usage guidelines, including more comprehensive AI training materials for LLMs.
- Updated error response formatting and improved global request handling across the framework.

### Fixed
- Fix CORS middleware to properly validate request origins when a single string is configured.
- Address critical bug in CORS origin validation with updated parameters.
- Fix TypeScript build error in CORS origin callback.
- Correct failing tests in CORS and plugin integrations to reflect accurate implementations.
- Fixed issue related to missing properties and types across various modules, enhancing type safety.
- Fixed logging to ensure targetted logging and disable unnecessary verbosity.
- Resolve router registration and request parameter parsing issues to reduce errors during runtime.
- Cleanup dead code and deprecated functionality across various components.

### Security
- Complete Phase 6 security hardening by integrating helmet security headers and creating rate limiting middleware.


## [5.38.0] - 2026-04-13

### Added
- Added staticFilesPlugin for serving static files and SPA fallback with typed StaticFilesConfig interface.

### Changed
- restructured the routing system to allow for better handling and validation.
- improved the logging system to enhance observability features.

### Fixed
- Fixed CORS origin validation with string configuration to properly validate request origins.
- Fixed TypeScript build error in CORS origin callback.
- Fixed failing CORS and plugin tests to match expected behavior.
- Fixed critical bugs related to logging and application configuration.
- Fixed the response format from route handlers for better error handling.

### Security
- Implemented security hardening by adding helmet headers and a rate-limiting middleware.


## [5.37.0] - 2026-03-23

### Added
- Implement single-package distribution by consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Implement public mirror infrastructure with updated repository URL and publish configuration for public access.
- Add Redis pub/sub integration and contract tests for comprehensive validation.
- Add OpenAPI metadata support to RouteBuilder with new interfaces and methods.
- Add comprehensive AI training material, including structured documents and usage guides.
- Create a demo application with full REST API capabilities and comprehensive documentation.
- Introduce middleware & routing improvements, allowing for improved error handling and configuration.
- Add a new logger and observability features to enhance logging capabilities.

### Changed
- Remove access to the project-specific CORS configuration settings, instead replacing with standard settings.
- Refactor start() method to adopt a clean async/await pattern for improved readability.

### Fixed
- Fix CORS middleware to validate request origins correctly when a single string is configured.
- Address TypeScript build errors in the application by updating CorsConfig interface to match the new typings.
- Fix the order of arguments in registerController() method for all CORS tests.
- Resolve critical bug with ConsoleLogger not adhering to the correct logging level and ensure INFO no longer logs unnecessarily.
- Fix various TypeScript errors and inconsistencies across packages.

### Security
- Complete Phase 6 security hardening, including adding helmet security headers and revising rate-limiting middleware for enhanced security.

### Deprecated
- The previous multi-package distribution method in favor of a simplified single-package structure.

### Removed
- Deprecate older versions of the Zen project management tools and documentation files no longer in use.


## [5.36.0] - 2026-03-23

### Added
- Implemented single-package distribution for consolidation of all `@blendsdk/*` packages into a single `blendsdk` npm package.
- Added OpenAPI metadata support to RouteBuilder, including new interfaces and methods.
- Added extensive AI training material in `packages/webafx/ai-training/`.
- Added comprehensive REST API demo application in `packages/playground/src/demo-app/`.

### Changed
- Updated root package.json repository URL to point to the new GitHub location.
- Refactored start() method to utilize async/await pattern for improved clarity.
- Enhanced existing middleware and routing for better error response formatting.

### Fixed
- Fixed CORS origin validation when configured with a single string in the middleware.
- Resolved TypeScript build errors related to CORS origin callback's type signature.
- Fixed failing tests related to CORS and plugin registration.

### Security
- Added security hardening measures including helmet security headers and configurable rate limiting middleware.


## [5.35.0] - 2026-03-20

### Added
- Implement single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Implement public mirror infrastructure, updating repository URL and publish configuration for all packages.
- Add OpenAPI metadata support to RouteBuilder.
- Create full REST API demo app in playground with JWT auth and caching examples.
- Add Redis pub/sub integration and contract tests.
- Enhance logging system and improve application configuration management.
- Add logger improvements and observability features, allowing log level configuration.

### Changed
- Refactored and improved various internal components for better maintainability and readability.
- Updated CORS origin validation and refined related middleware behavior.
- Addressed numerous package dependency upgrades and version alignments across the application.

### Fixed
- Fixed CORS middleware to validate request origins with string configuration.
- Resolved TypeScript build errors in the CORS origin callback.
- Corrected multiple issues impacting unit and integration test results related to routing and middleware functionality.
- Updated the logger to prevent unwanted logs when not configured for it.
- Allow deep i18n file searching and fixed potential issues when loading them.
- Fixed invalid cookie signing and adjusted several related functionalities.

### Deprecated
- Pending additional refactoring, certain interfaces and utilities may be marked deprecated in future releases.

### Removed
- Removed outdated and deprecated files as part of ongoing cleanup efforts.


## [5.32.0] - 2026-02-11

### Changed
- Version bump to 5.32.0


## [5.31.0] - 2026-02-11

## Added

- Comprehensive AI training documentation for LLMs with 11 structured guides covering framework architecture, core concepts, usage patterns, best practices, and API reference
- Full REST API demo application in playground package with database schema, types, service layer, JWT auth, cache, metrics, and validation examples
- Security hardening with Helmet headers (X-Content-Type-Options, Strict-Transport-Security) and configurable rate limiting middleware with custom key extractors
- Route-level middleware support via `.middleware()` method on RouteBuilder
- Standardized error response format (StandardErrorResponse) with consistent structure across all error handlers
- Request ID middleware for request tracking and correlation
- Structured logger with JSON output support for production environments
- Log level filtering and configuration via constructor parameters
- Request context with service container access and request-scoped services
- Disposal lifecycle support for service cleanup on application shutdown
- Zod-based configuration validation with detailed error messages
- Plugin priority system with ordered initialization and lifecycle hooks
- Service disposal pattern for graceful shutdown with timeout handling
- Express getter method for direct access to underlying Express application
- Comprehensive test coverage with 398+ passing tests across all modules
- Demo application README with setup instructions and API documentation

## Changed

- Refactored `start()` method to use clean async/await pattern for improved error handling
- Improved controller dependency injection by passing ServiceContainer as constructor parameter
- Enhanced logging system with proper level filtering and targeted log output
- Replaced custom CORS implementation with industry-standard `cors` package
- ServiceContainer now instance-owned by WebApplication instead of global state
- ConsoleLogger now accepts log level via constructor parameter instead of hardcoded INFO
- Updated BaseController constructor to accept ServiceContainer parameter
- Modified ControllerRegistry to use new constructor signature with ServiceContainer
- Moved tests from src/tests/ to tests/ directory for standardized project structure
- Aligned dependency versions across packages (vitest ^4.0.18, @types/node ^22.0.0, typescript ^5.9.2)
- Rewritten README with accurate production-ready documentation and clear API examples
- Updated logger to produce targeted logs instead of generic application logs

## Fixed

- CORS middleware now properly validates request origins when single string is configured
- Fixed CORS origin callback TypeScript signature to match cors package's CustomOrigin type
- Fixed signal handlers with proper cleanup on shutdown and connection draining
- Corrected ConsoleLogger shouldLog bug where INFO always logged regardless of configured level
- Fixed TypeScript build errors in CORS configuration interface
- Fixed registerController() argument order in CORS tests (now: `app.registerController('/', TestController)`)
- Fixed plugin test to use `super.onConfigure()` instead of deprecated methods
- Fixed request origin validation for "local" development environments
- Fixed zero value handling in request parameters
- Fixed invalid cookie signing and TOKEN_KEY handling
- Fixed nested authenticated user object structure
- Fixed parsing of number parameters in route handlers
- Fixed helmet nocache module deprecation
- Fixed duplicate schema loading in RouteBuilder
- Fixed backend translation locale detection
- Fixed Winston file logger initialization
- Addressed multiple code quality issues including unused ESLint dependencies and incorrect devDependencies placement

## Security

- Added Helmet security headers for enhanced HTTP security posture
- Implemented rate limiting to prevent abuse and DoS attacks
- Added signed cookie support for session security
- Enhanced token validation with proper error codes for invalid tokens
