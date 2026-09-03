# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.52.0] - 2026-08-29

Changed: Updated package.json for improved dependency management in the i18n package.


## [5.50.0] - 2026-07-31

### Added
- Implemented single-package distribution with subpath exports for browser compatibility.
- Added ContentFileSource for loading translations from individual content files.
- Added a public mirror infrastructure for package configuration.
- Added keyed translations support.
- Added i18n utility for translation.

### Changed
- Upgraded monorepo to TypeScript 7 and refreshed external dependencies.
- Improved TypeScript compatibility and CI environment propagation.

### Removed
- Removed fluentui package due to compatibility issues with React 18.

### Fixed
- Fixed various issues related to the i18n package, including missing translations and typos.
- Resolved issues with the Translator class and added more comprehensive testing.
- Fixed dependence version mismatches across multiple packages.


## [5.49.0] - 2026-07-31

### Added
- Added `ContentFileSource` class for loading translations from individual content files.
- Implemented production-grade i18n system with `@blendsdk/i18n`.

### Changed
- Implemented subpath exports for browser compatibility: "@blendsdk/i18n" and "@blendsdk/i18n/node".
- Improved documentation for `ai-training` resources and practices.

### Fixed
- Fixed several issues in the `Translator` class related to translation loading and processing.
- Resolved type mismatches in various packages to improve compatibility and functionality.

### Deprecated
- Marked usage of legacy translation methods as deprecated in favor of new structured approaches.

### Removed
- Eliminated unused CHANGELOG files across various packages to streamline documentation.


## [5.48.0] - 2026-06-14

Added: Implemented single-package distribution for '@blendsdk/i18n' and added subpath exports for browser compatibility.  
Added: Introduced ContentFileSource class for loading translations from individual content files.  
Added: Keyed translations support in the i18n system.  
Changed: Updated documentation across the ai-training series with various structured topics.  
Changed: Improved type safety and resolved various TypeScript-related updates in the i18n package.  
Fixed: Resolved issues with dynamic property loading in the Translator class.  
Fixed: Corrected various formatting and typing issues across the i18n package.  
Fixed: Implemented missing translations handler for better translation management.  
Fixed: Fixed numerous bugs related to the handling and loading of i18n large content.  
Fixed: Resolved testing inconsistencies and improved overall test coverage within the i18n package.  
Security: Updated package dependencies to mitigate known vulnerabilities in the underlying libraries.


## [5.47.0] - 2026-05-22

## Added
- Add ContentFileSource class for loading translations from individual files.
- Implement public mirror infrastructure and package configuration for publish.
- Introduced ai-training documentation with multiple structured documents.
- Added keyed translations support to the i18n system.

## Changed
- Consolidate all @blendsdk packages into a single 'blendsdk' npm package with subpath exports.
- Split @blendsdk/i18n into two entry points: core version and Node.js-only version.

## Fixed
- Fix issues related to dynamic loading of translations in Translator class.
- Resolve path loading issues in newly added ContentFileSource.
- Fixed several issues in the i18n module regarding loading and variable handling.

## Removed
- Removed email notifications in the release process to prevent spamming.

## Deprecated
- Deprecated the use of a single entry point for @blendsdk/i18n; use separate imports instead.


## [5.46.0] - 2026-05-21

Changed: Split @blendsdk/i18n into separate entry points for browser-safe and Node.js-only environments.

Added: Implemented ContentFileSource for loading translations from individual content files.

Added: Introduced keyed translations to manage translation strings effectively.

Fixed: Corrected issues with i18n dynamic loading process and translation handling.

Fixed: Improved handling of translations with large content loading scenarios.

Fixed: Enhanced the i18n Translator to prioritize local variables and support new formats.

Deprecated: Removed old translation classes in favor of the new Translator implementation.

Removed: Dropped support for legacy i18n package structure and redundant files.


## [5.45.0] - 2026-05-21

Changed: Consolidated the submodules into a single package, reducing complexity for developers.  
Added: Implemented keyed translations to enhance localization capabilities.  
Added: Introduced ContentFileSource for loading translations from individual files.  
Added: AI training documentation with structured guidance on using the i18n features.  
Fixed: Addressed issues with dynamically loading and overwriting translations.  
Fixed: Corrected various bugs, including incorrect handling of translations and return types.  
Removed: Deprecated old translation class, now using the revised Translator functionality.  
Security: Enhanced validation processes to mitigate potential vulnerabilities in localization management.


