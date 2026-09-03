# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json to reflect new dependencies and versioning.


## [5.50.0] - 2026-07-31

### Changed
- Upgraded TypeScript to version 7 and refreshed all monorepo dependencies.
- Updated the i18n plugin to register a new service `i18n:reload`, enhancing its capabilities.

### Added
- Introduced ai-training documentation with comprehensive guides and examples for the i18n plugin.
- Added `onMissingTranslation` provider to improve translation handling.

### Fixed
- Resolved various issues in the i18n module, including improper cookie settings and invalid imports.
- Fixed bugs affecting locale parsing and dynamic loading of translations.

### Security
- Improved handling of sensitive data in i18n endpoints to adhere to security best practices.


## [5.49.0] - 2026-07-31

Added: Added i18n:reload service registration and tests, enhancing the i18n plugin by adding a new reload capability.
Changed: Refactored i18n endpoints to support large content loading and improved performance with new translation settings.
Fixed: Resolved issues with translations not loading properly due to incorrect imports; improved error handling in the i18n module.
Fixed: Updated logger to produce targetten logs, ensuring better tracking of localization issues in client apps.


## [5.48.0] - 2026-06-14

Added:
- Added i18n:reload service registration and tests to the i18n plugin.

Changed:
- Updated tests to verify that the i18n plugin now registers three services (i18n, i18n:reload, and locale).
- Refactored i18n module to improve loading mechanisms and added support for large content.

Fixed:
- Fixed issues with optional userLocale functionality in the i18n plugin.
- Resolved invalid imports and refactored the Translator class.
- Added translations DB backend and implemented i18n routes.
- Fixed cookie setting in the i18n module to ensure proper handling.
- Addressed various bugs related to module loading and cleanup across i18n-related packages.


## [5.47.0] - 2026-05-22

Added:
- Added i18n:reload service registration and tests to the i18n plugin.

Changed:
- Updated tests to verify that the i18n plugin now registers three services (i18n, i18n:reload, and locale).

Fixed:
- Fixed invalid imports in the I18n module.
- Simplified loading logic in the I18n module to ensure efficiency.
- Updated missing tests to improve coverage for the i18n plugin functionality. 
- Fixed cookie setting in the I18n module to enhance compatibility with authentication flows.
- Fixed savepoint in i18n loader to handle dynamic localization more effectively.
- Corrected the issue with the translations DB backend not loading properly.


## [5.46.0] - 2026-05-21

Added:
- Added i18n:reload service registration to the i18n plugin, increasing service count to three.

Changed:
- Updated all MCP package documentation to reflect the latest version and restructure changelog entries.
- Refactored tests to normalize locale handling and improve coverage across i18n-related functionalities.

Fixed:
- Fixed issues with missing locale translations and types in the i18n module.
- Resolved several invalid imports and jest configuration issues affecting the i18n package.
- Fixed the incorrect handling of endpoint signing in the i18n service.

Removed:
- Removed redundant code for handling legacy i18n functionality which no longer applies.


## [5.45.0] - 2026-05-21

Changed: Updated i18n plugin to register three services (i18n, i18n:reload, and locale) instead of two.  
Added: Introduced a new service registration method for i18n:reload.  
Fixed: Corrected handling of overwriting i18Ns when dynamically loading.  
Fixed: Addressed various issues related to package imports and configurations.  
Fixed: Resolved a problem with invalid imports and streamline i18n endpoint functionality.  
Fixed: Added translations database backend and implemented i18n routes successfully.


## [5.44.1] - 2026-05-20

Added:
- Introduced `i18n:reload` service registration and accompanying tests to enhance i18n plugin functionality.

Changed:
- Updated documentation across all packages to improve clarity and structure, including AI training resources for webafx-i18n.

Fixed:
- Resolved issues with locale parsing to prevent undefined values in `getLocaleFromRequest`.
- Fixed cookie handling in the i18n module to ensure correct settings.
- Implemented updated translation loading mechanisms to handle large content appropriately.
- Refactored the i18n routes for improved clarity and functionality.


## [5.44.0] - 2026-05-20

- Added i18n:reload service registration to the i18n plugin, expanding service capabilities.
- Changed documentation structure to follow Keep a Changelog format across all packages.
- Fixed issues with the i18n module, including endpoint handling and translation features.
- Fixed invalid imports in the i18n module. 
- Fixed cookie setting in the i18n module.
- Fixed savepoint translation settings for enhanced session handling.


## [5.43.1] - 2026-05-20

Changed: Restructured AI training documentation for better clarity and organization across multiple topics.  
Added: Implemented i18n:reload service registration in the i18n plugin, enhancing dynamic locale reloading capabilities.  
Fixed: Addressed issues with locale handling and translation loading, including removing unsupported features and ensuring proper functioning with new interface adjustments.  
Fixed: Updated tests for i18n plugin to verify registration of new services and improved reliability.  
Fixed: Enhanced compatibility with React 18 and rectified dependency management for compliance with newer versions.


## [5.43.0] - 2026-05-19

### Added
- Add i18n:reload service registration and tests to the i18n plugin, offering a new reload capability.

### Changed
- Updated documentation and references across various packages to reflect structure and format changes.

