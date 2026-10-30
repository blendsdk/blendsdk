import { ObjectSchema, ReferenceSchema, SchemaUtils, StringSchema } from '../schema/index.js';
import { SchemaObject } from '../schema/schema-object.js';
import { Generator, GeneratorOptions } from './generator.js';

export interface ZodGeneratorOptions extends GeneratorOptions {
  zodVariablePostfix?: string;
}

export class ZodGenerator extends Generator<ZodGeneratorOptions> {
  constructor(options?: ZodGeneratorOptions) {
    options = {
      zodVariablePostfix: 'schema',
      ...(options || {}),
    };
    super(options);
    this.lines.push(`import * as z from 'zod';`);
  }

  protected getZodVariableName(obj: SchemaObject) {
    return SchemaUtils.snakeToPascalCase(
      this.sanitize([obj.getNamedScoped(), this.options.zodVariablePostfix], '_')
    );
  }

  protected renderReferenceSchema(obj: ReferenceSchema) {
    const lines: string[] = [];
    const data = obj.getData();

    if (!data.ref?.isRendered()) {
      if (!data.ref?.getName()) {
        throw new Error(`Referenced schema is not named!`);
      }
    }

    const zodType = this.modifiers(this.getZodVariableName(data.ref), obj);

    if (data.parent) {
      lines.push(zodType!);
    } else {
      const varName = this.modifiers(this.getZodVariableName(data.ref), obj);
      lines.push(this.sanitize(['export', 'const', varName, '=', zodType]));
    }
    obj.setData({ rendered: true });
    return this.sanitize(lines);
  }

  protected renderObjectSchema(obj: ObjectSchema) {
    const lines: string[] = [];
    const props: string[] = [];

    const data = obj.getData();

    const createProps = () => {
      Object.entries(obj.getProperties()).forEach(([propName, propObj]) => {
        props.push(`${propName}:${this.renderInternal(propObj)}`);
      });
      return this.sanitize(props, ',\n');
    };

    const zodType = this.modifiers(`z.${data.zodType}({${createProps()}})`, obj);

    if (data.parent) {
      lines.push(zodType!);
    } else {
      const varName = this.getZodVariableName(obj);
      lines.push(this.sanitize(['export', 'const', varName, '=', zodType]));
    }
    obj.setData({ rendered: true });
    return this.sanitize(lines);
  }

  protected renderPrimitiveTypeSchema(obj: SchemaObject) {
    let lines: string[] = [];
    const data = obj.getData();
    const base = data.zodExpression ?? `z.${data.zodType}()`;
    const zodType = this.modifiers(base, obj);
    if (data.parent) {
      lines.push(zodType!);
    } else {
      const varName = this.getZodVariableName(obj);
      lines.push(this.sanitize(['export', 'const', varName, '=', zodType]));
    }
    obj.setData({ rendered: true });
    return this.sanitize(lines);
  }

  /**
   * Appends string pattern and length constraints to a Zod expression.
   *
   * Validation is repeated here because this is the last point where the schema has a stable
   * generated variable name, so an invalid pattern produces an actionable diagnostic instead of
   * invalid generated TypeScript.
   *
   * @param target - Base Zod expression, usually `z.string()`
   * @param obj - String schema carrying the constraints
   * @returns The constrained Zod expression
   * @throws {Error} When the stored pattern is not a valid regular expression
   * @memberof ZodGenerator
   */
  protected renderStringConstraints(target: string, obj: StringSchema) {
    const { pattern, minLength, maxLength } = obj.getData();
    let result = target;

    if (pattern !== undefined) {
      try {
        new RegExp(pattern);
      } catch {
        throw new Error(`Invalid pattern for schema ${this.getZodVariableName(obj)}: ${pattern}`);
      }
      result += `.regex(new RegExp(${JSON.stringify(pattern)}))`;
    }
    if (minLength !== undefined) {
      result += `.min(${minLength})`;
    }
    if (maxLength !== undefined) {
      result += `.max(${maxLength})`;
    }

    return result;
  }

  protected modifiers(target: string | undefined, obj: SchemaObject) {
    const { optional, partial, nullable } = obj.getData();

    if (obj instanceof StringSchema) {
      target = this.renderStringConstraints(target ?? '', obj);
    }

    if (partial) {
      target = `${target}.partial()`;
    }

    if (optional) {
      target = `${target}.optional()`;
    }

    // else if (obj instanceof StringSchema) {
    //   target = `${target}.nonempty()`;
    // }

    if (nullable) {
      target = `${target}.nullable()`;
    }

    return target;
  }
}
