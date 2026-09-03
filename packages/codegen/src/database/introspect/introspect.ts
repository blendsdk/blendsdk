import { PostgreSQLDatabase } from '@blendsdk/postgresql';
import { ObjectSchema } from '../../schema/object-schema.js';
import { SchemaContainer } from '../../schema/schema-container.js';
import { SchemaObject } from '../../schema/schema-object.js';
import { SchemaScope } from '../../schema/schema-scope.js';
import { INTROSPECTION_SQL } from './introspect-query.js';
import { ColumnIntrospection } from './introspect-types.js';

export type ColumnMapper = (r: ColumnIntrospection, s: SchemaScope) => SchemaObject | unknown;

type TypesIndex = Record<string, SchemaObject>;

export interface ConstantType {
  [name: string]: string[];
}

export class PostgreSQLIntrospector {
  protected db: PostgreSQLDatabase;

  constructor(db: PostgreSQLDatabase) {
    this.db = db;
  }

  protected createTypes(
    schema: SchemaContainer,
    records: ColumnIntrospection[],
    mapper: ColumnMapper | undefined,
    index: TypesIndex
  ) {
    records.forEach(r => {
      const type_name: string = [r.schema_name, r.relation_name].join('_');

      // fix the arrays
      if (r.pg_type[0] == '_' && r.is_array) {
        r.pg_type = r.pg_type.slice(1);
      }

      let type: ObjectSchema;
      const s = schema.scope(r.schema_name);

      let prop: SchemaObject | undefined = undefined;

      if (mapper) {
        prop = mapper(r, s) as SchemaObject;
      }

      if (!prop && r.enum_labels) {
        const [schema_name, relation_name] = r.enum_type_name?.split('.') || [];
        const enumObj = schema.find(
          (schema_name == 'public' ? undefined : schema_name)!,
          relation_name
        );
        prop = s.ref(enumObj!);
      }

      if (!prop) {
        prop = this.mapPgTypeToTypescript(r, s) as SchemaObject;
      }

      if (!prop) {
        const warnMessage = `[WARNING]: ${r.schema_name || 'public'} -> ${r.relation_name} -> ${r.pg_type} could not be mapped!`;
        console.log(warnMessage);
        prop = s.any().description(`@deprecated ${warnMessage}`);
      }

      if (r.is_array) {
        prop.arrayed();
      }

      if (r.is_nullable) {
        prop.nullable().optional();
      }

      prop.metadata({ introspect: r });

      if (!index[type_name]) {
        index[type_name] = s.object({}).named(r.relation_name).description(r.table_comment!);
      }

      type = index[type_name] as ObjectSchema;

      if (r.has_default) {
        prop.description(`@default ${r.column_default}`);
        type.description(`@default ${r.column_name} to ${r.column_default}`);
        prop.optional();
      }

      if (r.is_primary_key) {
        prop.description('@primaryKey');
        type.description(`@primaryKey ${r.column_name}`);
      }

      if (r.is_unique) {
        prop.description('@unique');
        type.description(`@unique ${r.column_name}`);
      }

      if (r.check_constraints) {
        prop.description(`@checkContraint ${r.check_constraints}`);
        type.description(`@checkContraint ${r.column_name} ${r.check_constraints}`);
      }

      type.properties({
        [r.column_name]: prop.description(r.column_comment!),
      });
    });
  }

  protected createEnumTypes(schema: SchemaContainer, records: ColumnIntrospection[]) {
    const types: Record<string, { s: SchemaScope; values: string[]; r: ColumnIntrospection }> = {};
    records.forEach(r => {
      const type_name: string = [r.schema_name, r.relation_name].join('_');
      if (!types[type_name]) {
        types[type_name] = { s: schema.scope(r.schema_name), values: [], r };
      }
      types[type_name].values.push(r.column_name);
    });
    Object.entries(types).forEach(([_name, data]) => {
      const type = !isNaN(Number(data.values[0])) ? data.s.number() : data.s.string();
      type.enum(data.values).named(data.r.relation_name).description(data.r.table_comment!);
    });
  }

