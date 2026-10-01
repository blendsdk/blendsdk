export interface ColumnIntrospection {
  database_name: string;
  schema_name: string;
  relation_name: string;
  relation_kind:
    | 'table'
    | 'view'
    | 'materialized view'
    | 'partitioned table'
    | 'foreign table'
    | 'enum type'
    | 'composite type';
  table_comment: string | null;
  column_name: string;
  column_comment: string | null;
  is_nullable: boolean;
  has_default: boolean;
  column_default: string | null;
  pg_type: string;
  formatted_type: string;
  is_array: boolean;
  array_element_pg_type: string | null;
  array_element_formatted_type: string | null;
  length: number | null;
  precision: number | null;
  scale: number | null;
  is_primary_key: boolean;
  is_unique: boolean;
  is_foreign_key: boolean;
  fk_info: ForeignKeyInfo[] | null;
  is_check_constrained: boolean;
  check_constraints: CheckConstraintInfo[] | null;
  is_enum: boolean;
  enum_type_name: string | null;
  enum_labels: string[] | string | null;
  type_oid: number;
}

export interface ForeignKeyInfo {
  constraint_name: string;
  ref_schema: string;
  ref_table: string;
  ref_columns: string[];
  column_positions: number[];
  update_action: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
  delete_action: 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT';
  match_type: 'SIMPLE' | 'FULL' | 'PARTIAL';
}

export interface CheckConstraintInfo {
  constraint_name: string;
  definition: string;
}
