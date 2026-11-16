# Foreign-key-safe SQLite migrations

**Status:** Accepted

Extends [ADR 0004](0004-reviewed-sqlite-migrations.md).

## Context

SQLite changes a constraint by rebuilding the table: create a replacement, copy rows, drop the original and rename. drizzle-kit wraps these rebuilds in `PRAGMA foreign_keys=OFF` and `PRAGMA foreign_keys=ON`. SQLite ignores that pragma inside a transaction, and the drizzle migrator applies every pending migration in one transaction. The foreign-key mode in effect was therefore the caller's mode. The application enables foreign keys before migrating, while `bun run db:migrate` left them off. With foreign keys on, dropping a rebuilt parent table cascade-deletes `ON DELETE CASCADE` children and fails on referencing children without an action. Media tables reference `media_sources` both ways, so a rebuild of a media table could lose or block retained data.

## Decision

`applyMigrations` is the only migration procedure. App startup, `bun run db:migrate`, `bun run check:migrations` and test fixtures all use it:

1. Refuse to run inside an open transaction, where the foreign-key pragma cannot change.
2. Record the connection's foreign-key setting and turn foreign keys off, outside the migration transaction.
3. Adopt the legacy `schema_migrations` ledger as described in ADR 0004.
4. Apply pending migrations with drizzle's migrator, unchanged. It runs them in one transaction, which now executes with foreign keys off.
5. When any migration was applied, `PRAGMA foreign_key_check` must return no rows. A violation fails the migration step. The migrator has already committed at that point, so recovery is the pre-migration snapshot that deployment takes and restores on failure (ADR 0004).
6. Restore the recorded foreign-key setting, including after a failure.

The project keeps drizzle's migrator rather than reimplementing its ledger. Disabling foreign keys before the migrator starts is enough to make rebuilds safe. A check before commit would need a copy of drizzle's apply loop, and the deployment snapshot already provides rollback. Generated SQL, journals and snapshots still come from `bun run db:generate` and follow ADR 0004's review rules.

Rebuild migrations can rely on foreign keys being off. They must leave every reference valid. A migration that deletes or remaps parent rows also handles their children explicitly.

## Verification

`bun run check:migrations` is part of `bun run verify`. It seeds representative retained rows in every media table on the first schema that holds them all. It then applies every later migration with foreign keys on, as the application does, and requires each row to keep its baseline column values. Tests that call `applyMigrations` use the same procedure. Media tests also open databases through the application's adapter and pragmas, so their foreign-key behavior matches production. Other tests may still migrate a bare in-memory database with foreign keys off, and a few build their schema by hand; moving them onto the shared fixtures in `tests/support/` is follow-up work.
