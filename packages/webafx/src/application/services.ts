/**
 * Preparse service names
 *
 * @deprecated Use const objects instead of static class properties.
 * This function will be removed in the next major version.
 *
 * @example
 * ```typescript
 * // OLD (deprecated):
 * class MyServiceNames {
 *   static LOGGER_SERVICE: string;
 *   static SOME_SERVICE: string;
 * }
 * preparseServiceNames(MyServiceNames);
 *
 * // NEW (recommended):
 * export const ServiceNames = {
 *   LOGGER_SERVICE: 'LOGGER_SERVICE',
 *   SOME_SERVICE: 'SOME_SERVICE',
 * } as const;
 * ```
 *
 * @export
 * @param {*} clazz
 */
export function preparseServiceNames(clazz: any) {
  console.warn(
    '[WebAFX DEPRECATION WARNING] preparseServiceNames() is deprecated. ' +
      'Use const objects instead: const ServiceNames = { KEY: "KEY" } as const;'
  );
  Object.keys(clazz).forEach(key => {
    clazz[key] = key;
  });
}
