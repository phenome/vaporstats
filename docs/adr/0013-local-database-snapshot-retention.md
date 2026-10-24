# Local database snapshot retention

**Status:** Accepted

## Decision

Keep complete SQLite snapshots on local storage and bound their growth through the existing daily producer. No additional backup backend, service, or scheduler is introduced. Local copies provide recovery points but do not protect against loss of the host or its storage.

For valid, non-future `vaporstats-YYYY-MM-DD.sqlite` files, select the newest snapshot in each of the 7 most recent distinct UTC days, 4 most recent distinct ISO weeks (Monday start), 12 most recent distinct UTC calendar months, and every represented UTC calendar year. Yearly recovery points do not expire. Always retain the latest eligible snapshot, including today's snapshot.

The retained set is the union of these selections: one file may satisfy several levels without extra copies. Counts describe available recovery periods, not a fixed file total or moving age bands. Missing days, weeks, or months are not fabricated; older successful periods can fill the counts. A file does not need to survive an age threshold before it can represent a week, month, or year.

The daily job still rolls up the prior UTC day and applies raw-observation retention before creating its database snapshot. The producer serializes to a unique sibling temporary file, publishes it by atomic rename, then applies snapshot retention through the same filesystem helper as the maintenance command. Failed publication never triggers cleanup. The newly published file is protected during that cleanup. Explicit custom destination files remain operational snapshots and do not trigger directory cleanup.

## Managed files and safeguards

Only direct regular files with the exact managed basename and a real calendar date are eligible. Subdirectories, symlinks, invalid or future-dated names, temporary files, WAL/SHM sidecars, and operational `pre-*` or `deploy-*` snapshots are ignored and preserved. The active database is protected by resolved path and file identity, even if its name matches the managed namespace. A dated database with a nonempty WAL is also protected; cleanup never changes sidecars. Retained files and deletion candidates are revalidated before deletion; unexpected concurrent changes abort cleanup rather than relaxing protection. Run manual cleanup without concurrent snapshot publication or directory changes.

## Initial cleanup and operation

Run from the repository root with the deployment's existing environment:

```sh
bun run snapshots:retention
# Only after reviewing the current plan and authorizing its exact removal set:
bun run snapshots:retention --apply
```

`DATABASE_SNAPSHOT_DIR` defaults to `data/snapshots`; `DATABASE_PATH` defaults to `data/vaporstats.sqlite`. Relative paths resolve from the current working directory. The maintenance command does not open the active database or run migrations. With no flag it only inventories files and emits JSON; only `--apply` permits deletion. Unknown arguments and conflicting or repeated modes are rejected. `--help` prints usage.

The JSON report contains the mode, resolved paths, UTC reference date, file inventory (`candidates`, including logical and allocated byte sizes), retained (`keep`), proposed removal (`remove`), unmanaged (`ignored`) names, retention reasons, `estimatedRemoval`, and actual `deleted` filenames. Protected managed files are included in `keep`. Filename arrays are sorted and unique. In plan mode `deleted` is empty. Byte estimates sum only proposed removal files: allocated bytes are not a promise of physical space recovered by `df`, which can differ because of filesystem sharing, open handles, and allocation behavior.

Before initial cleanup, save and review the plan, confirm the active database and snapshot directory, and obtain explicit approval for the exact removal set. Check representative retained recovery points, including the newest and historical points, using isolated local copies: open them read-only, run SQLite integrity checks, and verify required application data can be read. Do not restore over or mutate the live database to perform this check. Keep operational pre-deployment recovery copies until their separate purpose is complete. Re-plan if files change before apply; apply inventories the directory again rather than consuming a previously saved plan.

Deletion has no undo operation. Reverting application code does not recover removed files; recovery requires another surviving copy. A failed apply may have already removed some candidates, so inspect the remaining inventory before retrying. Restore application and matching database snapshots together as described in [ADR 0004](0004-reviewed-sqlite-migrations.md).
