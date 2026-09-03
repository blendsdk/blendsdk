import damerauLevenshtein from 'damerau-levenshtein';

/** Longest spelling accepted by the optional similarity diagnostic. */
const MAX_SUGGESTION_LENGTH = 128;

/** Default maximum distinct misspellings evaluated during one parser execution. */
const DEFAULT_MAX_LOOKUPS = 16;

/** Default maximum relevant registered spellings evaluated for one misspelling. */
const DEFAULT_MAX_CANDIDATES_PER_LOOKUP = 256;

/** Default maximum edit-distance calls made during one parser execution. */
const DEFAULT_MAX_COMPARISONS = 512;

/** Deterministic work limits shared by every suggestion scope in one invocation. */
export interface ISuggestionLimits {
  /** Maximum number of distinct normalized misspellings that may be evaluated. */
  maxLookups: number;
  /** Maximum complete candidate set permitted for one misspelling. */
  maxCandidatesPerLookup: number;
  /** Maximum total edit-distance calls permitted across all scopes. */
  maxComparisons: number;
}

/** Prepared matcher for one exact-recognition visibility scope. */
export interface ISuggestionMatcher {
  /**
   * Finds one uniquely closest registered spelling without changing recognition.
   *
   * @param input Unrecognized command or long-option name without dash prefixes.
   * @returns Registered presentation spelling, or `undefined` when no safe hint is available.
   */
  find(input: string): string | undefined;
}

/** Invocation-owned factory that shares one bounded work budget across visibility scopes. */
export interface ISuggestionSession {
  /**
   * Prepares and deduplicates the registered spellings for one visibility scope.
   *
   * @param candidates Registered names accepted by exact recognition in that scope.
   * @returns A cached matcher that consumes this session's shared budget.
   */
  createMatcher(candidates: readonly string[]): ISuggestionMatcher;
  /** Returns a read-only snapshot of work consumed by this invocation. */
  getUsage(): Readonly<ISuggestionUsage>;
}

/** Stores one registered spelling and its reusable diagnostic-only normalized form. */
interface IPreparedCandidate {
  registered: string;
  normalized: string;
}

/** Mutable counters owned by one parser execution and shared by its matchers. */
export interface ISuggestionUsage {
  /** Distinct normalized misspellings admitted for evaluation. */
  lookups: number;
  /** Complete candidate comparisons reserved and performed. */
  comparisons: number;
}

/**
 * Creates one deterministic similarity-work budget for a parser execution.
 *
 * A matcher omits a hint unless it can compare every relevant candidate. This preserves unique
 * best-match and tie semantics without allowing attacker-controlled partial scans.
 *
 * @param overrides Smaller or larger internal limits used by focused tests and future tuning.
 * @returns A factory for scope-specific cached matchers.
 */
export function createSuggestionSession(
  overrides: Partial<ISuggestionLimits> = {}
): ISuggestionSession {
  const limits: ISuggestionLimits = {
    maxLookups: normalizeLimit(overrides.maxLookups, DEFAULT_MAX_LOOKUPS),
    maxCandidatesPerLookup: normalizeLimit(
      overrides.maxCandidatesPerLookup,
      DEFAULT_MAX_CANDIDATES_PER_LOOKUP
    ),
    maxComparisons: normalizeLimit(overrides.maxComparisons, DEFAULT_MAX_COMPARISONS),
  };
  const usage: ISuggestionUsage = { lookups: 0, comparisons: 0 };

  return {
    createMatcher(candidates: readonly string[]): ISuggestionMatcher {
      return createMatcher(candidates, limits, usage);
    },
    getUsage(): Readonly<ISuggestionUsage> {
      return { ...usage };
    },
  };
}

/**
 * Finds a suggestion in a standalone candidate collection.
 *
 * This convenience API creates a fresh bounded session. Parser orchestration should reuse one
 * session so repeated issues share caching and total-work limits.
 *
 * @param input Unrecognized spelling.
 * @param candidates Registered presentation spellings.
 * @returns The uniquely closest eligible spelling, or `undefined`.
 */
export function findSuggestion(input: string, candidates: readonly string[]): string | undefined {
  return createSuggestionSession().createMatcher(candidates).find(input);
}

/** Prepares one scope and caches results by diagnostic-only normalized misspelling. */
function createMatcher(
  candidates: readonly string[],
  limits: ISuggestionLimits,
  usage: ISuggestionUsage
): ISuggestionMatcher {
  const prepared = prepareCandidates(candidates);
  const cache = new Map<string, string | undefined>();

  return {
    find(input: string): string | undefined {
      if (!isEligibleLength(input)) {
        return undefined;
      }

      const normalizedInput = input.toLowerCase();
      if (cache.has(normalizedInput)) {
        return cache.get(normalizedInput);
      }
      if (usage.lookups >= limits.maxLookups) {
        return undefined;
      }
      usage.lookups += 1;

      const relevant = prepared.filter(candidate => isRelevantLength(input, candidate.registered));
      const remainingComparisons = limits.maxComparisons - usage.comparisons;
      if (
        relevant.length > limits.maxCandidatesPerLookup ||
        relevant.length > remainingComparisons
      ) {
        cache.set(normalizedInput, undefined);
        return undefined;
      }

      usage.comparisons += relevant.length;
      const suggestion = findUniqueBest(normalizedInput, input.length, relevant);
      cache.set(normalizedInput, suggestion);
      return suggestion;
    },
  };
}

/** Deduplicates exact presentation spellings and normalizes each candidate once per scope. */
function prepareCandidates(candidates: readonly string[]): IPreparedCandidate[] {
  return [...new Set(candidates)]
    .filter(isEligibleLength)
    .map(registered => ({ registered, normalized: registered.toLowerCase() }));
}

/** Applies the accepted distance threshold using both compared spelling lengths. */
function isRelevantLength(input: string, candidate: string): boolean {
  const maximumDistance = Math.min(input.length, candidate.length) >= 8 ? 2 : 1;
  return Math.abs(input.length - candidate.length) <= maximumDistance;
}

/** Computes a unique best match after the caller has reserved the complete lookup budget. */
function findUniqueBest(
  normalizedInput: string,
  inputLength: number,
  candidates: readonly IPreparedCandidate[]
): string | undefined {
  let bestCandidate: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestIsTied = false;

  for (const candidate of candidates) {
    const maximumDistance = Math.min(inputLength, candidate.registered.length) >= 8 ? 2 : 1;
    const distance = damerauLevenshtein(normalizedInput, candidate.normalized).steps;
    if (distance > maximumDistance) {
      continue;
    }
    if (distance < bestDistance) {
      bestCandidate = candidate.registered;
      bestDistance = distance;
      bestIsTied = false;
    } else if (distance === bestDistance) {
      bestIsTied = true;
    }
  }

  return bestIsTied ? undefined : bestCandidate;
}

/** Rejects names that are too short to distinguish safely or too long to compare cheaply. */
function isEligibleLength(value: string): boolean {
  return value.length >= 4 && value.length <= MAX_SUGGESTION_LENGTH;
}

/** Converts an optional numeric override into a deterministic non-negative integer. */
function normalizeLimit(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Math.max(0, Math.floor(value));
}
