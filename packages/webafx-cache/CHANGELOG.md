# @blendsdk/webafx-cache — Changelog

All notable changes to this package will be documented in this file.

## [5.52.0] - 2026-08-29

Changed: Updated package.json to improve dependency management and compatibility.


## [5.50.0] - 2026-07-31

Added: Implemented MemoryCache and RedisCache providers with respective test cases.  
Added: Introduced new documentation for ai-training including best practices and common scenarios.  
Changed: Updated TypeScript to version 7 and adjusted compatibility across packages.  
Changed: Renamed package directory from "packages/cache" to "packages/webafx-cache" and updated references.  
Fixed: Resolved issues with Redis keys and added support for compatible functionality.  
Fixed: Enhanced cache provider registration and added module priority handling.  
Fixed: Cleaned up redis implementation and ensured backward compatibility with existing systems.  
Fixed: Adjusted Jest configurations to ensure proper testing conditions.  
Removed: Deprecated support for previous cache structures and removed unused packages.


## [5.49.0] - 2026-07-31

Added: Added new ai-training documentation including core concepts and usage examples for `@blendsdk/webafx-cache`.  
Added: Introduced `MemoryCache` support for `@blendsdk/webafx-cache`.  
Added: Added `KEEPTTL` option to Redis set for better cache management.  
Changed: Renamed package from `@blendsdk/cache` to `@blendsdk/webafx-cache`.  
Changed: Refactored to separate webafx-cache into two libraries, improving modularity.  
Fixed: Fixed the redis keys calculations to ensure correct cache behavior.  
Fixed: Refactored cache provider registration to enhance flexibility and reliability.  
Fixed: Updated logger implementation to ensure accurate logging for targetten events.  
Fixed: Cleanup adjustments made in the Redis implementation for better performance and maintainability.  
Fixed: Added tests for new `redis-cache-provider` functionality to ensure reliability.  
Removed: Deprecated the previous cache implementations in favor of new abstracts and providers.


## [5.48.0] - 2026-06-14

Added: Implemented ai-training documentation with 11 structured docs for webafx-cache.
Added: Introduced MemoryCache and RedisCache providers with respective functionality.
Changed: Renamed package from @blendsdk/cache to @blendsdk/webafx-cache with updated documentation.
Fixed: Resolved issues with redis key management and compatibility in the cache provider.
Fixed: Improved error handling and formatting in server-side code.
Fixed: Refactored RedisCache provider and added tests for enhanced reliability.
Fixed: Added KEEPTTL option to redis set for better cache management.
Removed: Deprecated code and unused packages for improved maintenance.


## [5.47.0] - 2026-05-22

Changed: Renamed package from `@blendsdk/cache` to `@blendsdk/webafx-cache`.  
Added: Implemented MemoryCache provider and RedisCache provider with tests.  
Added: Comprehensive ai-training documentation including core concepts, usage patterns, and troubleshooting.  
Fixed: Fixed the redis keys and improved backwards compatibility for redis integration.  
Fixed: Added KEEPTTL to redis set functionality for cache management.  
Fixed: Refactored cache provider registration and order for improved performance.  
Fixed: Cleanup and formatting updates across multiple source files.  
Fixed: Updated logger to produce targeted logs for better debugging.  
Removed: Deprecated code cleaned out from the package.


## [5.46.0] - 2026-05-21

### Added
- Implemented new ai-training documentation for webafx-cache with structured guides.

### Changed
- Refactored cache module, renamed from `@blendsdk/cache` to `@blendsdk/webafx-cache`.

### Fixed
- Fixed redis keys in the cache provider to ensure compatibility with existing systems.
- Adjusted redis cache provider registration to improve module priority.
- Added MemoryCache implementation to enhance caching capabilities.
- Updated packages and removed deprecated code to clean up project structure.
- Fixed issues with query parameters for non-GET requests in HttpRequest.


## [5.45.0] - 2026-05-21

Changed: Updated package name from `@blendsdk/cache` to `@blendsdk/webafx-cache`, including all relevant documentation and references.  
Changed: Refactored cache provider registration logic to enhance code quality and performance.  
Added: Introduced RedisCache and MemoryCache providers with comprehensive tests for functionality.  
Added: Documentation for ai-training to cover core concepts, usage patterns, best practices, and troubleshooting.  
Fixed: Corrected issues with Redis key management to ensure data integrity and compatibility.  
Fixed: Added support for GET parameters in search functionality.  
Fixed: Updated Jest configuration files across multiple packages to ensure consistency and accommodate testing requirements.  
Fixed: Improved error handling in Redis connections and cache functionalities.  
Removed: Deprecated components and unused packages to streamline the codebase and improve maintainability.


