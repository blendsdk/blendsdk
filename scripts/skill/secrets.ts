/**
 * Secret detection for generated and migrated skill content.
 *
 * The skill ships inside a public npm package, so no credential may reach its
 * files. This module owns the denylist of well-known credential shapes and is
 * used by both the package generator and the one-time migration so the same
 * rule applies to every file the skill contains.
 *
 * This is a targeted denylist, not a complete secret scanner: it catches the
 * common provider prefixes and private-key headers. High-entropy content that
 * does not match a known shape is out of scope.
 *
 * @module skill/secrets
 */

/**
 * Patterns for secret material that must never reach skill content.
 *
 * Each entry pairs a human-readable label (used in the failure message) with
 * the pattern that detects it. The patterns intentionally avoid the global flag
 * so repeated `.test()` calls stay stateless.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // `-` and `_` are allowed after the prefix so provider-prefixed keys such as
  // `sk-proj-…` (OpenAI) and `sk-ant-…` (Anthropic) are also detected.
  { label: 'an API key', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'a GitHub token', pattern: /\bghp_[A-Za-z0-9]{20,}\b/ },
  { label: 'a GitHub token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { label: 'a GitHub token', pattern: /\bgh[osru]_[A-Za-z0-9]{20,}\b/ },
  { label: 'a GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { label: 'a Slack token', pattern: /\bxox[abpro]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'a Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/ },
  { label: 'an npm token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { label: 'an AWS access key', pattern: /\bAKIA[0-9A-Z]{12,}\b/ },
  { label: 'private key material', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * Returns the label of the first secret pattern found in the content.
 *
 * @param content - Text to scan
 * @returns The matching secret's label, or `undefined` when the content is clean
 */
export function findSecret(content: string): string | undefined {
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      return label;
    }
  }
  return undefined;
}