  async introstectConstantTypes() {
    let { records } = await this.db.executeQuery<ColumnIntrospection>(INTROSPECTION_SQL);

    records = records
      .map(r => {
        r.schema_name = (r.schema_name === 'public' ? undefined : r.schema_name)!;
        return r;
      })
      .filter(
        r =>
          r.relation_kind === 'table' ||
          r.relation_kind === 'view' ||
          r.relation_kind === 'materialized view' ||
          r.relation_kind === 'partitioned table'
      );

    const result: ConstantType = {};

    records.forEach(r => {
      const constName = [r.schema_name, r.relation_name].filter(Boolean).join('.');
      if (!result[constName]) {
        result[constName] = [];
      }
      result[constName].push(r.column_name);
    });

    return result;
  }

  async introspect(schema: SchemaContainer, mapper?: ColumnMapper) {
    let { records } = await this.db.executeQuery<ColumnIntrospection>(INTROSPECTION_SQL);
    const index: Record<string, ObjectSchema> = {};

    records = records.map(r => {
      r.schema_name = (r.schema_name === 'public' ? undefined : r.schema_name)!;
      return r;
    });

    this.createEnumTypes(
      schema,
      records.filter(r => r.relation_kind === 'enum type')
    );

    this.createTypes(
      schema,
      records.filter(r => r.relation_kind === 'composite type'),
      mapper,
      index
    );

    records = records.filter(
      r => !['composite type', 'domain type', 'enum type'].includes(r.relation_kind)
    );

    this.createTypes(schema, records, mapper, index);
  }

  protected mapPgTypeToTypescript(data: ColumnIntrospection, s: SchemaScope): SchemaObject | null {
    let { pg_type } = data; // arrays handled elsewhere

    switch (pg_type) {
      // ----- Booleans -----
      case 'bool':
        return s.boolean();

      // ----- Textual -----
      case 'text':
      case 'varchar':
      case 'char':
      case 'bpchar':
      case 'name':
        return s.string();

      // ----- JSON, XML, JSONPath -----
      case 'json':
      case 'jsonb':
      case 'xml':
      case 'jsonpath':
        return null; // handled elsewhere

      // ----- UUID -----
      case 'uuid':
        return s.string();

      // ----- Network / Address-like -----
      case 'inet':
      case 'cidr':
      case 'macaddr':
      case 'macaddr8':
        return s.string();

      // ----- Monetary / Bits -----
      case 'money':
      case 'bit':
      case 'varbit':
        return s.string();

      // ----- Binary -----
      case 'bytea':
        return null; // pg returns Buffer, handled elsewhere

      // ----- Numeric families -----
      case 'int2': // SMALLINT
      case 'int4': // INTEGER
      case 'serial': // SERIAL alias
        return s.number();

      case 'float4':
      case 'float8':
        return s.number();

      case 'numeric':
      case 'decimal':
        return s.string(); // pg returns as string to preserve precision

      case 'int8': // BIGINT
      case 'bigserial': // BIGSERIAL alias
        return s.string(); // pg returns bigint as string

      // ----- Date/Time -----
      case 'date':
        return s.string(); // pg returns string 'YYYY-MM-DD'

      case 'time':
      case 'timetz':
        return s.string(); // pg returns time as string

      case 'timestamp':
      case 'timestamptz':
        return s.date(); // pg returns JS Date

      case 'interval':
        return null; // pg returns structured object, handled elsewhere

      // ----- Text Search -----
      case 'tsvector':
      case 'tsquery':
        return s.string();

      // ----- System OIDs / IDs -----
      case 'oid':
      case 'xid':
      case 'cid':
        return s.number();

      case 'xid8':
      case 'tid':
        return s.string(); // textual identifiers

      // ----- Write-Ahead Log / TX Snapshot -----
      case 'pg_lsn':
      case 'txid_snapshot':
        return s.string();

      // ----- reg* identifier types -----
      case 'regclass':
      case 'regtype':
      case 'regproc':
      case 'regprocedure':
      case 'regoper':
      case 'regoperator':
      case 'regdictionary':
      case 'regconfig':
      case 'regcollation':
      case 'regnamespace':
      case 'regrole':
        return s.string();

      // ----- Range / Geometry / Unsupported -----
      case 'int4range':
      case 'int8range':
      case 'numrange':
      case 'tsrange':
      case 'tstzrange':
      case 'daterange':
      case 'point':
      case 'line':
      case 'lseg':
      case 'box':
      case 'path':
      case 'polygon':
      case 'circle':
        return null;

      default:
        return null;
    }
  }
}
