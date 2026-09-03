import { ObjectSchema, ReferenceSchema, SchemaUtils } from '../schema/index.js';
import { SchemaObject } from '../schema/schema-object.js';
import { Generator, GeneratorOptions } from './generator.js';

/**
 * Configuration options for the TypeScript type generator.
 * Currently empty but reserved for future extensibility.
 */
export interface TypeGeneratorOptions extends GeneratorOptions {}

/**
 * TypeScript Type Generator
 *
 * Generates TypeScript type definitions from schema objects. This generator converts
 * schema definitions (primitives, objects, references) into properly formatted TypeScript
 * types and interfaces with support for:
 *
 * - Type aliases and interfaces
 * - Optional properties
 * - Nullable types
 * - Array types
 * - Partial types
 * - Reference types
 * - JSDoc comments and descriptions
 */
export class TypeGenerator extends Generator {
  /**
   * Creates a new TypeScript type generator instance.
   *
   * @param options - Configuration options for the generator (currently unused but reserved for future use)
   */
  constructor(options?: TypeGeneratorOptions) {
    super(options);
  }

  /**
   * Renders a reference schema to TypeScript type syntax.
   *
   * Reference schemas point to other schema objects and are rendered as type aliases.
   * If the reference has a parent (is a property), it renders inline without export.
   * Otherwise, it creates an exported type alias.
   *
   * @param obj - The reference schema object to render
   * @returns Array of TypeScript code lines representing the reference type
   */
  protected renderReferenceSchema(obj: ReferenceSchema) {
    const lines: string[] = [];
    const data = obj.getData();
    const typeName = SchemaUtils.getTypeScriptName(obj);

    if (data.parent) {
      // Render as inline property type (no export)
      if (!data.ref?.isRendered()) {
        if (!data.ref?.getName()) {
          throw new Error(`Referenced schema is not named!`);
        }
        this.lines.push(...this.renderInternal(data.ref!));
      }
      lines.push(this.modifiers(data.ref?.getData().tsType || '', obj) || '');
    } else {
      // Render as exported type alias
      this.addDescription(obj, lines);
      lines.push(
        'export',
        'type',
        typeName,
        '=',
        this.modifiers(data.ref?.getData().tsType || '', obj) || ''
      );
      obj.setData({ rendered: true, tsType: typeName });
    }
    return this.sanitize(lines);
  }

  /**
   * Renders an object schema to TypeScript interface or type syntax.
   *
   * Object schemas are rendered as either interfaces (preferred for plain objects)
   * or type aliases (when modifiers like Partial, nullable, or array are applied).
   * Properties are rendered recursively with proper optional markers and types.
   *
   * @param obj - The object schema to render
   * @returns Array of TypeScript code lines representing the object type
   */
  protected renderObjectSchema(obj: ObjectSchema) {
    const lines: string[] = [];
    const data = obj.getData();

    const props: string[] = ['{'];

    /**
     * Creates the property definitions for the object.
     * Iterates through all properties and renders each with:
     * - JSDoc description (if present)
     * - Optional marker (?) if property is optional
     * - Recursively rendered type
     */
    const createProps = () => {
      Object.entries(obj.getProperties()).forEach(([propName, propObj]) => {
        const { optional } = propObj.getData();
        this.addDescription(propObj, props, true);
        props.push(`${propName}${optional ? '?' : ''}:${this.renderInternal(propObj)}`);
      });
      props.push('}');
      return this.sanitize(props, '\n');
    };

    if (data.parent) {
      // Render as inline property type (nested object)
      const targetType = obj.isRendered()
        ? this.modifiers(data.tsType, obj)
        : this.modifiers(createProps(), obj);
      lines.push(this.sanitize([targetType]));
    } else {
      // Render as exported interface or type
      const { declType, equalSign } = this.getDeclaration(obj);
      const typeName = SchemaUtils.getTypeScriptName(obj);
      const targetType = declType === 'type' ? this.modifiers(createProps(), obj) : createProps();
      this.addDescription(obj, lines);
      lines.push(this.sanitize(['export', declType, typeName, equalSign, targetType]));
      obj.setData({ rendered: true, tsType: typeName });
    }

    return this.sanitize(lines);
  }

