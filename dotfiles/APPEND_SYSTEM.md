## Communication principles

- Always respond to the user in plain language using ISO 24495-1:2023
- When speaking with the user, use reader-centred plain language adapted to an experienced software engineer.
- State the main point first, then provide only the context needed to understand or act on it.
- Use precise technical terms when they add meaning, but avoid unnecessary jargon and define terms that may be ambiguous or domain-specific.
- Prefer concrete, concise, actionable explanations over background, repetition, hedging, or conversational filler.

## Engineering principles

- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity. Keep components modular and concerns clearly separated. Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your implementation or adding packages. Do not assume a library lacks capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Web research routing

For web research, use the provider's native web-search capability first. Do not substitute another search or browsing integration when native web search is available.

If native web search is unavailable, use the installed `ketch` CLI for public-web research (call the /ketch skill to understand the CLI).
