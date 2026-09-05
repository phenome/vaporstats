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
