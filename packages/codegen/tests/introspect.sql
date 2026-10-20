-- ===== Reset (safe to rerun in a dev DB) =====
DROP SCHEMA IF EXISTS demo_a CASCADE;
DROP SCHEMA IF EXISTS demo_b CASCADE;

-- ===== Shared user-defined types (one-time in pg_catalog namespace scope) =====
-- Create in pg_temp or public; we’ll put them in public so both schemas can use them.
CREATE SCHEMA IF NOT EXISTS public;

-- 1) Enum
DROP TYPE IF EXISTS public.mood_enum CASCADE;
CREATE TYPE public.mood_enum AS ENUM ('sad', 'ok', 'happy');

-- 2) Domain
DROP DOMAIN IF EXISTS public.positive_int_domain CASCADE;
CREATE DOMAIN public.positive_int_domain AS integer
  CHECK (VALUE > 0);

-- 3) Composite type
DROP TYPE IF EXISTS public.address_type CASCADE;
CREATE TYPE public.address_type AS (
  street  text,
  city    text
);

-- ===== Helper: function to seed default values (not strictly necessary) =====
-- None required; we’ll use built-in defaults like now(), gen_random_uuid() is not core.

-- ===== Schema A =====
CREATE SCHEMA demo_a;

-- Tables: demo_a.scalars and demo_a.advanced
CREATE TABLE demo_a.scalars (
  -- Identity & serial flavors (serial expands to sequence + DEFAULT nextval)
  id_identity           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_smallserial        smallserial,
  id_serial             serial,
  id_bigserial          bigserial,

  -- Numeric family
  c_smallint            smallint,
  c_integer             integer,
  c_bigint              bigint,
  c_numeric             numeric(20,5),
  c_decimal_alias       decimal(10,2), -- alias of numeric
  c_real                real,
  c_double              double precision,
  c_money               money,

  -- Boolean
  c_boolean             boolean DEFAULT false NOT NULL,

  -- Character / text
  c_char                char(5),
  c_varchar             varchar(50),
  c_text                text,

  -- Byte string
  c_bytea               bytea,

  -- Temporal
  c_date                date,
  c_time                time without time zone,
  c_timetz              time with time zone,
  c_timestamp           timestamp without time zone DEFAULT now(),
  c_timestamptz         timestamp with time zone DEFAULT now(),
  c_interval            interval,

  -- UUID / XML / JSON
  c_uuid                uuid,
  c_xml                 xml,
  c_json                json,
  c_jsonb               jsonb,
  c_jsonpath            jsonpath,

  -- Bit strings
  c_bit                 bit(3),
  c_varbit              bit varying(7),

  -- Text search
  c_tsvector            tsvector,
  c_tsquery             tsquery,

  -- Network
  c_inet                inet,
  c_cidr                cidr,
  c_macaddr             macaddr,
  c_macaddr8            macaddr8,

  -- Geometric
  c_point               point,
  c_line                line,
  c_lseg                lseg,
  c_box                 box,
  c_path                path,
  c_polygon             polygon,
  c_circle              circle
);

CREATE TABLE demo_a.advanced (
  -- Arrays (et.typcategory = 'A' path in your script)
  a_int                  integer[],
  a_text                 text[],
  a_uuid                 uuid[],
  a_varchar_limited      varchar(20)[],
  a_numeric              numeric(12,4)[],
  a_timestamptz          timestamp with time zone[],

  -- Ranges
  r_int4                 int4range,
  r_int8                 int8range,
  r_num                  numrange,
  r_ts                   tsrange,
  r_tstz                 tstzrange,
  r_date                 daterange,

  -- User-defined types
  t_enum                 public.mood_enum,
  t_domain               public.positive_int_domain,
  t_composite            public.address_type,

  -- System-ish types that are valid as columns
  t_pg_lsn               pg_lsn,
  t_txid_snapshot        txid_snapshot,
  t_oid                  oid,
  t_xid                  xid,
  t_xid8                 xid8,
  t_cid                  cid,
  t_tid                  tid,
  t_name                 name,

  -- reg* OID reference types
  t_regproc              regproc,
  t_regprocedure         regprocedure,
  t_regoper              regoper,
  t_regoperator          regoperator,
  t_regclass             regclass,
  t_regtype              regtype,
  t_regconfig            regconfig,
  t_regdictionary        regdictionary,
  t_regnamespace         regnamespace,
  t_regrole              regrole,
  t_regcollation         regcollation,

  -- Vector-ish builtin types (used internally but valid as column types)
  t_int2vector           int2vector,
  t_oidvector            oidvector
);

