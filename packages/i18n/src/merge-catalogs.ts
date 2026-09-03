import type { TranslationCatalog } from "./types.js";

/**
 * Merge multiple translation catalogs into one.
 *
 * Catalogs are merged in array order. For duplicate key+locale pairs,
 * the later source wins (predictable override order). This allows
 * layered translation loading where database overrides can sit on top
 * of file-based defaults.
 *
 * @param catalogs - Array of catalogs to merge (in priority order, last wins)
 * @returns The merged catalog containing all keys from all sources
 *
 * @example
 * const base = { greeting: { en: "Hello", nl: "Hallo" } };
 * const overrides = { greeting: { en: "Hi" } };
 * mergeCatalogs([base, overrides]);
 * // → { greeting: { en: "Hi", nl: "Hallo" } }
 */
export function mergeCatalogs(catalogs: TranslationCatalog[]): TranslationCatalog {
    const result: TranslationCatalog = {};

    for (const catalog of catalogs) {
        for (const [key, entry] of Object.entries(catalog)) {
            if (!result[key]) {
                // First occurrence of this key — copy the entry
                result[key] = { ...entry };
            } else {
                // Merge locale entries — later sources override earlier
                Object.assign(result[key], entry);
            }
        }
    }

    return result;
}
