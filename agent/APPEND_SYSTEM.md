## Web research routing

For web research, use the provider's native web-search capability first. Do not substitute another search or browsing integration when native web search is available.

If native web search is unavailable, use the installed `ketch` CLI for public-web research:
- `ketch search` for current web pages, opinions, news, and comparisons
- `ketch docs` for version-aware library documentation
- `ketch code` for public OSS usage examples
- `ketch scrape` when the URL is already known
- `ketch crawl` for multiple pages on one site

Use `agent_browser` instead only when the task requires interactive browser behavior, such as login/authenticated content, clicking or filling forms, screenshots, uploads/downloads, or JavaScript interaction that ketch cannot handle. Do not use ketch for local/private codebase search or authenticated pages. Bound ketch fetches and cite sources when doing research.
