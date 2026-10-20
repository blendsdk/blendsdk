/**
 * Shared `widget` package fixture for the validator and repair specification
 * tests.
 *
 * The fixture writes a tiny umbrella package, the compiled `widget`
 * declarations, and the `widget` source into a throwaway workspace. Tests use
 * it to resolve `blendsdk/widget` against a real declaration file.
 *
 * @module skill/tests/helpers/widget-fixture
 */

import fs from 'node:fs';
import path from 'node:path';

import { FIXTURE_SDK_VERSION } from './fixture-workspace.js';

/** Reference path used by the widget fixtures, relative to the skill directory. */
export const WIDGET_REFERENCE_PATH = 'references/packages/widget/usage.md';

/** Source surface for the `widget` package. */
export const WIDGET_SOURCE = [
  'export class Widget {',
  '  label = "";',
  '}',
  '',
  'export interface WidgetOptions {',
  '  label: string;',
  '}',
  '',
].join('\n');

/** Compiled declaration for the `widget` package. */
export const WIDGET_DECLARATION = [
  'export declare class Widget {',
  '  label: string;',
  '}',
  '',
  'export interface WidgetOptions {',
  '  label: string;',
  '}',
  '',
].join('\n');

/**
 * Writes the umbrella package, its compiled `widget` declarations, and the
 * `widget` source package into a workspace.
 *
 * @param rootDir - Absolute path to the workspace root
 * @param withDist - When false, the compiled umbrella output is omitted to
 *   simulate running before a build
 */
export function writeWidgetUmbrella(rootDir: string, withDist: boolean): void {
  const umbrellaDir = path.join(rootDir, 'packages', 'blendsdk');
  fs.writeFileSync(
    path.join(umbrellaDir, 'package.json'),
    JSON.stringify(
      {
        name: 'blendsdk',
        version: FIXTURE_SDK_VERSION,
        exports: {
          './widget': {
            types: './dist/widget/index.d.ts',
            import: './dist/widget/index.js',
          },
        },
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );

  const widgetSourceDir = path.join(rootDir, 'packages', 'widget', 'src');
  fs.mkdirSync(widgetSourceDir, { recursive: true });
  fs.writeFileSync(path.join(widgetSourceDir, 'index.ts'), WIDGET_SOURCE, 'utf-8');

  if (!withDist) {
    return;
  }

  const widgetDistDir = path.join(umbrellaDir, 'dist', 'widget');
  fs.mkdirSync(widgetDistDir, { recursive: true });
  fs.writeFileSync(path.join(widgetDistDir, 'index.d.ts'), WIDGET_DECLARATION, 'utf-8');
  fs.writeFileSync(path.join(widgetDistDir, 'index.js'), '', 'utf-8');
}
