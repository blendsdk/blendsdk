# @blendsdk/react

## 5.38.0

### Added

- **GlobalLoader** — Full-screen overlay with CSS-only spinner animation
  - `GlobalLoaderProvider` component with configurable appearance (spinner color, background, size, z-index)
  - `useGlobalLoader()` hook returning `{ showLoader, setText, visible }`
  - Custom `textComponent` prop for rendering text below the spinner with any React component
  - Body scroll lock when loader is visible
  - Runtime CSS `<style>` tag injection — no CSS file imports needed
  - Nesting detection — throws error if providers are nested
  - Auto-clears text when `showLoader(false)` is called
  - 20 comprehensive component tests with `@testing-library/react`

- Initial package skeleton — React 19+ component and hook library for BlendSDK


## [5.52.0] - 2026-08-29

Changed: Updated package.json for @blendsdk/react to include the latest dependencies and improvements.


## [5.50.0] - 2026-07-31

- Added: Introduced a complete authentication module with AuthProvider, AuthGuard, and useAuth hooks.
- Added: New GlobalLoader component for full-screen overlay loading.
- Changed: Upgraded monorepo to TypeScript 7 and refreshed external dependencies.
- Fixed: Clamped setTimeout delay to avoid Node 24 overflow issues.
- Fixed: Enhanced stability of error dialogs and translations.
- Fixed: Improved session handling and automatic routing logic.
- Fixed: Resolved various type-related errors and improved typing in components.


## [5.49.0] - 2026-07-31

Added: Introduced a complete authentication module with AuthProvider, AuthGuard, and useAuth for the React package.  
Added: Introduced GlobalLoader component for full-screen overlay with spinner animation in the @blendsdk/react package.  
Changed: Updated documentation and improved structure across various packages for consistency with Keep a Changelog format.  
Fixed: Clamped setTimeout delay to avoid Node 24 overflow issues affecting auto-refresh functionality.  
Fixed: Addressed missing types and improved error handling in various components including Dialog and Session.  
Fixed: Revamped router functionalities to allow deeper integration and improved session management.  
Fixed: Updated translations handling and added features to support localization effectively.  
Fixed: Refactored session handling and added new components to enhance user experience in the application.  
Fixed: Various bug fixes, including handling of loading states, parameters, and component structures in React package.


## [5.48.0] - 2026-06-14

## Added
- Introduced a complete authentication module for React with AuthProvider, AuthGuard, and useAuth hooks.
- Added GlobalLoader component with CSS-only spinner animation.

## Changed
- Bumped i18n package in react and adjusted related imports for new structure.
- Updated error handling in API request methods to include additional context.
- Restructured session management to improve handling of redirects.

## Fixed
- Clamped setTimeout delay to avoid Node.js 24 overflow issue.
- Enhanced session checking to validate correctly on initialization.
- Fixed type issues in the error handling components and added necessary types for improved compatibility.
- Adjusted overall functionality to ensure consistent behavior of global error dialogs and loading states.


## [5.47.0] - 2026-05-22

## Added
- Introduced authentication module with AuthProvider, AuthGuard, and useAuth hooks.
- Added GlobalLoader component for overlay functionality in React applications.

## Changed
- Updated all package documentation in accordance with version changes.
- Restructured changelog entries across all packages to follow Keep a Changelog format.

## Fixed
- Fixed setTimeout delay clamping to avoid overflow issues in Node.js 24.
- Added functionality for the ErrorDialog component to manage system errors.
- Corrected issues in session handling and routing, including refactoring and methods for dynamic session loading.

## Removed
- Removed deprecated react-webafx package in favor of @blendsdk/react.


## [5.46.0] - 2026-05-21

Changed: Updated documentation to reflect recent changes and improvements across all packages.  
Fixed: Clamp setTimeout delay to avoid Node 24 overflow leading to immediate timer execution.  
Fixed: Added support to automatically redirect routes based on session initialization for better user experience.  
Fixed: Enhanced ErrorDialog component for consistent error handling in React applications.  
Fixed: Updated i18n integration with improved loading and translation handling.  
Fixed: Resolved missing export issues for route components to ensure proper function in applications.  
Added: Introduced a complete authentication module with AuthProvider, AuthGuard, and useAuth hook for React applications.  
Added: Added GlobalLoader component for better user experience during loading states in React applications.  
Removed: Deleted the deprecated react-webafx package in favor of the unified @blendsdk/react package.


## [5.45.0] - 2026-05-21

### Added
- Introduced `auth` module with `AuthProvider`, `AuthGuard`, and `useAuth` for improved authentication management.
- Added `GlobalLoader` component for enhanced loading experiences in React applications.

### Changed
- Updated Node.js version compatibility and error handling in `setTimeout` functionality.
- Restructured documentation across various packages to align with latest updates.
- Updated existing components and utilities to enhance functionality and user experience.

### Fixed
- Fixed issue with `setTimeout` delays in Node.js 24 to prevent immediate execution due to overflow.
- Enhanced the clarity of error handling by improving translation context management.
- Corrected `makePlaceholderExtension` implementation to improve functionality.
- Resolved importing issues and ensured consistency in error handling across components.

### Removed
- Deleted the `react-webafx` package in favor of the newly released `@blendsdk/react` package to streamline development.


## [5.44.1] - 2026-05-20