## [5.44.1] - 2026-05-20

### Added
- Implemented ai-training documentation for webafx-cache with various guides and best practices.

### Changed
- Renamed package from @blendsdk/cache to @blendsdk/webafx-cache, including updates to documentation references and JSDoc.
- Updated RedisCache provider for better performance and added new tests.

### Fixed
- Fixed redis keys handling in webafx-cache.
- Allowed GET parameters in search functionality of webafx-cache.
- Added memory and Redis cache providers in webafx-cache with tests.
- Made Redis compatibility improvements to preserve existing functionality.
- Refactored cache provider registration logic and improved module priority handling.


## [5.44.0] - 2026-05-20

Added: Implemented MemoryCache and RedisCache providers with tests for caching behavior and TTL management.  
Added: New ai-training documentation covering various usage patterns for the webafx-cache package.  
Changed: Renamed package from @blendsdk/cache to @blendsdk/webafx-cache, updating all references accordingly.  
Changed: Consolidated package structure into a single distribution for easier management and deployment.  
Fixed: Corrected redis key handling and added support for KEEPTTL in cache operations.  
Fixed: Refactored cache provider registration and integration steps for improved compatibility.  
Fixed: Resolved various issues related to Redis connections and module priorities in caching workflows.  
Fixed: Updated and cleaned up existing tests to ensure comprehensive coverage for caching functionality.  
Removed: Deprecated references and code segments to streamline the webafx-cache implementation.


## [5.43.1] - 2026-05-20

### Changed
- Renamed the package from `@blendsdk/cache` to `@blendsdk/webafx-cache` and updated all related documentation.

### Added
- Introduced ai-training documentation with structured usage guides and scenarios for `webafx-cache`.

### Fixed
- Fixed the Redis keys handling in the cache provider.
- Added `KEEPTTL` option to Redis set functionality.
- Improved compatibility of Redis cache provider for backwards compatibility.
- Cleared up issues with the cache provider registration and initialization.
- Added tests for Redis cache provider.

### Removed
- Removed deprecated code and unused package dependencies from the project.


## [5.43.0] - 2026-05-19

Added: Added ai-training documentation covering core concepts, basic usage, advanced patterns, and best practices for the webafx-cache package.  
Added: Implemented Redis cache provider with tests for added functionality.  
Changed: Renamed package from @blendsdk/cache to @blendsdk/webafx-cache to reflect new structure.  
Changed: Consolidated Redis and Memory cache implementations into unified interfaces.  
Fixed: Fixed the redis keys for improved integration and stability.  
Fixed: Enhanced error handling for connection issues with Redis.  
Fixed: Updated implementation to allow for backwards compatibility with previous Redis configurations.  
Fixed: Cleanup ensure redundant code is removed for better readability and maintainability.  
Fixed: Updated glob configurations to address package recognition issues.  
Fixed: Adjusted module priority in cache provider registration for improved performance.


## [5.42.0] - 2026-05-18

Added: Implemented `MemoryCache` and `RedisCache` providers to enhance caching options.  
Added: Added KEEPTTL functionality to Redis set.  
Added: Included documentation for ai-training with multiple topics covering usage and best practices.  
Changed: Updated package name from `@blendsdk/cache` to `@blendsdk/webafx-cache` after renaming packages/cache to packages/webafx-cache.  
Changed: Refactored cache provider registration and order of operations in Redis provider implementation.  
Fixed: Corrected Redis keys management in cache implementation.  
Fixed: Enhanced caching structure by adding tests for memory and Redis cache providers.  
Fixed: Resolved issues with backward compatibility for Redis integration.  
Removed: Deprecated and unused packages have been removed from the project.


## [5.41.0] - 2026-05-17

Changed: Renamed package from `@blendsdk/cache` to `@blendsdk/webafx-cache` and adjusted related documentation and references.  
Added: Introduced RedisCache and MemoryCache providers for additional caching mechanisms.  
Added: Comprehensive documentation for the new ai-training module, including best practices and usage examples.  
Fixed: Updated connection handling in Redis to ensure robust error management and added more seconds to Jest timeout.  
Fixed: Addressed various issues related to Redis key handling and caching behavior.  
Removed: Deprecated and unused code for improved package structure and maintainability.  
Removed: Removed FluentUI package until compatibility with React 18 is confirmed.


## [5.40.0] - 2026-05-17

