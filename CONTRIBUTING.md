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

## Browser site search

VaporStats advertises `/opensearch.xml` in its shared HTML head. The OpenSearch descriptor sends searches to `https://vaporstats.com/search?q={searchTerms}`, reusing the same catalog results as the site's search forms. The production server permits this specific XML file and serves it as `application/opensearchdescription+xml` with the existing public-file cache policy; other XML files are not made public by this integration.

Desktop Chrome controls discovery and activation. Visiting the homepage and searching the site may add VaporStats under **Settings → Search engine → Manage search engines and site search → Inactive shortcuts**; choose **Activate** if present. Once active, enter the configured shortcut in the address bar and press Tab to search. Discovery does not guarantee immediate activation in every profile. If automatic discovery is unavailable, Chrome's manual **Add** action accepts `https://vaporstats.com/search?q=%s` as the search URL. See [Chrome's site-search help](https://support.google.com/chrome/answer/95426?hl=en&co=GENIE.Platform%3DDesktop) and [Chromium's OpenSearch integration](https://www.chromium.org/tab-to-search/).

To verify changes, build and exercise the production request handler, not only Vite's public-file serving: check the descriptor's XML/MIME type, the discovery link in initial homepage and direct search-page HTML, and direct-load, reload, native GET-form, and client-side searches. Browser page inspection proves the search destination works, but does not prove native address-bar activation.

## License

VaporStats is open source under the [GNU Affero General Public License v3.0](LICENSE). Modified versions used to provide a network service must offer their corresponding source as required by the license.

Unless explicitly agreed otherwise, accepted contributions are distributed under the same license.
