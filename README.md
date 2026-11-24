# Pi setup

My [Pi](https://pi.dev) extensions and preferences, ready to install on another machine. Choose
packages during setup; model choices, credentials, and session history stay local.

Includes a custom footer, favorites-based model cycling, usage and cache displays, automatic session
naming and next-prompt suggestions using a shared utility model, and a questionnaire tool.

## Install

Requires Git and Node.js **22.19+**. Tested with Pi **1.4.0** on Linux; Windows setup has also been
checked with Pi **1.5.0** and PowerShell-compatible commands.

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.5.0
git clone git@github.com:gdezan/pi-agent-setup.git
cd pi-agent-setup
node setup.mjs
```

The first run installs the wizard's pinned dependencies. Setup shows a package checklist, an
optional unchecked delete checklist when there are cleanup candidates, and a change preview before
writing to `~/.pi/agent` (or `PI_CODING_AGENT_DIR` if set). Selected local extensions with pinned
runtime dependencies get their own locked installation. Close Pi first. Start `pi` afterward and use
`/login` to authenticate.

On Windows, run `node setup.mjs` from PowerShell; `bootstrap.sh` requires Bash. Package operations
use Windows `npm.cmd` and `pi.cmd` shims and reject package arguments containing shell
metacharacters.

Run setup as often as needed. It keeps installed third-party packages, remembers your choices, and
makes no changes on an unchanged rerun. Recognized legacy resources matching the bundle move into a
backup so the bundled versions become active. If a legacy copy differs, setup asks before migrating
it. Unrelated resources stay in place.

The interactive wizard also offers an optional **permanent delete** checklist for unselected
packages and unrelated local extensions, skills, and local packages. Nothing is checked by default,
and the checklist is not available in noninteractive runs. Unlike legacy migration, checked
deletions have no setup-managed backup.

> [!IMPORTANT]
> If your existing `~/.pi` is a checkout of this repository, **do not pull this layout into it**.
> Clone into a separate folder. Setup can use that existing installation without moving its
> extensions.

## Development checks

Run `npm install` to install development dependencies, then use `npm run lint` to lint JavaScript
and TypeScript, `npm run format` to format supported files, and `npm run format:check` to check
formatting without writing changes. Oxfmt targets a 100-column print width; it may leave unbreakable
content longer.

## Customize

| File                                   | What to change                                    |
| -------------------------------------- | ------------------------------------------------- |
| [`manifest.json`](manifest.json)       | Package checklist and known legacy resource paths |
| [`preferences.json`](preferences.json) | Shared display and compaction defaults            |
| [`dotfiles/`](dotfiles/)               | Custom extensions and system instructions         |

Setup fills missing preferences without replacing existing values. Package selections are saved per
machine; existing package pins and filters are preserved. Use `pi config` to disable individual
extensions or skills, and `pi remove` to uninstall packages—deselecting one during setup does not
remove it unless you explicitly check it in the delete step.

Setup excludes `extensions/herdr-agent-state.ts`, `extensions/atuin.ts`, and
`extensions/scoutr-stream.ts` from cleanup on every machine, even without a local keep list.

Setup also offers to delete other Pi resources in `~/.pi/agent` that it does not own. For anything
you maintain by hand there, list it once in `~/.pi/agent/toolkit-keep.json` and setup stops offering
it:

```json
{
  "keep": ["extensions/herdr-agent-state.ts", "extensions/machine-prompt.ts"]
}
```

Entries are paths relative to the agent directory; a directory entry keeps everything beneath it.
The file is optional, so a machine with nothing to protect behaves as before. Setup reports which
entries it honoured, so a keep that stops working is visible rather than silent.

For live editing, run `node setup.mjs --link`. This links custom resources to the checkout instead
of copying them. Keep the checkout in place and reload Pi after edits. System instructions remain a
regular file in both modes; rerun setup to refresh their shared block.

### Shared and machine-specific instructions

Setup manages only the marked block in `<agent-dir>/APPEND_SYSTEM.md`:

```markdown
<!-- BEGIN pi-agent-setup:shared -->

Shared instructions from dotfiles/APPEND_SYSTEM.md
<!-- END pi-agent-setup:shared -->

## Machine-specific instructions

These instructions supplement the shared rules above. Where they conflict, follow these
machine-specific rules.

Your local tools, provider workarounds, and other machine-specific rules.
```

Edit shared rules in this checkout's `dotfiles/APPEND_SYSTEM.md`, without adding markers there. Put
local instructions outside the installed file's markers. Setup preserves all outside text and does
not treat those edits as conflicts. Edits inside the block require a decision before setup replaces
them. Incomplete pairs, repeated, inline, or reversed markers stop setup until repaired.

On migration, setup wraps known source-owned copies and converts its old source symlink into a
regular file. An unfamiliar unmarked file requires a decision: adding the shared block keeps the
original text in the machine-specific section and backs up the original file. Review that retained
text for duplicate or conflicting rules; setup does not attempt to extract machine-specific
instructions automatically.

A symlink to any other source is refused before setup writes anything. To adopt it, replace the link
with a regular copy of its contents first; setup never modifies the linked source.

External tools, browser setup, MCP credentials, Herdr integration, and skills are not provisioned
here. Previously installed loose skills are not removed automatically; review the optional delete
checklist if you want to remove them.

### Favorite models

Select the **model-pick** package and **favorites-cycle** extension during setup. `/pick` or
**Ctrl+Shift+M** opens the searchable picker with favorites first, then recents and other available
models. `/fav` adds or removes the current model from favorites.

**Ctrl+P** cycles forward through available favorites in their saved order. The configured
backward-cycle shortcut (**Alt+P** on Windows/WSL, **Ctrl+Shift+P** elsewhere) cycles backward.
These use Pi's `app.model.cycleForward` and `app.model.cycleBackward` keybindings. Changes made with
`/fav` apply to the next keypress; unavailable models are skipped. If no favorites are available,
cycling shows a warning instead of switching to a non-favorite.

Favorites live in `<agent-dir>/model-picker-state.json`, managed by `pi-model-pick`. The local
cycling extension only reads that file. Favorites store model identities, not per-model thinking
levels or tier labels. The former model-tier commands and badge have been removed.

### Utility model and next-prompt suggestions

AutoName and next-prompt share a model separate from your conversation model and favorites. The
default is `openai/gpt-6-luna` with low thinking. Pi **1.4.0+** is required for the provider-neutral
nested requests.

For an existing installation, close Pi, rerun `node setup.mjs`, and select `next-prompt` in the
extension checklist. The shared utility-model code is imported by both features; it is not a
separate extension to enable. Reusing the saved selection alone does not enable newly added
extensions.

```text
/autoname model                            Show the shared model and credential availability
/autoname model openai/gpt-6-luna low       Save the model used by both features
/autoname                                   Generate a session title now
/next-prompt                                Show suggestion status, latency, tokens, and cost
/next-prompt off                            Disable automatic suggestions
/next-prompt on                             Enable automatic suggestions
```

Suggestions appear as dim text in an empty editor after a successful reply fully settles. **Tab or
Right Arrow** copies the suggestion into the editor without sending it. Edit it or press Enter to
send. Typing or Escape dismisses it. Pending suggestions are cancelled when you type, navigate
branches, or start another run. Favorite-model cycling remains available.

Configure both features in `<agent-dir>/settings.json`:

```json
{
  "utilityModel": {
    "model": "openai/gpt-6-luna",
    "thinkingLevel": "low"
  },
  "sessionAutoname": { "enabled": true },
  "nextPrompt": { "enabled": true }
}
```

Existing `sessionAutoname.model` and `sessionAutoname.thinkingLevel` remain readable fallbacks for
missing shared fields. Startup does not rewrite them. Saving with `/autoname model ...` consolidates
them into `utilityModel` while preserving feature switches and unrelated settings. This existing
AutoName command now changes the model for **both features**. Commands save global settings; trusted
project `.pi/settings.json` fields override them and are reported when they mask a saved choice.
Changes apply to subsequent utility requests without reloading.

Neither feature silently falls back to your conversation model when the utility model or credentials
are unavailable. Automatic work skips; manual naming reports the problem. This changes AutoName's
previous fallback behavior. Configure the selected provider through Pi's normal authentication flow.

Next-prompt sends recent user requests and assistant replies, capped at 12,000 Unicode code points
after serialization. It can include up to three short excerpts from tool results in the latest
exchange, such as a failing test or a relevant line from a file read. It uses the conversation as
seen after context edits and does not include images, tool metadata, or hidden reasoning. It selects
lines instead of replaying logs or files. A selected line can still contain sensitive data and may
go to a different provider than the conversation. Use `/next-prompt off` to stop suggestion
requests.

Requests use a 512-token output budget including reasoning, a 10-second timeout, and no retries. No
obvious next step can mean no suggestion. AutoName retains its separate user-text excerpt and naming
limits.

AutoName starts a single background naming request as soon as the first user message reaches the
agent, without waiting for an assistant reply or delaying the conversation. The title appears when
the utility model responds; existing or manually assigned names are preserved.

`/next-prompt` reports the last completed suggestion request in the current session, including
provider-reported output tokens (which include reasoning) and estimated token cost. It does not add
this background usage to Pi's conversation totals or represent subscription billing. Suggestion
quality and actual provider latency depend on your selected model; the automated TUI check uses a
local fixture, not a paid model.

### Provider usage

Enable the **provider-usage** extension to view account usage with `/usage`. It supports Cursor,
Codex, OpenAI, Claude Code, OpenCode Go, xAI, GitHub Copilot, Antigravity, and DeepSeek. The footer
shows usage for the selected model's provider when available. Claude Code and Antigravity appear
only in the `/usage` popup because the extension reads their separate CLI logins.

#### OpenAI shared-plan usage

With an `openai/*` model selected and `/login openai` configured for ChatGPT, the footer and
`/usage` show only shared-plan quota windows and reset countdowns. App-specific usage is not
displayed.

Usage prefers Pi's `openai-codex` OAuth login, falling back to the Codex CLI login in
`$CODEX_HOME/auth.json` or `~/.codex/auth.json`. Both logins must use the same account/workspace.
The extension verifies that the Codex account contains exactly one app registration matching the
OpenAI login before reading plan usage. It never sends the native OpenAI token to the quota
endpoints or rewrites credentials. If the companion login expires or is rejected, sign in again with
`/login openai-codex` or Codex CLI.

These quota endpoints are undocumented. Failed verification clears the OpenAI meter rather than
showing stale or unrelated quota. Legacy `openai-codex` usage remains separate.

#### Cursor usage

`/usage` shows separate **Cursor** and **Other** quota bars. With a `cursor/*` model selected, the
footer shows the percentage remaining in each allowance and its reset countdown.

Usage reads Cursor's desktop login read-only, not the `pi-cursor-sdk` API key. Sign in to the same
account in Cursor desktop and Pi. If the desktop login expires, open Cursor and sign in again; this
extension does not refresh or write credentials.

On macOS, encrypted Cursor desktop credentials require access to the **Cursor Safe Storage** entry
in Keychain. If access fails, allow it and reopen `/usage` to retry. With a Cursor model selected,
`/usage refresh` also retries access.

## Update

From this checkout, with Pi closed:

```sh
git pull
node setup.mjs --reuse-selection
```

Copy/link mode is remembered. Optional flags:

- `--update-packages`: update selected third-party packages, respecting their pins.
- `--repair`: reinstall selected packages that are missing or broken.
- `--replace-legacy`: migrate differing manifest-listed legacy resources without prompting, after
  backing them up.
- `--apply-preferences`: overwrite the shared preference keys.
- `--skip-packages`: work only on custom resources and preferences.

For local edits or uncertain matches, the wizard asks what to keep and remembers the answer. File
conflicts offer a colored current/proposed diff and backed-up replacement. For system instructions,
replacement updates only the shared block, preserving machine-specific text. Use `--replace-config`
to accept that update or adoption without prompting; malformed markers still require manual repair.
Backups go under `<agent-dir>/toolkit-backups/`. Interrupted package operations resume with
`--reuse-selection`; completed installs are skipped.

Use `--dry-run` to preview without writes or downloads; wizard dependencies must already be
installed. For automation, use an explicit selection or saved choices, plus `--json`. Unresolved
conflicts require an explicit policy such as `--conflicts keep`; `--yes` does not resolve them. See
`node setup.mjs --help`.

## Preview alongside an existing setup

```sh
node setup.mjs --agent-dir "$HOME/.local/share/pi-toolkit-preview" --skip-packages
PI_CODING_AGENT_DIR="$HOME/.local/share/pi-toolkit-preview" pi
```

This installs only the custom resources into a separate Pi directory. Use the same directory for
subsequent setup and Pi commands. It is **not a sandbox**: extensions still have access to your user
files.

## Tests

```sh
npm test
npm run test:resources
npm run test:wizard     # Python 3, Unix pseudo-terminal
pi install npm:pi-model-pick # Required for the TUI check, or set PI_MODEL_PICK_EXTENSION
npm run test:utility-tui # Python 3 and tmux; isolated Pi, local fixture, no API calls
```

Inspired by [pi-agent-toolkit](https://github.com/danchamorro/pi-agent-toolkit).