## [5.44.1] - 2026-05-20

Added: Implemented public mirror infrastructure with package configuration for npm publishing.

Added: Introduced `ContentFileSource` for loading translations from individual content files.

Added: Added keyed translations feature for more structured localization.

Changed: Split `@blendsdk/i18n` into two entry points: `"@blendsdk/i18n"` for browser-safe core and `"@blendsdk/i18n/node"` for Node.js-only sources.

Changed: Enhanced `Translator` class with more robust translation handling, including locale fallback and plural support.

Fixed: Resolved issues with dynamically loaded internationalization files, improving text rendering during load times.

Fixed: Addressed multiple errors within the translation pipeline, boosting consistency in output.

Fixed: Corrected invalid return statements in the `Translator` class to ensure proper functionality.

Fixed: Typo corrections and refactored code for improved clarity and maintainability.

Fixed: Resolved issues leading to unsuccessful loading of translations from large files. 

Fixed: Adjusted package dependencies to optimize performance and compatibility issues noticed during testing.

Fixed: Ensured all call signing and file loading features operate as intended with proper type and format checks.

Fixed: Reversed removal of dynamically added properties that are essential for translation context.

Fixed: Removed unnecessary package dependencies and ensured cleaner builds by consolidating versions. 

Fixed: Updated configurations to ensure smoother integration with Jest testing across the project components.


## [5.44.0] - 2026-05-20

Added: Implemented keyed translations and added ai-training documentation with structured guides.  
Changed: Split @blendsdk/i18n into browser-safe core and Node.js-only entry points; enhanced interaction with TranslationSource interface.  
Fixed: Issues related to dynamic loading, type fixing, and improved translation methods.  
Fixed: Corrected issues with translation files and added extensive test coverage for various localization scenarios.  
Removed: Deprecated global i18n methods and replaced them with localized alternatives.  
Security: Minor adjustments to improve overall package integrity and security compliance.


## [5.43.1] - 2026-05-20

### Added
- Added ContentFileSource for loading translations from individual content files.
- Implemented public mirror infrastructure, updating package configurations for public access.
- Added subpath exports for browser compatibility in @blendsdk/i18n.

