Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity. Keep components modular and concerns clearly separated. Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
Lean on the dependencies already in the project before writing your implementation or adding packages. Do not assume a library lacks capability without checking its documentation and types.
Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Web research routing

For web research, use the provider's native web-search capability first. Do not substitute another search or browsing integration when native web search is available.

If native web search is unavailable, use the installed `ketch` CLI for public-web research:

- `ketch search` for current web pages, opinions, news, and comparisons
- `ketch docs` for version-aware library documentation
- `ketch code` for public OSS usage examples
- `ketch scrape` when the URL is already known
- `ketch crawl` for multiple pages on one site

Use `agent_browser` instead only when the task requires interactive browser behavior, such as login/authenticated content, clicking or filling forms, screenshots, uploads/downloads, or JavaScript interaction that ketch cannot handle. Do not use ketch for local/private codebase search or authenticated pages. Bound ketch fetches and cite sources when doing research.