- Added: Introduced a new authentication module with AuthProvider, AuthGuard, and useAuth hooks.
- Added: New GlobalLoader component for BlendSDK React package.
- Changed: Updated setTimeout logic to avoid Node 24 overflow.
- Fixed: Resolved promise handling in various hooks and components.
- Fixed: Updated error handling for system errors and translations.
- Fixed: Various improvements and refinements to session management and router functionality.
- Fixed: Enhanced error dialogs and added missing components and parameters. 
- Fixed: Updated dependencies and removed outdated code.


## [5.44.0] - 2026-05-20

Added:
- Introduced a complete authentication module with AuthProvider, AuthGuard, and useAuth.
- Added GlobalLoader component for full-screen overlay and spinner animation.
- Implemented useOpenURL hook for enhanced URL handling.

Changed:
- Updated auto-refresh functionality to prevent immediate execution on Node.js 24.
- Improved documentation across various React components and modules.

Removed:
- Deprecated react-webafx package in favor of @blendsdk/react, consolidating functionality.

Fixed:
- Fixed issue with setTimeout delay clamping on Node.js 24 to avoid immediate execution.
- Corrected debounce logic and return types.
- Fixed session checking and provided better handling for error translations.
- Added various error and state management fixes across components.

Security:
- Improved handling of session data to reduce the risk of unauthorized access.


## [5.43.1] - 2026-05-20

## Added
- Introduced a complete authentication module with AuthProvider, AuthGuard, and useAuth hooks for enhanced session management.
- Added GlobalLoader component as a full-screen overlay with CSS-only spinner animation.
- Implemented additional hooks and features into the i18n context and routing system.

## Changed
- Updated documentation to include new functionalities and improved overall structure across multiple files.
- Refactored several components and hooks for better code organization and performance optimizations.

## Fixed
- Clamped setTimeout delay to avoid overflow issues in Node.js 24 affecting auto-refresh functionality.
- Addressed various issues with error handling, including enhancements to the error dialog and system error components.
- Improved session initialization checks and automatic redirections based on session state.

## Removed
- Deprecated the `react-webafx` package in favor of `@blendsdk/react`; ensured a clean consolidation of functionalities.


## [5.43.0] - 2026-05-19

## Added
- Introduced an authentication module with AuthProvider, AuthGuard, and useAuth hooks.
- Added GlobalLoader component for full-screen overlay with CSS-only spinner animation.

## Changed
- Updated existing documentation and code to reflect monorepo consolidation.
- Restructured changelog entries for better clarity and organization.

## Fixed
- Removed dead code from utilities.
- Enhanced error handling and translations for better user experience.
- Fixed various issues in session and routing logic across the React package.
- Optimized parameters loading and state management related to session handling.

## Removed
- Deleted the react-webafx package in favor of the new @blendsdk/react package.


## [5.42.0] - 2026-05-18

- Added: Introduced @blendsdk/react package with GlobalLoader component and initial hook library for BlendSDK applications.
- Changed: Restructured documentation for all MCP packages to align with the new versioning and changelog formatting.
- Fixed: Addressed issues related to the GlobalLoader and added debounce functionality in utility methods.
- Fixed: Improved session handling with new methods and error handling in the React components.
- Fixed: Enhanced internationalization support in the React components, including error and loading states.  
- Fixed: Corrected export issues and ensured compatibility with recent versions of dependencies.
- Fixed: Resolved multiple minor bugs related to type definitions and function parameters across React components.


## [5.41.0] - 2026-05-17

Added: Introduced @blendsdk/react package with GlobalLoader component for full-screen overlay with CSS-only spinner animation.  
Changed: Updated all MCP package documentation to reflect v5.40.0 release and restructured changelog entries across all packages.  
Fixed: Removed dead code in react package, improved debounce functionality, and fixed errors in various components.  
Fixed: Added custom parameters for LogicStore and ensured configuration covers error handling and data fetching.  
Fixed: Enhanced i18n support with new translation functionalities and improved error handling mechanisms.  
Fixed: Refactored session management logic and integrated routing enhancements for better session handling.  
Fixed: Addressed issues related to loading states and applied separation of concerns in component structure.  
Removed: Deleted the react-webafx package in favor of @blendsdk/react.


## [5.40.0] - 2026-05-17

### Added
- Introduced `@blendsdk/react` package with `GlobalLoader` component for BlendSDK applications.
- Added `useOpenURL` hook to enhance application routing.
- Added `getSystemErrorObject` for improved error handling.
- Added surface and toolbar components in the fluent UI library.
- Added drawer view to the Fluent UI components.

### Changed
- Updated BlendSDK documentation to version 5.39.0 and reformatted for monorepo structure.
- Downgraded React version to 18 for compatibility.
- Refactored API for better error handling in Fluent UI components.
- Updated package versions throughout the monorepo including dependencies.

### Fixed
- Fixed various issues related to loading state data and session reactivity.
- Fixed type definitions in the React package for better type safety and functionality.
- Resolved issues with translations loading and error translations.
- Fixed router functionality and child link handling for improved routing experience. 
- Enhanced error dialogs and added handling for missing translations.
- Resolved dependency installation issues and ensured proper bundling of Fluent UI components.

### Removed
- Deleted the deprecated `react-webafx` package in favor of `@blendsdk/react`.