  /**
   * Renders primitive type schemas (string, number, boolean, date, any) to TypeScript.
   *
   * Primitive schemas represent basic TypeScript types and are rendered as type aliases
   * when exported, or inline types when used as properties.
   *
   * @param obj - The primitive schema object to render
   * @returns Array of TypeScript code lines representing the primitive type
   */
  protected renderPrimitiveTypeSchema(obj: SchemaObject) {
    let lines: string[] = [];
    const data = obj.getData();
    const typeName = SchemaUtils.getTypeScriptName(obj) || data.tsType;
    const targetType = obj.isRendered()
      ? data.tsType
      : this.modifiers(data.primitive ? data.tsType : typeName, obj);
    const { declType, equalSign } = this.getDeclaration(obj);

    if (data.parent) {
      // Render as inline property type
      lines.push(this.sanitize([targetType]));
    } else {
      // Render as exported type alias
      this.addDescription(obj, lines);
      lines.push(this.sanitize(['export', declType, typeName, equalSign, targetType]));
      obj.setData({ rendered: true, tsType: typeName });
    }

    return this.sanitize(lines);
  }

  /**
   * Applies TypeScript type modifiers to a base type.
   *
   * Modifiers are applied in a specific order to ensure correct TypeScript syntax:
   * 1. Partial<T> - Makes all properties optional
   * 2. T[] - Array type
   * 3. T | null - Nullable type
   *
   * @param target - The base type string to apply modifiers to
   * @param obj - The schema object containing modifier flags
   * @returns The modified type string with all applicable modifiers applied
   */
  protected modifiers(target: string | undefined, obj: SchemaObject) {
    const { partial, nullable, arrayed, recordOf } = obj.getData();

    // Apply Partial wrapper first
    if (partial) {
      target = `Partial<${target}>`;
    }

    // Apply array notation second
    if (arrayed) {
      target = `${target}[]`;
    }

    if (recordOf) {
      target = `Record<string,${target}>`;
    }

    // Apply nullable union last
    if (nullable) {
      target = `${target} | null`;
    }

    return target;
  }

  /**
   * Adds JSDoc description comments to the generated TypeScript code.
   *
   * This method generates comprehensive JSDoc comments that include:
   * - Custom description text
   * - Type metadata (@type, @interface)
   * - Modifier annotations (@partial, @array, @optional, @nullable)
   * - Membership information (@memberOf for properties)
   *
   * The comments are formatted as multi-line JSDoc blocks for better readability.
   *
   * @param obj - The schema object to generate description for
   * @param lines - Array to append the description lines to
   * @param isProp - Whether this is a property (affects spacing)
   */
  protected addDescription(obj: SchemaObject, lines: string[], isProp?: boolean) {
    const data = obj.getData();

    // Add declaration type annotation
    if (data.declType) {
      obj.description(`@${data.declType}`);
    }

    // Add modifier annotations
    if (data.partial) {
      obj.description(`@partial`);
    }

    if (data.arrayed) {
      obj.description(`@array`);
    }

    if (data.optional) {
      obj.description('@optional');
    }

    if (data.nullable) {
      obj.description('@nullable');
    }

    // Add parent membership information for properties
    if (data.parent) {
      const parName = SchemaUtils.getTypeScriptName(data.parent) || data.parent.getData().tsType;
      if (parName) {
        obj.description(`@memberOf {${parName}}`);
      }
    }

    // Format and add the complete description block
    if (data.description) {
      const descr = SchemaUtils.formatMultilineComment(data.description).join('\n');
      lines.push(descr);
      if (!isProp) {
        lines.push('\n');
      }
    }
  }

  /**
   * Determines whether to use 'interface' or 'type' declaration for an object schema.
   *
   * Decision logic:
   * - Use 'interface' for plain object schemas without modifiers (preferred in TypeScript)
   * - Use 'type' for objects with modifiers (Partial, array, nullable) or nested objects
   *
   * This ensures idiomatic TypeScript code generation that follows best practices:
   * - Interfaces for object shapes (extensible, better error messages)
   * - Types for unions, intersections, and modified types
   *
   * @param obj - The schema object to determine declaration type for
   * @returns Object containing declaration type ('interface' or 'type'), equal sign, and flag
   */
  protected getDeclaration(obj: SchemaObject) {
    const { arrayed, nullable, partial, parent } = obj.getData();
    const is_object_schema = obj instanceof ObjectSchema;

    // Check if this is an object type that requires 'type' declaration
    // (has modifiers or is nested)
    const is_object_type =
      is_object_schema && parent === undefined && (arrayed || nullable || partial);

    if (is_object_schema && !is_object_type) {
      // Use interface for plain objects (no modifiers, root level)
      obj.setData({ declType: 'interface' });
      return { declType: 'interface', equalSign: '', type_declaration: false };
    } else {
      // Use type for everything else (primitives, modified objects, nested objects)
      obj.setData({ declType: 'type' });
      return { declType: 'type', equalSign: '=', type_declaration: true };
    }
  }
}
