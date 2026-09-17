import { SchemaObject } from './schema-object.js';

export class SchemaUtils {
  
  static getTypeScriptName(obj: SchemaObject) {
    return this.snakeToPascalCase(obj.getNamedScoped());
  }

  static snakeToPascalCase(str: string): string {
    // If no underscores, just capitalize first letter and preserve rest

    str = str.replace(/__/g, '+').replace(/\./g, '_');

    if (!str.includes('_')) {
      return str.charAt(0).toUpperCase() + str.slice(1);
    }

    // Split by underscore and capitalize each word
    return str
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join('')
      .replace(/\+/gi, '_');
  }

  /**
   * Formats an array of text lines into properly structured comments.
   * Supports multiple comment styles including JSDoc, block comments, and line comments.
   * Handles both single-line and multi-line comment formatting automatically.
   *
   * @param {string[]} lines - Array of text lines to format as comments
   * @param {('jsdoc' | 'block' | 'line')} [style='block'] - The comment style to apply
   * @return {string[]} Array of formatted comment lines ready for code insertion
   * @memberof GeneratorBase
   */
  static formatMultilineComment(lines: string[], style: 'jsdoc' | 'block' | 'line' = 'jsdoc'): string[] {
    if (lines.length === 0) {
      return [];
    }

    switch (style) {
      case 'jsdoc':
        return ['/**', ...lines.map(line => ` * ${line}`), ' */'];

      case 'block':
        if (lines.length === 1) {
          return [`/* ${lines[0]} */`];
        }
        return ['/*', ...lines.map(line => ` * ${line}`), ' */'];

      case 'line':
        return lines.map(line => `// ${line}`);

      default:
        return lines.map(line => `/* ${line} */`);
    }
  }
}
