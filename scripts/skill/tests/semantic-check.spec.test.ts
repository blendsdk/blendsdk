/**
 * Specification tests for the semantic example checker.
 *
 * The checker type-checks extracted example blocks against the real SDK and
 * splits the findings in two: API problems (a package, symbol, or member the
 * SDK does not have) and type problems (everything else the compiler reports).
 * This split lets CI gate the API problems while the repair tool fixes the
 * rest locally.
 *
 * Every test runs against a throwaway monorepo seeded from `tests/fixtures/`.
 *
 * @module skill/tests/semantic-check.spec
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkSemantics } from '../semantic-check.js';
import { createFixtureWorkspace } from './helpers/fixture-workspace.js';
import { writeWidgetUmbrella, WIDGET_REFERENCE_PATH } from './helpers/widget-fixture.js';

import type { FixtureWorkspace } from './helpers/fixture-workspace.js';
import type { SemanticBlock } from '../semantic-check.js';

/**
 * Builds one example block for the widget fixture.
 *
 * @param code - Lines of the block body
 * @param startLine - One-based line where the body starts in the reference
 * @returns A semantic block input
 */
function block(code: string[], startLine = 4): SemanticBlock {
  return { reference: WIDGET_REFERENCE_PATH, startLine, code: code.join('\n') };
}

describe('Semantic example checker', () => {
  let workspace: FixtureWorkspace;

  beforeEach(() => {
    workspace = createFixtureWorkspace();
    writeWidgetUmbrella(workspace.rootDir, true);
  });

  afterEach(() => {
    workspace.cleanup();
  });

  it('should classify a missing member as an API problem', () => {
    const problems = checkSemantics(workspace.rootDir, [
      block([
        "import { Widget } from 'blendsdk/widget';",
        '',
        'const widget = new Widget();',
        'widget.nope();',
      ]),
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0].tier).toBe('api');
    expect(problems[0].code).toBe(2339);
    expect(problems[0].reference).toBe(WIDGET_REFERENCE_PATH);
  });

  it('should classify an incompatible type as a type problem', () => {
    const problems = checkSemantics(workspace.rootDir, [
      block([
        "import { Widget } from 'blendsdk/widget';",
        '',
        'const count: number = new Widget();',
      ]),
    ]);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every(problem => problem.tier === 'type')).toBe(true);
  });

  it('should report nothing for a correct block', () => {
    const problems = checkSemantics(workspace.rootDir, [
      block([
        "import { Widget } from 'blendsdk/widget';",
        '',
        'const widget = new Widget();',
        'console.log(widget.label);',
      ]),
    ]);

    expect(problems).toEqual([]);
  });
});
