import { describe, expect, it } from 'vitest';

import { createSuggestionSession, findSuggestion } from '../src/suggestions.js';

describe('similarity suggestion helper', () => {
  it('accepts one adjacent transposition within the short-name boundary', () => {
    expect(findSuggestion('hlep', ['help'])).toBe('help');
  });

  it('rejects two edits when the shorter spelling is below eight characters', () => {
    expect(findSuggestion('abxdxf', ['abcdef'])).toBeUndefined();
  });

  it('accepts two edits only when both spellings are at least eight characters', () => {
    expect(findSuggestion('abczefgy', ['abcdefgh'])).toBe('abcdefgh');
    expect(findSuggestion('abczefg', ['abcdefgh'])).toBeUndefined();
  });

  it('compares case-insensitively while preserving registered presentation spelling', () => {
    expect(findSuggestion('deploy', ['Deploy'])).toBe('Deploy');
  });

  it('returns no result when the best distance is tied', () => {
    expect(findSuggestion('task', ['bask', 'mask'])).toBeUndefined();
  });

  it('deduplicates identical registered spellings before tie evaluation', () => {
    expect(findSuggestion('deply', ['deploy', 'deploy'])).toBe('deploy');
  });

  it('allows names at the 128-character resource boundary', () => {
    const candidate = `a${'b'.repeat(127)}`;
    const input = `a${'b'.repeat(126)}c`;

    expect(findSuggestion(input, [candidate])).toBe(candidate);
  });

  it('skips comparison when either spelling exceeds 128 characters', () => {
    const longName = `a${'b'.repeat(128)}`;

    expect(findSuggestion(longName, ['acceptable'])).toBeUndefined();
    expect(findSuggestion('acceptable', [longName])).toBeUndefined();
  });

  it('caches repeated misspellings without consuming additional comparison budget', () => {
    const session = createSuggestionSession({
      maxLookups: 2,
      maxCandidatesPerLookup: 2,
      maxComparisons: 1,
    });
    const matcher = session.createMatcher(['deploy']);

    expect(matcher.find('deply')).toBe('deploy');
    expect(matcher.find('DEPLY')).toBe('deploy');
    expect(session.getUsage()).toEqual({ lookups: 1, comparisons: 1 });
  });

  it('omits a hint unless the complete relevant candidate set fits the remaining budget', () => {
    const session = createSuggestionSession({
      maxLookups: 2,
      maxCandidatesPerLookup: 2,
      maxComparisons: 1,
    });
    const oversizedLookup = session.createMatcher(['deploy', 'reply']);
    const completeLookup = session.createMatcher(['deploy']);

    expect(oversizedLookup.find('deply')).toBeUndefined();
    expect(session.getUsage()).toEqual({ lookups: 1, comparisons: 0 });
    expect(completeLookup.find('deply')).toBe('deploy');
    expect(session.getUsage()).toEqual({ lookups: 2, comparisons: 1 });
  });

  it('stops evaluating distinct misspellings at the invocation lookup limit', () => {
    const session = createSuggestionSession({
      maxLookups: 1,
      maxCandidatesPerLookup: 2,
      maxComparisons: 2,
    });
    const matcher = session.createMatcher(['deploy']);

    expect(matcher.find('deply')).toBe('deploy');
    expect(matcher.find('depoy')).toBeUndefined();
    expect(session.getUsage()).toEqual({ lookups: 1, comparisons: 1 });
  });

  it('omits a hint when the complete candidate set exceeds the per-lookup limit', () => {
    const session = createSuggestionSession({
      maxLookups: 1,
      maxCandidatesPerLookup: 1,
      maxComparisons: 10,
    });
    const matcher = session.createMatcher(['deploy', 'reply']);

    expect(matcher.find('deply')).toBeUndefined();
    expect(session.getUsage()).toEqual({ lookups: 1, comparisons: 0 });
  });
});
