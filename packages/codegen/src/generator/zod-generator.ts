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
    const zodType = this.modifiers(`z.${data.zodType}()`, obj);
    if (data.parent) {
      lines.push(zodType!);
    } else {
      const varName = this.getZodVariableName(obj);
      lines.push(this.sanitize(['export', 'const', varName, '=', zodType]));
    }
    obj.setData({ rendered: true });
    return this.sanitize(lines);
  }

  protected modifiers(target: string | undefined, obj: SchemaObject) {
    const { optional, partial, nullable } = obj.getData();

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