Added: Implemented ai-training documentation with structured guides for webafx-cache usage.  
Changed: Renamed package from @blendsdk/cache to @blendsdk/webafx-cache and updated all relevant documentation.  
Fixed: Added KEEPTTL to redis set in cache implementation.  
Fixed: Made redis cache provider backwards compatible.  
Fixed: Cleaned up redis module and refactored cache provider registration.  
Fixed: Addressed issues with redis keys in cache implementation.  
Fixed: Added RedisCache provider with tests for better reliability.  
Removed: Deprecated code and removed unused package dependencies.


## [5.39.0] - 2026-05-07

Added: Implemented RedisCache and MemoryCache providers with respective testing frameworks.  
Added: Included comprehensive AI training documentation covering overview, concepts, usage, and best practices.  
Changed: Renamed package from `@blendsdk/cache` to `@blendsdk/webafx-cache` with updated documentation and references.  
Fixed: Corrected redis key handling for improved functionality.  
Fixed: Fixed module priority registration issues within cache providers.  
Fixed: Resolved issues with redis connection handling in the cache provider.  
Fixed: Cleaned up and refactored code for better maintainability in redis cache implementation.  
Removed: Deprecated `@blendsdk/cache` in favor of the new `@blendsdk/webafx-cache`.  
Fixed: Addressed several issues in unit tests for cache functionalities.


## [5.38.0] - 2026-04-13

### Changed
- Renamed package from `@blendsdk/cache` to `@blendsdk/webafx-cache` and updated all references accordingly.
- Refactored cache provider registration in `redis.ts` to include improved module priority handling.

### Added
- Introduced MemoryCache to manage in-memory caching strategies.
- Implemented custom RedisCache provider along with associated tests for functionality.
- Enhanced documentation with AI training guides covering usage patterns, best practices, and troubleshooting for new users.

### Fixed
- Corrected redis key management to improve stability and compatibility.
- Adjusted memory cache provider to ensure more robust functionality.
- Updated jest configurations and module systems to accommodate new package structures, including timeout settings for tests. 
- Resolved multiple instances of type incompatibility across core modules and fixed broken tests.

### Removed
- Deprecated the old `@blendsdk/cache` package and all associated references throughout the codebase.


## [5.37.0] - 2026-03-23

Added: Implemented MemoryCache and RedisCache providers, enhancing caching capabilities.  
Added: Extensive ai-training documentation covering core concepts, usage patterns, and best practices.  
Changed: Renamed package from `@blendsdk/cache` to `@blendsdk/webafx-cache`, updating all references accordingly.  
Changed: Consolidated multiple packages into a single `blendsdk` npm package with subpath exports.  
Fixed: Corrected Redis keys management in cache functionality.  
Fixed: Enhanced tests for MemoryCache and RedisCache implementations.  
Fixed: Applied various updates to resolve type issues across multiple packages.  
Fixed: Addressed compatibility issues with Redis for backward compatibility.  
Removed: Deprecated fluentui package temporarily due to React 18 compatibility issues.  
Removed: Cleaned up unused dependencies across packages to streamline the codebase.  
Removed: Removed the previous cache provider structure; replaced with dual abstractions for improved functionality.


## [5.36.0] - 2026-03-23

### Added
- Add extensive ai-training documentation covering concepts, usage, and best practices for CacheProvider and PubSubProvider.

### Changed
- Renamed package from `@blendsdk/cache` to `@blendsdk/webafx-cache`.
- Consolidated all 12 `@blendsdk/*` packages into a single 'blendsdk' npm package with subpath exports.

### Fixed
- Fixed redis keys and added KEEPTTL to redis set.
- Refactored cache provider registration logic and improved module priority handling.
- Added redic cache provider with unit tests.
- Improved error handling in Redis connection logic and made redis backwards compatible. 

### Removed
- Removed unused packages and fluentui due to compatibility issues with React 18.


## [5.35.0] - 2026-03-20

## Changed
- Updated package name from `@blendsdk/cache` to `@blendsdk/webafx-cache` and refactored import paths accordingly.

## Added
- Implemented MemoryCache within the webafx-cache library for improved caching performance.
- Added Redis cache provider with extensive tests for verification.

## Fixed
- Fixed issues with redis key handling and added necessary configurations to support backwards compatibility.
- Resolved various issues with Jest tests to ensure reliable test execution.
- Corrected the logic for allowed GET parameters within the clientkit's `HttpRequest` handling.
- Enhanced logging to better reflect targetted logs in various modules.
- Ensured updated types and module registrations for cache provider to work correctly across the system.


## [5.32.0] — 2026-02-16

### Added

- Initial package scaffolding
- Abstract `CacheProvider` base class (pending)
- `RedisCacheProvider` — Redis backend via ioredis (pending)
- `MemoryCacheProvider` — In-memory backend for dev/testing (pending)
- WebAFX plugin integration functions (pending)