### Fixed
- Fix incorrect handling of locales by normalizing getLocaleFromRequest.
- Allow overwriting i18Ns when dynamically loading.
- Modify endpoints to be unsigned for i18n capabilities. 
- Implemented missing translation provider, enhancing the i18n service functionalities. 
- Fixed invalid imports in the i18N module.


## [5.42.0] - 2026-05-18

Added:
- Implemented i18n:reload service registration in the i18n plugin.

Changed:
- Updated i18n plugin to register three services now, reflecting new reload capability.
- Refactored i18n endpoints to remove signing feature, enhancing security.

Fixed:
- Resolved issue with dynamic loading of i18n plugins allowing overwriting.
- Fixed cookie setting to ensure proper translations.
- Addressed various bugs related to translations and locale handling in the i18n module.


## [5.41.0] - 2026-05-17

## [Unreleased]

### Added
- Add `i18n:reload` service registration to the i18n plugin, including tests.

### Changed
- Updated MCP documentation to reflect the 5.40.0 release and restructure changelog entries across all packages.
- Implemented single-package distribution consolidating all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.

### Fixed
- Updated the i18n module to handle dynamic loading and fixed locale parsing issues.
- Fixed invalid imports in the i18n module and added support for translations backend in the test application. 
- Refactored i18n endpoints to ensure smoother operations and enhanced performance.
- Fixed issues related to cookie settings and ensured the handling of translation settings.


## [5.40.0] - 2026-05-17

Added:
- Added ai-training documentation for i18n functionalities with multiple structured docs.
- Added translations db backend to support dynamic loading of translation files.

Changed:
- Implemented single-package distribution to consolidate multiple packages under a single 'blendsdk' npm package.
- Renamed the Translation class to Translator for clarity.

Fixed:
- Fixed invalid imports in the i18N module to ensure proper functionality.
- Refactored and simplified i18n endpoints for improved performance and usability.
- Updated logger to produce target tenant logs correctly.
- Fixed cookie setting in i18N module for better user experience.
- Improved locale parsing to skip undefined values and enhance robustness.
- Implemented handling for large content loading in the i18n module.

Removed:
- Removed unused variables and optimized types for clarity and efficiency.


## [5.39.0] - 2026-05-07

Added: Introduced ai-training documentation with structured guides on usage and best practices.  
Added: Implemented translations db backend in the i18n module.  
Changed: Renamed Translation class to Translator in the i18n module.  
Fixed: Resolved issues with globe imports and incorrect cookie settings in the i18n module.  
Fixed: Added custom URL handling in the i18n provider for better flexibility.  
Fixed: Implemented route handling for the i18n configurations.  
Fixed: Enhanced the i18n endpoints to be unsigned for better security.  
Fixed: Adjusted compatibility of i18n to handle large content loading.  
Fixed: Improved unit tests across modules to ensure robust coverage.  
Fixed: Updated logger to produce target tenant logs during translation operations.


## [5.38.0] - 2026-04-13

Added: Implemented ai-training documentation for i18n with structured guides and best practices.  
Changed: Renamed the `Translation` class to `Translator` in the i18n module.  
Fixed: Resolved issues with missing translations and implemented database backend for translations.  
Fixed: Corrected invalid imports in the i18n module and improved endpoint handling for i18n.  
Fixed: Added custom URL support in the i18n provider and refactored the router for improved performance.  
Fixed: Addressed various bugs related to locale handling and module synchronization.  
Fixed: Enhanced tests for better coverage of i18n functionalities.  
Fixed: Simplified parameter handling in the i18n service for improved API stability.  
Fixed: Updated packages and dependencies to address compatibility with React 18.


## [5.37.0] - 2026-03-23

Added: Added AI training documentation with structured files for various topics related to internationalization.  
Changed: Renamed the Translation class to Translator in the i18n module.  
Fixed: Addressed various issues in the i18n module, including invalid imports and incorrect parameter handling for translation settings.  
Fixed: Updated logger to produce targetten logs in the webafx-i18n module.  
Fixed: Resolved issues with large content loading in the i18n module.  
Fixed: Implemented i18n routes within the API builder.


## [5.36.0] - 2026-03-23

### Added
- Add AI training documentation with structured guides for core concepts, best practices, and examples.

### Changed
- Implemented various improvements in locale resolution and PostgreSQL source handling.

### Fixed
- Fix to normalize `getLocaleFromRequest` processing.
- Corrected typo in i18n translations and improved handling of translations database backend.

### Removed
- Removed deprecated email functionality to prevent spam in package configurations.


## [5.35.0] - 2026-03-20

### Added
- Implemented public mirror infrastructure (Phases 1-3) for improved package management.
- Added onMissingTranslation provider to enhance translation handling.

### Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated package repository URLs and publish configurations across all packages.

### Fixed
- Normalized getLocaleFromRequest to improve locale extraction.
- Fixed various issues in the I18n Module, including handling of missing translations and runtime loading.
- Addressed multiple invalid imports within the webafx-i18n package.
- Resolved cookie setting functionalities for better session management.

### Removed
- Removed certain internal handling to minimize complexity and potential errors.

### Deprecated
- Marked certain translations handling methods for future removal in favor of more efficient approaches.