COMMENT ON TABLE demo_a.scalars IS 'Covers scalar builtin types (numeric, temporal, network, geometric, json, text, bit, etc.).';
COMMENT ON TABLE demo_a.advanced IS 'Covers arrays, ranges, user-defined (enum/domain/composite), reg* OID reference types, and vector types.';

-- ===== Schema B (mirror tables to ensure multi-schema coverage) =====
CREATE SCHEMA demo_b;

CREATE TABLE demo_b.scalars (
  id_identity           bigserial PRIMARY KEY, -- use serial-like flavor here intentionally
  id_smallserial        smallserial,
  id_serial             serial,
  id_bigserial          bigserial,

  c_smallint            smallint,
  c_integer             integer,
  c_bigint              bigint,
  c_numeric             numeric(30,10),
  c_real                real,
  c_double              double precision,
  c_money               money,

  c_boolean             boolean DEFAULT true,

  c_char                char(2),
  c_varchar             varchar(255),
  c_text                text,

  c_bytea               bytea,

  c_date                date,
  c_time                time without time zone,
  c_timetz              time with time zone,
  c_timestamp           timestamp without time zone DEFAULT now(),
  c_timestamptz         timestamp with time zone DEFAULT now(),
  c_interval            interval(3),

  c_uuid                uuid,
  c_xml                 xml,
  c_json                json,
  c_jsonb               jsonb,
  c_jsonpath            jsonpath,

  c_bit                 bit(1),
  c_varbit              bit varying(16),

  c_tsvector            tsvector,
  c_tsquery             tsquery,

  c_inet                inet,
  c_cidr                cidr,
  c_macaddr             macaddr,
  c_macaddr8            macaddr8,

  c_point               point,
  c_line                line,
  c_lseg                lseg,
  c_box                 box,
  c_path                path,
  c_polygon             polygon,
  c_circle              circle
);

CREATE TABLE demo_b.advanced (
  a_int                  integer[],
  a_text                 text[],
  a_uuid                 uuid[],
  a_varchar_limited      varchar(10)[],
  a_numeric              numeric(8,2)[],
  a_timestamp            timestamp[],

  r_int4                 int4range,
  r_int8                 int8range,
  r_num                  numrange,
  r_ts                   tsrange,
  r_tstz                 tstzrange,
  r_date                 daterange,

  t_enum                 public.mood_enum,
  t_domain               public.positive_int_domain,
  t_composite            public.address_type,

  t_pg_lsn               pg_lsn,
  t_txid_snapshot        txid_snapshot,
  t_oid                  oid,
  t_xid                  xid,
  t_xid8                 xid8,
  t_cid                  cid,
  t_tid                  tid,
  t_name                 name,

  t_regproc              regproc,
  t_regprocedure         regprocedure,
  t_regoper              regoper,
  t_regoperator          regoperator,
  t_regclass             regclass,
  t_regtype              regtype,
  t_regconfig            regconfig,
  t_regdictionary        regdictionary,
  t_regnamespace         regnamespace,
  t_regrole              regrole,
  t_regcollation         regcollation,

  t_int2vector           int2vector,
  t_oidvector            oidvector
);

COMMENT ON TABLE demo_b.scalars IS 'Mirror of demo_a.scalars with slightly different lengths/precisions/defaults.';
COMMENT ON TABLE demo_b.advanced IS 'Mirror of demo_a.advanced for cross-schema coverage.';

-- Optional: a couple of column comments to test obj_description joins if present
COMMENT ON COLUMN demo_a.scalars.c_varchar IS 'varchar(50) for length parsing';
COMMENT ON COLUMN demo_a.advanced.a_varchar_limited IS 'varchar[] with fixed element length';
