# Repository guidance

## Public project communication

Repository artifacts are written for external collaborators and readers.

- State project decisions, constraints, and tradeoffs directly and neutrally.
- Prefer language such as “VaporStats prioritizes,” “the selected direction,” or “the project requires.”
- Do not refer to private conversations, requester preferences, or user/assistant framing.
- Preserve relevant rationale by expressing it as project context rather than conversational history.

## TanStack route modules

- Keep route-bound components private to `src/routes/*.tsx`. When a component needs to be imported elsewhere, move it to `src/components/`; exporting it from a route module prevents TanStack Router from code-splitting that route boundary.

## Shadcn UI primitives

- Install components with `bunx shadcn add -f <component>`.
- Treat `src/components/ui/*` as CLI-managed generated code. Update it only through the Shadcn CLI; never edit these files directly.
- Put project-specific behavior and styling in wrapper components outside `src/components/ui/`.

## Database migrations

- For schema changes, update the Drizzle schema, run `bun run db:generate`, and review every generated SQL statement. Add any required data-preserving migration statements before running `bun run db:migrate` locally.
- Migrations change schema and transform existing data; they never seed catalog or observation data. Keep ingestion separate.
- Commit the reviewed SQL with its Drizzle journal and snapshots. Treat applied migrations as immutable; corrections require a new migration.
- Verify migration behavior on both an empty database and an existing database with representative retained rows.
- Deployments apply committed migrations after stopping the single writer and taking a database snapshot; they never generate migrations or use schema push. Read [ADR 0004](docs/adr/0004-reviewed-sqlite-migrations.md) before changing migration or deployment behavior.

