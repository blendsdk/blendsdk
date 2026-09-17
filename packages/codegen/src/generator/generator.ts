import { format } from 'prettier';
import {
  AnySchema,
  BooleanSchema,
  DateSchema,
  ObjectSchema,
  PrimitiveSchema,
  ReferenceSchema,
  SchemaContainer,
} from '../schema/index.js';
import { SchemaObject } from '../schema/schema-object.js';

export interface GeneratorOptions {}

export abstract class Generator<OptionType extends GeneratorOptions = GeneratorOptions> {
  protected options: OptionType;
  protected lines: string[];

  constructor(options?: OptionType) {
    options || {};
    this.options = { ...(options || {}) } as OptionType;
    this.lines = [];
  }

  async generate(container: SchemaContainer) {
    const objects = container.getAll();

    objects.forEach(o => o.reset());

    objects.forEach(obj => {
      if (obj.getName() && !obj.isRendered()) {
        this.checkObjectNamed(obj);
        this.lines.push(...this.renderInternal(obj));
      }
    });

    const src = this.lines.join('\n\n').trim();

    try {
      return await format(src, { parser: 'typescript' });
    } catch (err) {
      console.log(src);
      throw err;
    }
  }

  protected checkObjectNamed(obj: SchemaObject) {
    const data = obj.getData();
    if (data.parent) {
      throw Error(
        `Object properties cannot be named explicitly. Create a seperate root type (${obj.getNamedScoped()}) and use .ref() as the property.`
      );
    }
  }

  protected renderInternal(obj: SchemaObject) {
    const lines: string[] = [];

    if (!obj.isRendered()) {
      if (
        obj instanceof AnySchema ||
        obj instanceof BooleanSchema ||
        obj instanceof DateSchema ||
        obj instanceof PrimitiveSchema
      ) {
        lines.push(this.renderPrimitiveTypeSchema(obj));
      } else if (obj instanceof ObjectSchema) {
        lines.push(this.renderObjectSchema(obj));
      } else if (obj instanceof ReferenceSchema) {
        lines.push(this.renderReferenceSchema(obj));
      }
    }
    return lines;
  }

  protected abstract renderReferenceSchema(obj: ReferenceSchema): string;

  protected abstract renderObjectSchema(obj: ObjectSchema): string;

  protected abstract renderPrimitiveTypeSchema(obj: SchemaObject): string;

  protected sanitize(params: any[], j?: string) {
    return params.filter(Boolean).join(j || ' ');
  }
}