### Changed
- Consolidated all @blendsdk/* packages into a single 'blendsdk' npm package with subpath exports.
- Updated ai-training documentation, adding structured guides on core concepts and usage.

### Fixed
- Fixed issues with package versions and formatting across various packages, ensuring compatibility and improved structure.
- Corrected a typo and restructured the Translation class in the i18n package for better clarity and functionality.


## [5.43.0] - 2026-05-19

### Added
- Added ContentFileSource class for loading translations from individual content files.
- Added support for keyed translations.
- Added i18n utility for translation functions.

### Changed
- Split @blendsdk/i18n into two entry points: "@blendsdk/i18n" for browser-safe core and "@blendsdk/i18n/node" for Node.js-only file sources.
- Changed file structure for i18n to include a new ai-training documentation section.

### Fixed
- Fixed several issues with dynamic loading of i18n translations.
- Fixed various bugs in the Translator class related to language handling and translation resolution.
- Fixed an issue causing type errors during package updates.

### Security
- Updated dependencies to mitigate vulnerabilities related to translation handling.


## [5.42.0] - 2026-05-18

Added: Implemented production-grade i18n system with support for keyed translations and language lists.  
Added: New ContentFileSource class for loading translations from individual content files.  
Added: ai-training documentation in the i18n package.  
Fixed: Resolves issue with dynamically loading i18n resources.  
Fixed: Updated implementation to prioritize local variables in translation context.  
Fixed: Allowed overwriting i18n entries when dynamically loading.  
Fixed: Corrected savepoint handling in i18n loading logic.  
Fixed: Refactored Translation class to Translator, improving clarity and consistency.  
Fixed: Added comprehensive tests for translation functionality and added JSON file sources.  
Changed: Split @blendsdk/i18n into browser-safe core and Node.js-only exports for enhanced compatibility.  
Deprecated: Removed email to prevent spamming in changelog processes.  
Changed: Versioning strategy updated across multiple packages for consistency.  
Removed: Deleted unused old CHANGELOG files from various packages.


## [5.41.0] - 2026-05-17

Added:
- Added keyed translations to support better localization practices.
- Introduced "ContentFileSource" for loading translations from individual content files.
- Implemented public mirror infrastructure for package distribution.

Changed:
- Refactored the "Translation" class to "Translator" for better clarity.
- Updated package version management across multiple packages.

Fixed:
- Resolved issues with loading large content in the i18n module.
- Fixed several typographical errors in i18n related configurations.
- Corrected multiple problems with dynamically added properties in the Translator.

Deprecated:
- Deprecated older entry points in favor of new subpath exports.


## [5.40.0] - 2026-05-17

Added:
  - Implemented single-package distribution for better module management.
  - Added ContentFileSource class for loading translations from individual content files.
  - Introduced keyed translations for structured translation management.
Changed:
  - Split @blendsdk/i18n into two entry points for improved compatibility.
  - Refactored Translation class to Translator and updated related files.
Fixed:
  - Addressed issues with dynamically loaded i18n settings.
  - Resolved translation file loading issues, including large content handling.
  - Corrected formatting and sorting issues across various source files.


## [5.39.0] - 2026-05-07

Changed: Split @blendsdk/i18n into two entry points for browser and Node.js compatibility.  
Added: Implemented ContentFileSource for loading translations from individual content files.  
Added: Introduced keyed translations for better management of translation strings.  
Fixed: Resolved issues with loading translations dynamically and improved file handling in Translator.  
Fixed: Corrected various minor bugs and inconsistencies in language processing and translation retrieval.  
Removed: Deprecated old file structure in favor of new organized documentation for ai-training.  
Added: Enhanced documentation with structured guides on ai-training best practices and core concepts.


## [5.38.0] - 2026-04-13

Changed: Split @blendsdk/i18n into two entry points for browser and Node.js compatibility.  
Added: Implemented ContentFileSource for loading translations from individual content files.  
Added: Introduced keyed translations feature for better translation management.  
Fixed: Resolved issues allowing overwriting i18Ns when dynamically loading.  
Fixed: Enhanced i18n file loading to support large content.  
Fixed: Corrected references and updated type checks in Translation class, now renamed to Translator.  
Fixed: Addressed various bugs in translation loading and handling throughout the codebase.  
Fixed: Adjusted Jest configuration for better test execution reliability.  
Fixed: Included missing language list for all supported locales.  
Fixed: Removed dynamically added properties which were previously unnoticed in the Translator class.  
Fixed: Updated package versions across multiple dependencies for better stability and compatibility.


## [5.37.0] - 2026-03-23

### Added
- Add ai-training documentation with 11 structured documents.
- Add ContentFileSource class for loading translations from individual content files.
- Add keyed translations feature to manage translations with keys.
- Implement public mirror infrastructure to enhance package configuration.

### Changed
- Split @blendsdk/i18n into separate entry points for browser and Node.js.
- Refactored Translation class to be renamed as Translator.
- Enhanced documentation and structure in the ai-training directory.

### Fixed
- Fix typo in languages configuration.
- Allow overwriting translations when dynamically loading.
- Resolve issues with dynamically added properties in Translator.
- Update the implementation of formatString to improve variable application.

### Removed
- Remove CHANGELOG files from individual package directories.


## [5.36.0] - 2026-03-23

### Added
- Added ai-training documentation with 11 structured documents covering core concepts and usage.
- Implemented ContentFileSource class for loading translations from content files.
- Introduced subpath exports for browser compatibility, allowing usage as "@blendsdk/i18n" and "@blendsdk/i18n/node".

### Changed
- Updated all packages to latest versions.
- Renamed the Translation class to Translator for clarity.

### Fixed
- Resolved issues with translation loading when dynamically configuring translators.
- Addressed various bugs in the Translator class to enhance reliability and performance.
- Fixed typo in languages configuration and ensured correct language loading.

### Deprecated
- Deprecated the previous methods of accessing translation sources in favor of the new structured documentation and ContentFileSource.

### Removed
- Removed outdated methods that were causing conflicts with new features related to translation handling.


## [5.35.0] - 2026-03-20

Changed: Consolidated multiple packages into a single '@blendsdk/i18n' package with subpath exports for better distribution.  
Added: Implemented keyed translations for better organization and access.  
Added: Introduced ContentFileSource for loading translations from individual content files.  
Added: Added public mirror infrastructure in phases, including package configuration and publish settings.  
Fixed: Resolved translation loading issues by allowing overwriting of i18n when dynamically loading.  
Fixed: Fixed bugs related to translate function precedence and added missing translations.  
Fixed: Refactored the Translation class to improve structure and usability.  
Fixed: Corrected multiple issues in package versions across dependencies.
