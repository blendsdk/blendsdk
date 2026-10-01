export const INTROSPECTION_SQL = `
-- ===========================================================
-- Enhanced introspect.sql
-- Includes user-defined types (UDTs) and
-- FILTERS composite types to ONLY those created by hand
-- (standalone composites: pg_class.relkind = 'c').
-- ===========================================================

WITH base AS (
SELECT
  current_database()                                   AS database_name,
  n.nspname                                            AS schema_name,
  c.relname                                            AS relation_name,
  CASE c.relkind
    WHEN 'r' THEN 'table'
    WHEN 'p' THEN 'partitioned table'
    WHEN 'v' THEN 'view'
    WHEN 'm' THEN 'materialized view'
    WHEN 'f' THEN 'foreign table'
    ELSE c.relkind::text
  END                                                  AS relation_kind,

  obj_description(c.oid, 'pg_class')                   AS table_comment,

  a.attname                                            AS column_name,
  col_description(a.attrelid, a.attnum)                AS column_comment,

  (NOT a.attnotnull)                                   AS is_nullable,

  (ad.adbin IS NOT NULL)                               AS has_default,
  CASE
    WHEN ad.adbin IS NOT NULL THEN pg_get_expr(ad.adbin, ad.adrelid)
    ELSE NULL
  END                                                  AS column_default,

  COALESCE(bt.typname, t.typname)                      AS pg_type,

  format_type(a.atttypid, a.atttypmod)                 AS formatted_type,

  (et.typcategory = 'A')                               AS is_array,

  CASE WHEN et.typcategory = 'A'
       THEN COALESCE(elem_bt.typname, elem.typname)
  END                                                  AS array_element_pg_type,
  CASE WHEN et.typcategory = 'A'
       THEN format_type(COALESCE(elem_bt.oid, elem.oid), a.atttypmod)
  END                                                  AS array_element_formatted_type,

  CASE
    WHEN (
      (et.typcategory = 'A' AND COALESCE(elem_bt.typname, elem.typname) IN ('varchar','bpchar'))
      OR (et.typcategory <> 'A' AND COALESCE(bt.typname, t.typname) IN ('varchar','bpchar'))
    ) THEN NULLIF(a.atttypmod - 4, -1)
    ELSE NULL
  END                                                  AS length,

  CASE
    WHEN (
      (et.typcategory = 'A' AND COALESCE(elem_bt.typname, elem.typname) = 'numeric')
      OR (et.typcategory <> 'A' AND COALESCE(bt.typname, t.typname) = 'numeric')
    ) THEN information_schema._pg_numeric_precision(COALESCE(elem_bt.oid, elem.oid, a.atttypid), a.atttypmod)
    ELSE NULL
  END                                                  AS precision,

  CASE
    WHEN (
      (et.typcategory = 'A' AND COALESCE(elem_bt.typname, elem.typname) = 'numeric')
      OR (et.typcategory <> 'A' AND COALESCE(bt.typname, t.typname) = 'numeric')
    ) THEN information_schema._pg_numeric_scale(COALESCE(elem_bt.oid, elem.oid, a.atttypid), a.atttypmod)
    ELSE NULL
  END                                                  AS scale,

  EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = c.oid
      AND i.indisprimary
      AND a.attnum = ANY(i.indkey)
  )                                                    AS is_primary_key,

  EXISTS (
    SELECT 1
    FROM pg_index i
    WHERE i.indrelid = c.oid
      AND i.indisunique
      AND a.attnum = ANY(i.indkey)
  )                                                    AS is_unique,

  EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = c.oid
      AND con.contype = 'f'
      AND a.attnum = ANY(con.conkey)
  )                                                    AS is_foreign_key,

  (
    SELECT jsonb_agg(jsonb_build_object(
      'constraint_name', con.conname,
      'schema', n2.nspname,
      'table', c2.relname,
      'columns',
        (
          SELECT jsonb_agg(a2.attname ORDER BY k2.ord)
          FROM unnest(con.confkey) WITH ORDINALITY AS k2(attnum, ord)
          JOIN pg_attribute a2 ON a2.attrelid = con.confrelid AND a2.attnum = k2.attnum
        ),
      'referenced_columns',
        (
          SELECT jsonb_agg(a1.attname ORDER BY k1.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS k1(attnum, ord)
          JOIN pg_attribute a1 ON a1.attrelid = con.conrelid AND a1.attnum = k1.attnum
        )
    ) ORDER BY con.conname)
    FROM pg_constraint con
    JOIN pg_class      c2 ON c2.oid = con.confrelid
    JOIN pg_namespace  n2 ON n2.oid = c2.relnamespace
    WHERE con.conrelid = c.oid
      AND con.contype = 'f'
      AND a.attnum = ANY(con.conkey)
  )                                                    AS fk_info,

  EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = c.oid
      AND con.contype = 'c'
      AND a.attnum = ANY(con.conkey)
  )                                                    AS is_check_constrained,

  (
    SELECT string_agg(pg_get_constraintdef(con.oid), ' AND ')
    FROM pg_constraint con
    WHERE con.conrelid = c.oid
      AND con.contype = 'c'
      AND a.attnum = ANY(con.conkey)
  )                                                    AS check_constraints,

  CASE
    WHEN et.typcategory = 'A' THEN EXISTS (
      SELECT 1 FROM pg_type tt
      WHERE tt.oid = COALESCE(elem_bt.oid, elem.oid)
        AND tt.typtype = 'e'
    )
    ELSE EXISTS (
      SELECT 1 FROM pg_type tt
      WHERE tt.oid = COALESCE(bt.oid, t.oid)
        AND tt.typtype = 'e'
    )
  END                                                  AS is_enum,

  CASE
    WHEN et.typcategory = 'A' THEN (
      SELECT ns.nspname || '.' || tt.typname
      FROM pg_type tt
      JOIN pg_namespace ns ON ns.oid = tt.typnamespace
      WHERE tt.oid = COALESCE(elem_bt.oid, elem.oid)
        AND tt.typtype = 'e'
    )
    ELSE (
      SELECT ns.nspname || '.' || tt.typname
      FROM pg_type tt
      JOIN pg_namespace ns ON ns.oid = tt.typnamespace
      WHERE tt.oid = COALESCE(bt.oid, t.oid)
        AND tt.typtype = 'e'
    )
  END                                                  AS enum_type_name,

  CASE
    WHEN et.typcategory = 'A' THEN (
      SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_enum e
      WHERE e.enumtypid = COALESCE(elem_bt.oid, elem.oid)
    )
    ELSE (
      SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_enum e
      WHERE e.enumtypid = COALESCE(bt.oid, t.oid)
    )
  END                                                  AS enum_labels,

  t.oid                                                AS type_oid

FROM pg_attribute      a
JOIN pg_class          c        ON c.oid = a.attrelid
JOIN pg_namespace      n        ON n.oid = c.relnamespace
JOIN pg_type           t        ON t.oid = a.atttypid
LEFT  JOIN pg_type     bt       ON t.typtype = 'd' AND bt.oid = t.typbasetype
LEFT  JOIN pg_type     et       ON et.oid = COALESCE(bt.oid, t.oid)
LEFT  JOIN pg_type     elem     ON elem.oid = CASE WHEN et.typcategory = 'A' THEN et.typelem END
LEFT  JOIN pg_type     elem_bt  ON elem.typtype = 'd' AND elem_bt.oid = elem.typbasetype
LEFT  JOIN pg_attrdef  ad       ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE
  a.attnum > 0
  AND NOT a.attisdropped
  AND c.relkind IN ('r','p','v','m','f')
  AND n.nspname NOT IN ('pg_catalog','information_schema')
)

-- 1) Standalone composite types only (created by hand)
, composite AS (
  SELECT
    current_database()                                   AS database_name,
    n.nspname                                            AS schema_name,
    t.typname                                            AS relation_name,
    'composite type'                                     AS relation_kind,
    obj_description(t.oid, 'pg_type')                    AS table_comment,

    a.attname                                            AS column_name,
    col_description(c.oid, a.attnum)                     AS column_comment,

    NOT a.attnotnull                                     AS is_nullable,
    FALSE                                                AS has_default,
    NULL::text                                           AS column_default,

    COALESCE(bt.typname, ty.typname)                     AS pg_type,
    format_type(a.atttypid, a.atttypmod)                 AS formatted_type,

    (et.typcategory = 'A')                               AS is_array,
    CASE WHEN et.typcategory = 'A' THEN COALESCE(elem_bt.typname, elem.typname) END AS array_element_pg_type,
    CASE WHEN et.typcategory = 'A' THEN format_type(COALESCE(elem_bt.oid, elem.oid), a.atttypmod) END AS array_element_formatted_type,

    CASE
      WHEN et.typcategory IN ('S','E','P','R') THEN NULL
      WHEN et.typcategory = 'A' THEN NULL
      ELSE information_schema._pg_char_max_length(a.atttypid, a.atttypmod)
    END                                                 AS length,

    information_schema._pg_numeric_precision(COALESCE(elem_bt.oid, elem.oid, a.atttypid), a.atttypmod) AS precision,
    information_schema._pg_numeric_scale(COALESCE(elem_bt.oid, elem.oid, a.atttypid), a.atttypmod)     AS scale,

    FALSE                                               AS is_primary_key,
    FALSE                                               AS is_unique,
    FALSE                                               AS is_foreign_key,
    NULL::jsonb                                         AS fk_info,

    FALSE                                               AS is_check_constrained,
    NULL::text                                          AS check_constraints,

    EXISTS (
      SELECT 1 FROM pg_type tt
      WHERE tt.oid = COALESCE(elem_bt.oid, elem.oid, bt.oid, ty.oid) AND tt.typtype = 'e'
    )                                                   AS is_enum,

    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_type tt
        WHERE tt.oid = COALESCE(elem_bt.oid, elem.oid) AND tt.typtype = 'e'
      ) THEN (
        SELECT ns.nspname || '.' || tt.typname
        FROM pg_type tt JOIN pg_namespace ns ON ns.oid = tt.typnamespace
        WHERE tt.oid = COALESCE(elem_bt.oid, elem.oid)
      )
      WHEN EXISTS (
        SELECT 1 FROM pg_type tt
        WHERE tt.oid = COALESCE(bt.oid, ty.oid) AND tt.typtype = 'e'
      ) THEN (
        SELECT ns.nspname || '.' || tt.typname
        FROM pg_type tt JOIN pg_namespace ns ON ns.oid = tt.typnamespace
        WHERE tt.oid = COALESCE(bt.oid, ty.oid)
      )
      ELSE NULL
    END                                                 AS enum_type_name,

    CASE
      WHEN EXISTS (
        SELECT 1 FROM pg_type tt
        WHERE tt.oid = COALESCE(elem_bt.oid, elem.oid) AND tt.typtype = 'e'
      ) THEN (
        SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
        FROM pg_enum e WHERE e.enumtypid = COALESCE(elem_bt.oid, elem.oid)
      )
      WHEN EXISTS (
        SELECT 1 FROM pg_type tt
        WHERE tt.oid = COALESCE(bt.oid, ty.oid) AND tt.typtype = 'e'
      ) THEN (
        SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
        FROM pg_enum e WHERE e.enumtypid = COALESCE(bt.oid, ty.oid)
      )
      ELSE NULL
    END                                                 AS enum_labels,

    a.atttypid                                          AS type_oid

  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_class c ON c.oid = t.typrelid
  JOIN pg_attribute a ON a.attrelid = c.oid
  JOIN pg_type ty ON ty.oid = a.atttypid
  LEFT JOIN pg_type bt      ON ty.typtype = 'd' AND bt.oid = ty.typbasetype
  LEFT JOIN pg_type et      ON et.oid = COALESCE(bt.oid, ty.oid)
  LEFT JOIN pg_type elem    ON elem.oid = CASE WHEN et.typcategory = 'A' THEN et.typelem END
  LEFT JOIN pg_type elem_bt ON elem.typtype = 'd' AND elem_bt.oid = elem.typbasetype
  WHERE t.typtype = 'c'
    AND c.relkind = 'c'                     -- <<< filter to standalone composites created by hand
    AND a.attnum > 0 AND NOT a.attisdropped
    AND n.nspname NOT IN ('pg_catalog','information_schema')
)

-- 2) Enum types: one row per label
, enum_rows AS (
  SELECT
    current_database()                       AS database_name,
    n.nspname                                 AS schema_name,
    t.typname                                 AS relation_name,
    'enum type'                               AS relation_kind,
    obj_description(t.oid, 'pg_type')         AS table_comment,

    e.enumlabel                               AS column_name,
    NULL::text                                AS column_comment,

    NULL::boolean                             AS is_nullable,
    FALSE                                     AS has_default,
    NULL::text                                AS column_default,

    'text'                                    AS pg_type,
    'text'                                    AS formatted_type,

    FALSE                                     AS is_array,
    NULL::text                                AS array_element_pg_type,
    NULL::text                                AS array_element_formatted_type,

    NULL::integer                             AS length,
    NULL::integer                             AS precision,
    NULL::integer                             AS scale,

    FALSE                                     AS is_primary_key,
    FALSE                                     AS is_unique,
    FALSE                                     AS is_foreign_key,
    NULL::jsonb                               AS fk_info,

    TRUE                                      AS is_check_constrained,
    NULL::text                                AS check_constraints,

    TRUE                                      AS is_enum,
    n.nspname || '.' || t.typname             AS enum_type_name,
    NULL::text[]                              AS enum_labels,

    t.oid                                     AS type_oid
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  JOIN pg_enum e ON e.enumtypid = t.oid
  WHERE t.typtype = 'e'
    AND n.nspname NOT IN ('pg_catalog','information_schema')
)

-- 3) Domain types: one synthetic "(base)" row with CHECKs
, domain_rows AS (
  SELECT
    current_database()                                   AS database_name,
    n.nspname                                            AS schema_name,
    t.typname                                            AS relation_name,
    'domain type'                                        AS relation_kind,
    obj_description(t.oid, 'pg_type')                    AS table_comment,

    '(base)'                                             AS column_name,
    NULL::text                                           AS column_comment,

    NULL::boolean                                        AS is_nullable,
    FALSE                                                AS has_default,
    NULL::text                                           AS column_default,

    COALESCE(bt.typname, baset.typname)                  AS pg_type,
    format_type(t.typbasetype, t.typtypmod)              AS formatted_type,

    FALSE                                                AS is_array,
    NULL::text                                           AS array_element_pg_type,
    NULL::text                                           AS array_element_formatted_type,

    information_schema._pg_char_max_length(t.typbasetype, t.typtypmod) AS length,
    information_schema._pg_numeric_precision(t.typbasetype, t.typtypmod) AS precision,
    information_schema._pg_numeric_scale(t.typbasetype, t.typtypmod)     AS scale,

    FALSE                                                AS is_primary_key,
    FALSE                                                AS is_unique,
    FALSE                                                AS is_foreign_key,
    NULL::jsonb                                          AS fk_info,

    (EXISTS (SELECT 1 FROM pg_constraint con WHERE con.contypid = t.oid AND con.contype = 'c')) AS is_check_constrained,
    (
      SELECT string_agg(pg_get_constraintdef(con.oid), ' AND ')
      FROM pg_constraint con
      WHERE con.contypid = t.oid AND con.contype = 'c'
    )                                                    AS check_constraints,

    EXISTS (SELECT 1 FROM pg_type tt WHERE tt.oid = t.typbasetype AND tt.typtype = 'e') AS is_enum,
    CASE
      WHEN EXISTS (SELECT 1 FROM pg_type tt WHERE tt.oid = t.typbasetype AND tt.typtype = 'e')
      THEN (
        SELECT ns.nspname || '.' || tt.typname
        FROM pg_type tt JOIN pg_namespace ns ON ns.oid = tt.typnamespace
        WHERE tt.oid = t.typbasetype
      )
      ELSE NULL
    END                                                  AS enum_type_name,
    NULL::text[]                                         AS enum_labels,

    t.oid                                                AS type_oid
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  LEFT JOIN pg_type baset ON baset.oid = t.typbasetype
  LEFT JOIN pg_type bt ON baset.typtype = 'd' AND bt.oid = baset.typbasetype
  WHERE t.typtype = 'd'
    AND n.nspname NOT IN ('pg_catalog','information_schema')
)

SELECT * FROM base
UNION ALL
SELECT * FROM composite
UNION ALL
SELECT * FROM enum_rows
UNION ALL
SELECT * FROM domain_rows
ORDER BY schema_name, relation_name, column_name;
`;
