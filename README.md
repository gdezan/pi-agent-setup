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

The first run installs the wizard's pinned dependencies. Setup shows one package checklist and a change preview before writing to `~/.pi/agent` (or `PI_CODING_AGENT_DIR` if set). Close Pi first. Start `pi` afterward and use `/login` to authenticate.

Run setup as often as needed. It keeps installed packages, remembers your choices, and makes no changes on an unchanged rerun. Recognized legacy extensions stay in place; their bundled duplicates are disabled.

> [!IMPORTANT]
> If your existing `~/.pi` is a checkout of this repository, **do not pull this layout into it**. Clone into a separate folder. Setup can use that existing installation without moving its extensions.

## Customize

| File | What to change |
| --- | --- |
| [`manifest.json`](manifest.json) | Package checklist and known legacy resource paths |
| [`preferences.json`](preferences.json) | Shared display and compaction defaults |
| [`dotfiles/`](dotfiles/) | Custom extensions, skills, and system instructions |

Setup fills missing preferences without replacing existing values. Package selections are saved per machine; existing package pins and filters are preserved. Use `pi config` to disable individual extensions or skills, and `pi remove` to uninstall packages—deselecting one during setup does not remove it.

For live editing, run `node setup.mjs --link`. This links custom resources to the checkout instead of copying them. Keep the checkout in place and reload Pi after edits.

External tools, browser setup, MCP credentials, Herdr integration, and separately managed `~/.agents/skills` are not provisioned here.

## Update

From this checkout, with Pi closed:

```sh
git pull
node setup.mjs --reuse-selection
```

Copy/link mode is remembered. Optional flags:

- `--update-packages`: update selected third-party packages, respecting their pins.
- `--repair`: reinstall selected packages that are missing or broken.
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
