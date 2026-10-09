# Pi setup

My [Pi](https://pi.dev) extensions, skills, and preferences, ready to install on another machine. Choose packages during setup; model choices, credentials, and session history stay local.

Includes a custom footer, model tiers, usage and cache displays, automatic session naming, questionnaire and todo tools, plus Impeccable and session-analysis skills.

## Install

Requires Git and Node.js **22.19+**. Tested with Pi **0.85.1** on Linux.

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
git clone git@github.com:gdezan/pi-agent-setup.git
cd pi-agent-setup
node setup.mjs
```

The first run installs the wizard's pinned dependencies. Setup shows a package checklist, an optional unchecked delete checklist when there are cleanup candidates, and a change preview before writing to `~/.pi/agent` (or `PI_CODING_AGENT_DIR` if set). Close Pi first. Start `pi` afterward and use `/login` to authenticate.

Run setup as often as needed. It keeps installed third-party packages, remembers your choices, and makes no changes on an unchanged rerun. Recognized legacy resources matching the bundle move into a backup so the bundled versions become active. If a legacy copy differs, setup asks before migrating it. Unrelated resources stay in place.

The interactive wizard also offers an optional **permanent delete** checklist for unselected packages and unrelated local extensions, skills, and local packages. Nothing is checked by default, and the checklist is not available in noninteractive runs. Unlike legacy migration, checked deletions have no setup-managed backup.

> [!IMPORTANT]
> If your existing `~/.pi` is a checkout of this repository, **do not pull this layout into it**. Clone into a separate folder. Setup can use that existing installation without moving its extensions.

## Customize

| File | What to change |
| --- | --- |
| [`manifest.json`](manifest.json) | Package checklist and known legacy resource paths |
| [`preferences.json`](preferences.json) | Shared display and compaction defaults |
| [`dotfiles/`](dotfiles/) | Custom extensions, skills, and system instructions |

Setup fills missing preferences without replacing existing values. Package selections are saved per machine; existing package pins and filters are preserved. Use `pi config` to disable individual extensions or skills, and `pi remove` to uninstall packages—deselecting one during setup does not remove it unless you explicitly check it in the delete step.

Setup also offers to delete every Pi resource in `~/.pi/agent` that it does not own, which is wrong for anything you maintain by hand there. List those once in `~/.pi/agent/toolkit-keep.json` and setup stops offering them:

```json
{
  "keep": [
    "extensions/herdr-agent-state.ts",
    "extensions/machine-prompt.ts"
  ]
}
```

Entries are paths relative to the agent directory; a directory entry keeps everything beneath it. The file is optional, so a machine with nothing to protect behaves as before. Setup reports which entries it honoured, so a keep that stops working is visible rather than silent.

For live editing, run `node setup.mjs --link`. This links custom resources to the checkout instead of copying them. Keep the checkout in place and reload Pi after edits.

External tools, browser setup, MCP credentials, Herdr integration, and separately managed `~/.agents/skills` are not provisioned here.

### OpenAI shared-plan usage

With an `openai/*` model selected and `/login openai` configured for ChatGPT, the footer and `/usage` show only shared-plan quota windows and reset countdowns. App-specific usage is not displayed.

Usage prefers Pi's `openai-codex` OAuth login, falling back to the Codex CLI login in `$CODEX_HOME/auth.json` or `~/.codex/auth.json`. Both logins must use the same account/workspace. The extension verifies that the Codex account contains exactly one app registration matching the OpenAI login before reading plan usage. It never sends the native OpenAI token to the quota endpoints or rewrites credentials. If the companion login expires or is rejected, sign in again with `/login openai-codex` or Codex CLI.

These quota endpoints are undocumented. Failed verification clears the OpenAI meter rather than showing stale or unrelated quota. Legacy `openai-codex` usage remains separate.

### Cursor usage

`/usage` shows separate **Cursor** and **Other** quota bars. With a `cursor/*` model selected, the footer shows the percentage remaining in each allowance and its reset countdown.

Usage reads Cursor's desktop login read-only, not the `pi-cursor-sdk` API key. Sign in to the same account in Cursor desktop and Pi. If the desktop login expires, open Cursor and sign in again; this extension does not refresh or write credentials.

## Update

From this checkout, with Pi closed:

```sh
git pull
node setup.mjs --reuse-selection
```

Copy/link mode is remembered. Optional flags:

- `--update-packages`: update selected third-party packages, respecting their pins.
- `--repair`: reinstall selected packages that are missing or broken.
- `--replace-legacy`: migrate differing manifest-listed legacy resources without prompting, after backing them up.
- `--apply-preferences`: overwrite the shared preference keys.
- `--skip-packages`: work only on custom resources and preferences.

For local edits or uncertain matches, the wizard asks what to keep and remembers the answer. File conflicts offer a diff and backed-up replacement. Backups go under `<agent-dir>/toolkit-backups/`. Interrupted package operations resume with `--reuse-selection`; completed installs are skipped.

Use `--dry-run` to preview without writes or downloads; wizard dependencies must already be installed. For automation, use an explicit selection or saved choices, plus `--json`. Unresolved conflicts require an explicit policy such as `--conflicts keep`; `--yes` does not resolve them. See `node setup.mjs --help`.

## Preview alongside an existing setup

```sh
node setup.mjs --agent-dir "$HOME/.local/share/pi-toolkit-preview" --skip-packages
PI_CODING_AGENT_DIR="$HOME/.local/share/pi-toolkit-preview" pi
```

This installs only the custom resources into a separate Pi directory. Use the same directory for subsequent setup and Pi commands. It is **not a sandbox**: extensions still have access to your user files.

## Tests

```sh
npm test
npm run test:resources
npm run test:skills     # Python 3
npm run test:wizard     # Python 3, Unix pseudo-terminal
```

Inspired by [pi-agent-toolkit](https://github.com/danchamorro/pi-agent-toolkit).
