import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const directRoot = path.join(repositoryRoot, 'packages', 'blendscript');
const umbrellaRoot = path.join(repositoryRoot, 'packages', 'blendsdk');
const documentationRoot = path.join(repositoryRoot, 'packages', 'blendsdk-docs', 'docs');

function readJson(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a JSON object in ' + filePath + '.');
  }
  return value;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected ' + label + ' to be an object.');
  }
  return value;
}

function listFiles(directory: string, relative = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(directory, child));
    else files.push(child.split(path.sep).join('/'));
  }
  return files.sort();
}

describe('BlendScript distribution implementation', () => {
  it('should use exact direct and umbrella manifest ownership', () => {
    const direct = readJson(path.join(directRoot, 'package.json'));
    const umbrella = readJson(path.join(umbrellaRoot, 'package.json'));
    const umbrellaExports = readRecord(umbrella.exports, 'umbrella exports');
    const blendScriptExport = readRecord(
      umbrellaExports['./blendscript'],
      'umbrella BlendScript export'
    );
    const developmentDependencies = readRecord(
      umbrella.devDependencies,
      'umbrella development dependencies'
    );

    expect(direct.files).toEqual(['dist']);
    expect(direct.dependencies).toBeUndefined();
    expect(blendScriptExport).toEqual({
      types: './dist/blendscript/index.d.ts',
      import: './dist/blendscript/index.js',
    });
    expect(developmentDependencies['@blendsdk/blendscript']).toBe(direct.version);
    expect(umbrella.files).toEqual(['dist', 'README.md']);
  });

  it('should assemble the direct build byte-for-byte without private imports', () => {
    const directDist = path.join(directRoot, 'dist');
    const umbrellaDist = path.join(umbrellaRoot, 'dist', 'blendscript');
    const directFiles = listFiles(directDist);
    const umbrellaFiles = listFiles(umbrellaDist);
    expect(umbrellaFiles).toEqual(directFiles);

    for (const filePath of umbrellaFiles.filter(candidate => /\.(?:js|d\.ts)$/.test(candidate))) {
      expect(readFileSync(path.join(umbrellaDist, filePath), 'utf8')).toBe(
        readFileSync(path.join(directDist, filePath), 'utf8')
      );
      expect(readFileSync(path.join(umbrellaDist, filePath), 'utf8')).not.toContain('@blendsdk/');
    }
  });

  it('should register exactly one assembly and verifier entry', () => {
    const assembler = readFileSync(path.join(repositoryRoot, 'scripts', 'assemble.ts'), 'utf8');
    const verifier = readFileSync(
      path.join(repositoryRoot, 'scripts', 'verify-assembly-exports.ts'),
      'utf8'
    );
    expect(assembler.match(/name: 'blendscript'/g)).toHaveLength(1);
    expect(assembler).toContain("srcDir: 'packages/blendscript/dist'");
    expect(assembler).toContain("destDir: 'blendscript'");
    expect(verifier.match(/name: 'blendscript'/g)).toHaveLength(1);
    for (const exportName of [
      'validateExpression',
      'compileExpression',
      'evaluateExpression',
      'BlendScriptApiError',
    ]) {
      expect(verifier).toContain("'" + exportName + "'");
    }
  });

  it('should generate documentation only through the existing source owners', () => {
    const overview = readFileSync(path.join(directRoot, 'ai-training', '00-overview.md'), 'utf8');
    const identifyingSentence =
      'BlendScript is a deterministic expression language for business rules.';
    const courseTitle = '# BlendScript Course';
    const packageDocumentation = readFileSync(
      path.join(documentationRoot, 'packages', 'blendscript.md'),
      'utf8'
    );
    const mcpPackageDocumentation = readFileSync(
      path.join(
        repositoryRoot,
        'packages',
        'blendsdk-mcp',
        'docs',
        '02-packages',
        'blendscript.md'
      ),
      'utf8'
    );
    expect(overview).toContain(identifyingSentence);
    expect(packageDocumentation).toContain(identifyingSentence);
    expect(packageDocumentation).not.toContain(courseTitle);
    expect(mcpPackageDocumentation).toContain(identifyingSentence);
    expect(mcpPackageDocumentation).not.toContain(courseTitle);
    expect(
      readFileSync(path.join(documentationRoot, 'guides', 'blendscript-v1.md'), 'utf8')
    ).toContain(courseTitle);
    expect(readFileSync(path.join(documentationRoot, '.vitepress', 'config.ts'), 'utf8')).toContain(
      "{ text: 'BlendScript Course', link: '/guides/blendscript-v1' }"
    );
    expect(existsSync(path.join(directRoot, 'docs'))).toBe(false);
  });
});
