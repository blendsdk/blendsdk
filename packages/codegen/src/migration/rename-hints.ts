import { MigrationError } from './errors.js';
import type { SchemaSnapshotV1 } from './snapshot-types.js';

/** Explicit table or column rename supplied for one generation command. */
export interface RenameHint {
  /** Modeled object kind being renamed. */
  readonly kind: 'table' | 'column';
  /** Fully qualified prior identity. */
  readonly from: string;
  /** Fully qualified desired identity. */
  readonly to: string;
}

/**
 * Validates rename syntax, existence, cardinality, and cycles before diffing.
 *
 * Column identities may cross table names only when the same hint set explicitly
 * renames that source table to that target table.
 */
export function validateRenameHints(
  previous: SchemaSnapshotV1,
  desired: SchemaSnapshotV1,
  hints: readonly RenameHint[]
): void {
  const sources = new Set<string>();
  const targets = new Set<string>();
  const tableMappings = new Set(
    hints.filter(hint => hint.kind === 'table').map(hint => `${hint.from}->${hint.to}`)
  );
  for (const hint of hints) {
    const parts = hint.kind === 'table' ? 2 : 3;
    if (
      hint.from.split('.').length !== parts ||
      hint.to.split('.').length !== parts ||
      hint.from === hint.to
    ) {
      throw invalidHint('Rename hint identity does not match its kind.');
    }
    if (hint.from.split('.')[0] !== hint.to.split('.')[0]) {
      throw invalidHint('Cross-schema renames require reviewed manual SQL.');
    }
    if (hint.kind === 'column') {
      const fromTable = hint.from.split('.').slice(0, 2).join('.');
      const toTable = hint.to.split('.').slice(0, 2).join('.');
      if (fromTable !== toTable && !tableMappings.has(`${fromTable}->${toTable}`)) {
        throw invalidHint('Cross-table column renames require a matching table rename hint.');
      }
    }
    if (sources.has(hint.from) || targets.has(hint.to) || targets.has(hint.from)) {
      throw invalidHint('Rename hints must be one-to-one and acyclic.');
    }
    sources.add(hint.from);
    targets.add(hint.to);
    const priorExists = identityExists(previous, hint.kind, hint.from);
    const desiredExists = identityExists(desired, hint.kind, hint.to);
    if (!priorExists || !desiredExists) {
      throw invalidHint('Rename hint must reference one prior and one desired identity.');
    }
    if (
      identityExists(desired, hint.kind, hint.from) ||
      identityExists(previous, hint.kind, hint.to)
    ) {
      throw invalidHint('Rename hint must map one removed identity to one added identity.');
    }
  }
}

/** Checks whether one fully qualified table or column identity exists. */
function identityExists(
  snapshot: SchemaSnapshotV1,
  kind: RenameHint['kind'],
  identity: string
): boolean {
  const [schema, table, column] = identity.split('.');
  return snapshot.tables.some(
    candidate =>
      candidate.schema === schema &&
      candidate.name === table &&
      (kind === 'table' || candidate.columns.some(item => item.name === column))
  );
}

/** Creates a stable invalid rename-hint error. */
function invalidHint(message: string): MigrationError {
  return new MigrationError({ kind: 'CONFIGURATION', exitCode: 2, message });
}
