# pi-gd

Portable [Pi](https://pi.dev) extensions, shared system instructions, and an idempotent installer
that keeps credentials, model choices, and session history local.

## Quick start

Requires **Git** and **Node.js 22.19+** (tested with Pi 1.4.0 on Linux and 1.5.0 on Windows).

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.5.0
git clone git@github.com:gdezan/pi-gd.git
cd pi-gd
node setup.mjs
```

Close Pi before running `setup.mjs`, then start `pi` and run `/login` to authenticate. On Windows,
run `node setup.mjs` from PowerShell (`bootstrap.sh` is Bash-only).

Setup inspects `~/.pi/agent` (or `PI_CODING_AGENT_DIR`), deploys custom resources to
`~/.pi/agent/pi-gd`, prompts for packages and bundled extensions, previews all writes, and applies
nothing on an unchanged rerun.

> [!IMPORTANT]
> If `~/.pi` is an existing checkout of this repo, clone into a separate directory—do not pull this
> layout into `~/.pi`.

## Extensions

| Extension                                                           | What it does                                                                                                  | Commands & shortcuts                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`pi-footer`](extensions/pi-footer/index.ts)                        | Powerline-style composable footer                                                                             | `/footer`, `/footer-statuses`, `/footer-health`           |
| [`pi-favorites-cycle`](extensions/pi-favorites-cycle/index.ts)      | Cycles `pi-model-pick` favorites (`model-picker-state.json`)                                                  | `Ctrl+P`, `Ctrl+Shift+P` (`Alt+P` on Windows/WSL)         |
| [`pi-provider-usage`](extensions/pi-provider-usage/index.ts)        | Read-only quota meters (Cursor, Codex, OpenAI, Claude Code, OpenCode Go, xAI, Copilot, Antigravity, DeepSeek) | `/usage`, `/usage refresh`                                |
| [`pi-session-autoname`](extensions/pi-session-autoname/index.ts)    | Background session naming via shared utility model                                                            | `/autoname`, `/autoname model`                            |
| [`pi-next-prompt`](extensions/pi-next-prompt/index.ts)              | Dim next-prompt suggestions in empty editor (Pi 1.4.0+)                                                       | `/next-prompt` (`on`/`off`), `Tab` / `Right` to accept    |
| [`pi-cache-observer`](extensions/pi-cache-observer/README.md)       | Prompt-cache hit-rate tracking, miss alerts, opt-in optimizer                                                 | `/cache`, `/cache doctor`, `/cache reset`, `/cache clear` |
| [`pi-ask-user-question`](extensions/pi-ask-user-question/README.md) | Sequential `ask_user_question` tool and reply extractor                                                       | `/answer`                                                 |

Curated third-party packages (`model-pick`, `workflow`, `plannotator`, `cursor`, `blackhole`, `fff`,
`web-search`, `browser`, `observational-memory`) live in [`manifest.json`](manifest.json)—run
`node setup.mjs --list-packages` to inspect sources.

## Setup & updates

```sh
git pull
node setup.mjs --reuse-selection        # Reapply saved choices
node setup.mjs --link                   # Symlink local extensions for live editing
node setup.mjs --dry-run                # Preview plan without writes or installs
```

Common flags (run `node setup.mjs --help` for the full CLI):

- `--update-packages` — update selected third-party packages (respects existing pins).
- `--repair` — reinstall missing or broken selected packages.
- `--replace-legacy` — back up and replace differing legacy resources listed in `manifest.json`.
- `--replace-config` — update the shared instruction block without prompting; keeps local text.
- `--apply-preferences` — overwrite shared keys from [`preferences.json`](preferences.json).
- `--skip-packages` — update local resources and preferences only.
- `--json` — emit one JSON receipt (implies `--non-interactive`; pair with explicit flags or saved
  choices and `--conflicts keep` if needed).

Uninstalling packages uses `pi remove` (or checking them in the interactive permanent-delete step,
which is unchecked by default and skips `extensions/herdr-agent-state.ts`, `extensions/atuin.ts`,
and `extensions/scoutr-stream.ts`). Backups go to `<agent-dir>/toolkit-backups/`.

### Preview in an isolated directory

```sh
node setup.mjs --agent-dir "$HOME/.local/share/pi-gd-preview" --skip-packages
PI_CODING_AGENT_DIR="$HOME/.local/share/pi-gd-preview" pi
```

## Customization

| File                                   | Purpose                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| [`manifest.json`](manifest.json)       | Package checklist, bundled extensions, legacy migration paths         |
| [`preferences.json`](preferences.json) | Default theme, compaction, and TUI settings (fills missing keys only) |
| [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md) | Shared system instructions                                            |
| `~/.pi/agent/toolkit-keep.json`        | Optional `{"keep": ["extensions/..."]}` paths to hide from cleanup    |

### System instructions (`APPEND_SYSTEM.md`)

Setup updates only the delimited block inside `<agent-dir>/APPEND_SYSTEM.md` and leaves everything
outside it untouched:

```markdown
<!-- BEGIN pi-gd:shared -->

...managed from APPEND_SYSTEM.md...
<!-- END pi-gd:shared -->

## Machine-specific instructions

...local rules preserved across runs...
```

### Shared utility model (`autoname` + `next-prompt`)

Both features share `utilityModel` in `<agent-dir>/settings.json` (default: `openai/gpt-6-luna`,
`low` thinking; Pi 1.4.0+ required) and never fall back to the active conversation model:

```json
{
  "utilityModel": { "model": "openai/gpt-6-luna", "thinkingLevel": "low" },
  "sessionAutoname": { "enabled": true },
  "nextPrompt": { "enabled": true }
}
```

Use `/autoname model <provider/id> [thinking]` to update both features at once.

### Provider usage notes

- **OpenAI shared plan (`openai/*`)**: pairs `/login openai` with Pi's `openai-codex` login (or
  `$CODEX_HOME/auth.json` / `~/.codex/auth.json`) for the same account; clears the meter if
  verification fails.
- **Cursor (`cursor/*`)**: reads Cursor desktop's login read-only (separate from `pi-cursor-sdk`);
  macOS may prompt for Keychain access to **Cursor Safe Storage**.

## Development & tests

```sh
npm install
npm run lint
npm run format:check
npm test
npm run test:resources
npm run test:wizard             # Python 3, Unix PTY
npm run test:utility-tui        # Python 3 + tmux; requires pi-model-pick (local fixture, no API calls)
```

---

Inspired by [pi-agent-toolkit](https://github.com/danchamorro/pi-agent-toolkit).
