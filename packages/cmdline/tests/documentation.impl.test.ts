import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** Package-owned AI-training pages audited for the strict parsing contract. */
const trainingPages = [
  '00-overview.md',
  '01-core-concepts.md',
  '02-basic-usage.md',
  '03-advanced-patterns.md',
  '04-best-practices.md',
  '05-common-scenarios.md',
  '06-testing-patterns.md',
  '07-troubleshooting.md',
  '08-api-reference.md',
  '09-examples-library.md',
  'README.md',
] as const;

/** Reads one package-owned training page relative to this test module. */
function trainingPage(name: (typeof trainingPages)[number]): string {
  return readFileSync(new URL(`../ai-training/${name}`, import.meta.url), 'utf8');
}

describe('cmdline package documentation contract', () => {
  it('keeps strict rejection, clean help, hints, legacy default, and caller exit policy aligned', () => {
    const corpus = trainingPages.map(trainingPage).join('\n');

    expect(corpus).toContain('strict: true');
    expect(corpus).toContain('CommandLineValidationError');
    expect(corpus).toContain('process.exitCode');
    expect(corpus).toContain('Did you mean');
    expect(corpus.toLowerCase()).toContain('legacy mode remains the v5 default');
    expect(corpus).toContain('clean help');
  });

  it.each(trainingPages)(
    'contains no stale package subpath or manual reserved help option in %s',
    page => {
      const content = trainingPage(page);

      expect(content).not.toMatch(/from ['"]@blendsdk\/cmdline\//);
      expect(content).not.toMatch(/name:\s*['"]help['"]/);
      expect(content).not.toContain('process.exit(1)');
    }
  );

  it('keeps the focused example on typed rejection and caller-owned exit policy', () => {
    const example = readFileSync(
      new URL('../examples/03-error-handling.ts', import.meta.url),
      'utf8'
    );

    expect(example).toContain('strict: true');
    expect(example).toContain('CommandLineValidationError');
    expect(example).toContain('CommandLineErrorHandlerError');
    expect(example).toContain('process.exitCode = 1');
    expect(example).toContain('Did you mean');
    expect(example).not.toMatch(/process\.exit\s*\(/);
  });
});
