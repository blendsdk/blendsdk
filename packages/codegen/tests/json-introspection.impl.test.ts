import { describe, expect, test } from 'vitest';
import { TypeGenerator, ZodGenerator } from '../src/generator/index.js';
import { SchemaContainer } from '../src/schema/index.js';

describe('unknown schema implementation details', () => {
  test('renders a standalone unknown primitive', async () => {
    const container = new SchemaContainer();
    container.scope().unknown().named('payload');

    const typeSource = await new TypeGenerator().generate(container);
    const zodSource = await new ZodGenerator().generate(container);

    expect(typeSource).toContain('export type Payload = unknown;');
    expect(zodSource).toContain('export const PayloadSchema = z.unknown();');
  });

  test('applies the array modifier in TypeScript and nullable in both generators', async () => {
    const arrayContainer = new SchemaContainer();
    arrayContainer.scope().unknown().arrayed().named('payloads');
    const arrayType = await new TypeGenerator().generate(arrayContainer);
    expect(arrayType).toContain('export type Payloads = unknown[];');

    const nullableContainer = new SchemaContainer();
    nullableContainer.scope().unknown().nullable().named('payload');
    const nullableType = await new TypeGenerator().generate(nullableContainer);
    const nullableZod = await new ZodGenerator().generate(nullableContainer);

    expect(nullableType).toContain('export type Payload = unknown | null;');
    expect(nullableZod).toContain('export const PayloadSchema = z.unknown().nullable();');
  });
});
