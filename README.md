# Pi setup

My [Pi](https://pi.dev) extensions, skills, and preferences, ready to install on another machine. Choose packages during setup; model choices, credentials, and session history stay local.

Includes a custom footer, model tiers, usage and cache displays, questionnaire and todo tools, plus Impeccable and session-analysis skills.

## Install

Requires Git and Node.js **22.19+**. Tested with Pi **0.85.1** on Linux.

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.85.1
git clone git@github.com:gdezan/pi-agent-setup.git
cd pi-agent-setup
node setup.mjs
```

Setup asks which third-party packages to install, then confirms before writing to `~/.pi/agent` (or `PI_CODING_AGENT_DIR` if set). Close running Pi sessions first. Start `pi` and use `/login` to authenticate.

> [!IMPORTANT]
> If your existing `~/.pi` is a checkout of this repository, **do not pull this layout into it**. Clone into a separate folder and use the preview below. Setup refuses duplicate legacy resources rather than migrating them automatically.

## Customize

| File | What to change |
| --- | --- |
| [`manifest.json`](manifest.json) | Third-party packages offered during setup |
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

Add `--link` if using link mode, or `--apply-preferences` to overwrite existing values for the shared preference keys. Use `--skip-packages` to update only custom resources without downloading packages.

Replaced files are backed up under `<agent-dir>/toolkit-backups/`. Locally edited system instructions require explicit replacement. If a package install fails, fix the reported issue and rerun; completed installs are kept.

Run `node setup.mjs --help` for all options, including non-interactive package selection and dry runs.

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
npm run test:skills     # Python 3 required
```

Inspired by [pi-agent-toolkit](https://github.com/danchamorro/pi-agent-toolkit).
