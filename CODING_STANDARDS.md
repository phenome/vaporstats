# Coding standards

Judgement rules applied when reviewing a change. Mechanical rules live in [AGENTS.md](AGENTS.md); these cover decisions a checker cannot make.

## Wrap a dependency; do not copy its internals

Build on a dependency's public API and change what runs around it. Copying or reimplementing its internals forks behavior that upstream fixes no longer reach. Replacing a dependency's behavior requires an ADR that records why its public API is insufficient.

Example: migrations keep Drizzle's `migrate()` and change what runs around it (turning foreign keys off before it starts, requiring an empty `foreign_key_check` after it finishes) rather than copying its apply loop or ledger ([ADR 0016](docs/adr/0016-foreign-key-safe-sqlite-migrations.md)).

## Classify each external-response class in one place

Every class of external response (an outlet denial, a provider stop, a rate limit) is decided by one classifier, and every caller acts on its result. Parallel status-code checks spread across callers drift apart: one path treats a 429 as an outlet's rate limit while another treats it as the search provider's. A new response class or status code extends the classifier, not a caller.

## Narrowing a requirement is a defect

A change that narrows an acceptance criterion or a rule from a parent specification is a defect, not a design choice. Examples: covering only some of the listed failure cases, applying a rule to one pass or stage when the specification says every pass, or counting fewer attempt kinds than required. When a criterion cannot be met as written, the specification is amended first, with its rationale, before the narrower behavior lands.

## Retiring a feature keeps its boundary

Retiring a feature removes its entry forms and keeps the boundary they ran through. Deleting a file, route, workflow or module is in scope only when the ticket names it, and never while an open ticket builds on it.

Example: retiring the manual media trigger removed the `media initial` and `media later` forms, and the dispatch workflow, the restricted remote command and the server's loopback endpoint stayed, each rejecting the retired forms on its own, because later slices add the status, watchlist and correction forms to that boundary ([ADR 0019](docs/adr/0019-automatic-daily-media-run.md)).
