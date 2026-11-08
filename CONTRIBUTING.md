# Contributing to VaporStats

VaporStats is developed in public and welcomes focused issues, research, design feedback, and code contributions.

## Before contributing

- Search existing issues before opening a new one.
- Open an issue before starting a substantial change so the direction can be agreed first.
- Keep pull requests focused on one decision or behavior.
- Explain the problem, the selected approach, and how the change was verified.
- Follow the repository guidance in [`AGENTS.md`](AGENTS.md).

## Project direction

VaporStats is currently maintainer-led. Public discussion and contributions inform decisions, while maintainers retain responsibility for scope, releases, infrastructure, and project direction.

## Responsive tables

Keep compact table metadata atomic: role and lifecycle badges, release dates, actions, and short column headings should stay on one line. Reserve intrinsic width for compact columns while allowing game and publisher names to use the remaining space and wrap naturally. Apply these rules at application table call sites, not to generated UI primitives or all table text.

Check real long-title rows at desktop, tablet, and narrow mobile widths. When the columns cannot fit, keep horizontal scrolling inside the table container rather than widening the page. Include expanded release history when checking lifecycle badges.

## License

VaporStats is open source under the [GNU Affero General Public License v3.0](LICENSE). Modified versions used to provide a network service must offer their corresponding source as required by the license.

Unless explicitly agreed otherwise, accepted contributions are distributed under the same license.
