import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { TypeGenerator } from '../src/generator/index.js';
import { SchemaContainer } from '../src/schema/index.js';

describe('sanity', () => {
  test('sanity', () => {
    expect(true).toBeTruthy();
  });
});

describe('common tests', async () => {
  let schema: SchemaContainer;
  let typeGen: TypeGenerator;

  beforeEach(() => {
    schema = new SchemaContainer();
    typeGen = new TypeGenerator();
  });

  afterEach(() => {
    schema.clear();
  });

  test('record type', async () => {
    const s = schema.scope();

    s.any().recordSet().named('dictionary_of_boolean');

    const row = s
      .object({
        id: s.string().optional(),
        name: s.string(),
      })
      .named('Row');

    s.object({
      prop1: s.number().recordSet().enum([1, 2, 3]),
      prop2: s.ref(row).partial().recordSet(),
    }).named('Object1');

    const r = await typeGen.generate(schema);

    console.log(r);

    expect(r).toContain('export type DictionaryOfBoolean = Record<string, any>');
    expect(r).toContain('prop2: Record<string, Partial<Row>>;');
  });

  test('scoped', async () => {
    const s = schema.scope();

    const user = s
      .object({
        username: s.string(),
        password: s.string(),
      })
      .named('user');

    const v1 = schema.scope('api_v1');
    v1.object({
      user: s.ref(user).nullable(),
    }).named('user_request');

    const v2 = schema.scope('api_v2');
    v2.object({
      user: s.ref(user),
    }).named('user_request');

    const r = await typeGen.generate(schema);

    expect(r).toContain('export interface ApiV1UserRequest {');
    expect(r).toContain('export interface ApiV2UserRequest {');
  });

  test('enums number', async () => {
    const s = schema.scope();

    const directions = s.number().named('directions').enum([1, 2, 3]);
    s.object({
      dir: s.ref(directions).arrayed(),
    }).named('object1');

    const r = await typeGen.generate(schema);

    expect(r).toContain('export type Directions = 1 | 2 | 3;');
    expect(r).toContain('dir: Directions[];');
  });

  test('enums string', async () => {
    const s = schema.scope();

    const directions = s.string().named('directions').enum(['up', 'down']);
    s.object({
      dir: s.ref(directions).arrayed(),
    }).named('object1');

    const r = await typeGen.generate(schema);

    expect(r).toContain('export type Directions = "up" | "down";');
    expect(r).toContain('dir: Directions[];');
  });

  test('ref object', async () => {
    const s = schema.scope();

    const object1 = s
      .object({
        prop1: s.object({
          prop11: s.boolean(),
        }),
      })
      .named('object1');

    s.object({
      list: s.ref(object1).arrayed().partial(),
    }).named('object2');

    const r = await typeGen.generate(schema);

    expect(r).toContain('export interface Object1');
    expect(r).toContain('list: Partial<Object1>[];');
  });

  test('nested object type', async () => {
    const s = schema.scope();

    s.object({
      prop1: s.object({
        prop11: s.boolean(),
      }),
    })
      .named('object1')
      .arrayed();

    const r = await typeGen.generate(schema);

    expect(r).toContain('export type Object1 = {');
  });

  test('nested object', async () => {
    const s = schema.scope();

    s.object({
      prop1: s.object({
        prop11: s.boolean(),
      }),
    }).named('object1');

    const r = await typeGen.generate(schema);

    expect(r).toContain('prop1: {');
    expect(r).toContain('export interface Object1 {');
  });

  test('object type modifiers', async () => {
    const s = schema.scope();

    s.object({
      prop1: s.string(),
    }).named('object1');

    s.object({
      prop1: s.string(),
    })
      .named('object2')
      .partial();

    const r = await typeGen.generate(schema);

    expect(r).toContain('export type Object2 = Partial<{');
    expect(r).toContain('export interface Object1 {');
  });

  test('primitive modifiers', async () => {
    const s = schema.scope();
    s.string().named('string1');
    s.string().named('string2').optional();
    s.string().named('string3').nullable();
    s.string().named('string4').arrayed();
    s.string().named('string5').partial();

    const r = await typeGen.generate(schema);

    expect(r).toContain('export type String5 = Partial<string>;');
    expect(r).toContain('export type String4 = string[];');
    expect(r).toContain('export type String3 = string | null;');
    expect(r).toContain('export type String2 = string;');
    expect(r).toContain('export type String1 = string;');
  });

  test('generator sanity', async () => {
    const s = schema.scope();
    s.any();
    const g = new TypeGenerator();
    await g.generate(schema);
  });

  test('object with no scope', () => {
    const s = schema.scope();
    const a = s.any().named('prop1');

    expect(a.getName()).toEqual('prop1');
    expect(a.getScope()).toBeUndefined();
  });

  test('object with scope', () => {
    const s = schema.scope('public');
    const a = s.any().named('prop1');

    expect(a.getName()).toEqual('prop1');
    expect(a.getScope()).toEqual('public');
  });
});
