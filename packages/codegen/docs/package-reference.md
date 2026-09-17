## PostgreSQL migrations

`blendsdk/codegen` includes PostgreSQL-only schema-first migration generation and a checksummed SQL
runner. Define the desired `DatabaseSchema` once, generate a migration from the committed canonical
snapshot, review the SQL, and commit both artifacts.

```ts
import { defineMigrationConfig } from 'blendsdk/codegen';

export default defineMigrationConfig({
  schema: './src/database/schema.ts',
});
```

The assembled package exposes the fixed `blendsdk migrate` commands: `baseline`, `generate`,
`create`, `validate`, `status`, `up`, `down`, and `adopt-baseline`. Production jobs run only
committed SQL with `validate`, `up --dry-run`, and `up`; they never generate from a live database.
Installing `blendsdk` creates a project-local executable; invoke it with `yarn blendsdk migrate`
or `npx blendsdk migrate`, or place `blendsdk migrate` in a package script.

### Public migration API

| Export                  | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `defineMigrationConfig` | Type and validate the small migration configuration object.                     |
| `generateMigration`     | Compare the desired schema with the committed snapshot and emit reviewable SQL. |
| `generateBaseline`      | Create the initial migration and canonical snapshot for a new project.          |
| `runMigrations`         | Validate, preview, apply, or revert reviewed SQL migrations.                    |
| `getMigrationStatus`    | Read the applied and pending migration state without mutation.                  |
| `validateMigrations`    | Validate local lineage and, when connected, the PostgreSQL ledger prefix.       |
| `adoptBaseline`         | Record an exact baseline for a structurally matching existing database.         |

The APIs return `MigrationCommandResult` with a `MigrationStatus` of `UP_TO_DATE`, `PENDING`,
`INVALID_HISTORY`, `LOCKED`, or `UNKNOWN_OUTCOME`. Operational exceptions are `MigrationError`
instances with a stable `MigrationErrorKind` and `MigrationExitCode`.

See the [developer migration guide](../guides/database-migrations.md) and
[production runbook](../guides/database-migrations-production.md) for the complete workflow and
recovery rules.
