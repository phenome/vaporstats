# Reviewed Drizzle migrations for SQLite

**Status:** Accepted

VaporStats uses Drizzle ORM with its native `bun:sqlite` (BunSQLite) adapter as the schema interface. Schema changes follow a reviewed, artifact-first workflow: edit the schema, run `bun run db:generate`, inspect the generated SQL, journal, and snapshots, then edit the SQL when a data-preserving transformation is required. Generated migrations must never seed catalog data. Run `bun run db:migrate` locally against the target schema before committing the SQL, journal, and snapshots.

Deployment applies only the committed migration artifacts with `bun run db:migrate`; it does not run `db:generate` or `drizzle-kit push`. The existing `schema_migrations` ledger is adopted once as the baseline for the already-applied schema: existing migrations are recorded as applied without replay, and existing rows are preserved. Subsequent migrations extend that history normally.

The database has one writable process. Migrations are atomic: a failed migration leaves its schema, data, and migration history unchanged. A verified SQLite snapshot is taken before deployment. Rollback restores the application image and its matching database snapshot together; down-migrations are not promised.

CI verifies changes before a merge to `main`; a successful merge triggers deployment. Deployment authentication uses a dedicated, restricted SSH key stored in GitHub secrets, never a personal key.