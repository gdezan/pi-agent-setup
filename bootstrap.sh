#!/usr/bin/env bash
# Bootstrap the portable Pi configuration in this repository.
#
# This script intentionally does not copy secrets, sessions, caches, or
# dependencies. It points Pi at this checkout and lets Pi install the package
# sources declared in agent/settings.json.

set -Eeuo pipefail

readonly SCRIPT_NAME="$(basename "$0")"
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly DEFAULT_SESSION_DIR="${HOME}/.local/state/pi/sessions"
readonly NODE_MIN_VERSION="22.19.0"
readonly DEFAULT_PI_VERSION="0.83.0"

CONFIG_DIR="${ROOT_DIR}/agent"
SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-${DEFAULT_SESSION_DIR}}"
PI_VERSION="${PI_VERSION:-${DEFAULT_PI_VERSION}}"
AUTO_YES=false
CHECK_ONLY=false
DRY_RUN=false
NO_OPTIONAL=false
NO_PACKAGES=false
NO_PI_INSTALL=false
OFFLINE=false
UPGRADE_PI=false
WRITE_SHELL_CONFIG=false

ERRORS=0
WARNINGS=0
LOG_FILE=""

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
	readonly C_DIM=$'\033[2m'
	readonly C_BLUE=$'\033[34m'
	readonly C_GREEN=$'\033[32m'
	readonly C_YELLOW=$'\033[33m'
	readonly C_RED=$'\033[31m'
	readonly C_RESET=$'\033[0m'
else
	readonly C_DIM=""
	readonly C_BLUE=""
	readonly C_GREEN=""
	readonly C_YELLOW=""
	readonly C_RED=""
	readonly C_RESET=""
fi

usage() {
	cat <<EOF
${SCRIPT_NAME} — set up this Pi configuration on a new machine

Usage:
  ./${SCRIPT_NAME} [options]

What it does:
  • validates the checkout and local configuration
  • checks Node, Git, SSH, and helpful command-line tools
  • installs the pinned Pi CLI when it is missing
  • points Pi at this checkout's agent/ directory
  • installs/reconciles configured npm and Git packages
  • prints clear next steps for provider authentication

Options:
  -y, --yes              Accept safe installation prompts
      --check            Validate only; do not install or modify anything
      --dry-run          Show changes without applying them
      --offline          Skip network operations and package installation
      --no-packages      Skip \`pi update --extensions\`
      --no-optional      Skip checks for optional tools (ketch, rg, fd)
      --no-pi-install    Do not install Pi if it is missing
      --upgrade-pi       Reinstall the configured Pi version if it differs
      --pi-version VER   Pi version to install (default: ${DEFAULT_PI_VERSION})
      --config-dir DIR   Pi config directory (default: <checkout>/agent)
      --session-dir DIR  Session directory (default: ${DEFAULT_SESSION_DIR})
      --shell-config      Add PI_* exports to the current user's shell rc file
  -h, --help             Show this help

Examples:
  ./bootstrap.sh
  ./bootstrap.sh --yes
  ./bootstrap.sh --check
  ./bootstrap.sh --dry-run --no-packages
  ./bootstrap.sh --shell-config

The script never handles provider credentials. Authenticate Pi separately with
\`pi\`, or place credentials in the local ignored auth.json file.
EOF
}

fail_trap() {
	local exit_code=$?
	printf '%s✗ bootstrap failed at line %s (exit %s)%s\n' "$C_RED" "$1" "$exit_code" "$C_RESET" >&2
	if [[ -n "$LOG_FILE" ]]; then
		printf '%s  Log: %s%s\n' "$C_DIM" "$LOG_FILE" "$C_RESET" >&2
	fi
	exit "$exit_code"
}
trap 'fail_trap "$LINENO"' ERR

while (($# > 0)); do
	case "$1" in
		-y|--yes)
			AUTO_YES=true
			;;
		--check)
			CHECK_ONLY=true
			;;
		--dry-run)
			DRY_RUN=true
			;;
		--offline)
			OFFLINE=true
			;;
		--no-packages)
			NO_PACKAGES=true
			;;
		--no-optional)
			NO_OPTIONAL=true
			;;
		--no-pi-install)
			NO_PI_INSTALL=true
			;;
		--upgrade-pi)
			UPGRADE_PI=true
			;;
		--pi-version)
			(($# >= 2)) || { printf '%s--pi-version needs a value%s\n' "$C_RED" "$C_RESET" >&2; exit 2; }
			PI_VERSION="$2"
			shift
			;;
		--config-dir)
			(($# >= 2)) || { printf '%s--config-dir needs a value%s\n' "$C_RED" "$C_RESET" >&2; exit 2; }
			CONFIG_DIR="$2"
			shift
			;;
		--session-dir)
			(($# >= 2)) || { printf '%s--session-dir needs a value%s\n' "$C_RED" "$C_RESET" >&2; exit 2; }
			SESSION_DIR="$2"
			shift
			;;
		--shell-config)
			WRITE_SHELL_CONFIG=true
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			printf '%sUnknown option: %s%s\n\n' "$C_RED" "$1" "$C_RESET" >&2
			usage >&2
			exit 2
			;;
	esac
	shift
done

if [[ "$CONFIG_DIR" != /* ]]; then
	CONFIG_DIR="$(cd -- "$CONFIG_DIR" 2>/dev/null && pwd -P)" || {
		printf '%sConfig directory does not exist: %s%s\n' "$C_RED" "$CONFIG_DIR" "$C_RESET" >&2
		exit 1
	}
fi

if [[ "$SESSION_DIR" != /* ]]; then
	SESSION_DIR="${ROOT_DIR}/${SESSION_DIR}"
fi

LOG_FILE="${TMPDIR:-/tmp}/pi-agent-bootstrap-$(date +%Y%m%d-%H%M%S).log"
if command -v tee >/dev/null 2>&1; then
	exec > >(tee -a "$LOG_FILE") 2>&1
else
	LOG_FILE=""
fi

log() {
	local level="$1"
	shift
	local color="$C_BLUE"
	case "$level" in
		OK) color="$C_GREEN" ;;
		WARN) color="$C_YELLOW" ;;
		ERROR) color="$C_RED" ;;
		STEP) color="$C_BLUE" ;;
	esac
	printf '%s[%s]%s %s\n' "$color" "$level" "$C_RESET" "$*"
}

step() { log STEP "$*"; }
ok() { log OK "$*"; }
warn() { WARNINGS=$((WARNINGS + 1)); log WARN "$*"; }
error() { ERRORS=$((ERRORS + 1)); log ERROR "$*"; }

run() {
	if [[ "$DRY_RUN" == true || "$CHECK_ONLY" == true ]]; then
		printf '%s  would run:%s' "$C_DIM" "$C_RESET"
		printf ' %q' "$@"
		printf '\n'
		return 0
	fi
	"$@"
}

ask_yes_no() {
	local question="$1"
	local default_answer="${2:-no}"
	local prompt='[y/N]'
	[[ "$default_answer" == yes ]] && prompt='[Y/n]'

	if [[ "$AUTO_YES" == true ]]; then
		return 0
	fi
	if [[ ! -t 0 ]]; then
		return 1
	fi

	local answer
	read -r -p "$question $prompt " answer || return 1
	answer="${answer,,}"
	if [[ -z "$answer" ]]; then
		[[ "$default_answer" == yes ]]
	else
		[[ "$answer" == y || "$answer" == yes ]]
	fi
}

command_exists() { command -v "$1" >/dev/null 2>&1; }

suggest_install() {
	local tool="$1"
	local os="$(uname -s 2>/dev/null || printf unknown)"
	printf '%s  Suggested install for %s:%s\n' "$C_DIM" "$tool" "$C_RESET"
	case "$tool:$os" in
		node:Darwin) printf '    brew install node@22\n    # or use nvm: nvm install 22\n' ;;
		node:Linux) printf '    nvm install 22\n    # or install Node.js 22+ with your distribution\n' ;;
		node:MSYS_NT*|node:MINGW*|node:CYGWIN*) printf '    winget install OpenJS.NodeJS.LTS\n' ;;
		git:Darwin) printf '    xcode-select --install\n    # or: brew install git\n' ;;
		git:Linux) printf '    sudo apt install git\n' ;;
		git:MSYS_NT*|git:MINGW*|git:CYGWIN*) printf '    winget install Git.Git\n' ;;
		rg:Darwin|fd:Darwin) printf '    brew install ripgrep fd\n' ;;
		rg:Linux|fd:Linux) printf '    sudo apt install ripgrep fd-find\n' ;;
		rg:MSYS_NT*|rg:MINGW*|rg:CYGWIN*) printf '    winget install BurntSushi.ripgrep.MSVC sharkdp.fd\n' ;;
		ketch:*) printf '    Install ketch from its release/package source, then ensure it is on PATH.\n' ;;
		ssh:*) printf '    SSH is normally bundled with Git. Configure a GitHub key with:\n    ssh-keygen -t ed25519 -C "your-email@example.com"\n' ;;
		*) printf '    Install %s with your OS package manager.\n' "$tool" ;;
	esac
}

check_node() {
	if ! command_exists node; then
		error "Node.js is missing (Pi requires Node.js >= ${NODE_MIN_VERSION})."
		suggest_install node
		return
	fi

	local current
	current="$(node --version | sed 's/^v//')"
	if ! PI_SETUP_NODE_MIN_VERSION="$NODE_MIN_VERSION" node -e '
		const v = process.versions.node.split(".").map(Number);
		const min = process.env.PI_SETUP_NODE_MIN_VERSION.split(".").map(Number);
		const ok = v[0] > min[0] || (v[0] === min[0] && (v[1] > min[1] || (v[1] === min[1] && v[2] >= min[2])));
		process.exit(ok ? 0 : 1);
	'; then
		error "Node.js ${current} is too old; Pi requires >= ${NODE_MIN_VERSION}."
		suggest_install node
	else
		ok "Node.js ${current}"
	fi
}

check_required_tools() {
	local tool
	for tool in git ssh npm; do
		if command_exists "$tool"; then
			ok "$tool is available ($(command -v "$tool"))"
		else
			error "$tool is missing."
			suggest_install "$tool"
		fi
	done
}

check_optional_tools() {
	[[ "$NO_OPTIONAL" == true ]] && return
	local tool
	for tool in ketch rg; do
		if command_exists "$tool"; then
			ok "optional tool ${tool} is available"
		else
			warn "optional tool ${tool} is not installed"
			suggest_install "$tool"
		fi
	done

	if command_exists fd; then
		ok "optional tool fd is available"
	elif command_exists fdfind; then
		ok "optional tool fd is available via fdfind"
	else
		warn "optional tool fd is not installed"
		suggest_install fd
	fi
}

check_ssh_github() {
	if ! command_exists ssh; then
		return
	fi

	local output
	output="$(ssh -o BatchMode=yes -o ConnectTimeout=5 -T git@github.com 2>&1 || true)"
	if [[ "$output" == *"successfully authenticated"* ]]; then
		ok "GitHub SSH authentication is ready"
	elif [[ "$output" == *"Permission denied"* || "$output" == *"No supported authentication methods"* ]]; then
		warn "GitHub SSH authentication is not configured; the pinned pi-workflow package may not install."
		printf '%s  Test after adding a key: ssh -T git@github.com%s\n' "$C_DIM" "$C_RESET"
		suggest_install ssh
	else
		warn "Could not verify GitHub SSH authentication."
		printf '%s  Run manually for details: ssh -T git@github.com%s\n' "$C_DIM" "$C_RESET"
	fi
}

validate_checkout() {
	step "Checking checkout and configuration"
	if [[ ! -d "$CONFIG_DIR" ]]; then
		error "Config directory not found: $CONFIG_DIR"
		return
	fi
	if [[ ! -f "$CONFIG_DIR/settings.json" ]]; then
		error "Missing settings.json in $CONFIG_DIR"
		return
	fi

	if ! command_exists node; then
		return
	fi
	if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$CONFIG_DIR/settings.json"; then
		error "settings.json is not valid JSON"
		return
	fi

	local package_count
	package_count="$(node -e '
		const fs = require("fs");
		const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
		if (!Array.isArray(s.packages)) throw new Error("packages must be an array");
		process.stdout.write(String(s.packages.length));
	' "$CONFIG_DIR/settings.json")" || {
		error "settings.json does not contain a valid packages array"
		return
	}
	ok "Configuration is valid (${package_count} package entries)"

}

pi_version() {
	pi --version 2>/dev/null | head -n 1 | tr -d '[:space:]'
}

install_pi() {
	step "Installing Pi ${PI_VERSION}"
	if [[ "$DRY_RUN" == true || "$CHECK_ONLY" == true ]]; then
		run npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}"
		return
	fi
	if npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}"; then
		hash -r
		ok "Pi ${PI_VERSION} installed"
	else
		error "Pi installation failed. Global npm directories may not be writable."
		printf '%s  Try Node via nvm, then rerun this script.%s\n' "$C_DIM" "$C_RESET"
		suggest_install node
	fi
}

ensure_pi() {
	step "Checking Pi CLI"
	if ! command_exists pi; then
		warn "Pi is not installed."
		if [[ "$NO_PI_INSTALL" == true || "$CHECK_ONLY" == true || "$OFFLINE" == true ]]; then
			error "Pi is required to install the configured extensions."
			printf '%s  Install manually: npm install --global @earendil-works/pi-coding-agent@%s%s\n' "$C_DIM" "$PI_VERSION" "$C_RESET"
			return
		fi
		if ask_yes_no "Install Pi ${PI_VERSION} globally with npm?" yes; then
			install_pi
		else
			error "Pi is required; installation was declined."
			return
		fi
	fi

	if command_exists pi; then
		local current
		current="$(pi_version || true)"
		if [[ -n "$current" ]]; then
			ok "Pi ${current}"
			if [[ "$current" != "$PI_VERSION" ]]; then
				warn "Configured bootstrap version is ${PI_VERSION}, but Pi ${current} is installed."
				if [[ "$UPGRADE_PI" == true && "$CHECK_ONLY" == false && "$OFFLINE" == false ]]; then
					install_pi
				else
					printf '%s  Use --upgrade-pi to install the configured version.%s\n' "$C_DIM" "$C_RESET"
				fi
			fi
		else
			warn "Pi is on PATH but its version could not be read."
		fi
	fi
}

sync_packages() {
	if [[ "$CHECK_ONLY" == true || "$DRY_RUN" == true || "$NO_PACKAGES" == true || "$OFFLINE" == true ]]; then
		if [[ "$NO_PACKAGES" == true ]]; then
			warn "Skipping package sync (--no-packages)."
		elif [[ "$OFFLINE" == true ]]; then
			warn "Skipping package sync (--offline)."
		fi
		return
	fi
	if ! command_exists pi; then
		error "Cannot sync packages because Pi is unavailable."
		return
	fi

	step "Installing and reconciling configured Pi packages"
	if [[ ! -d "$SESSION_DIR" ]]; then
		mkdir -p "$SESSION_DIR"
	fi
	if GIT_TERMINAL_PROMPT=0 PI_CODING_AGENT_DIR="$CONFIG_DIR" PI_CODING_AGENT_SESSION_DIR="$SESSION_DIR" pi update --extensions; then
		ok "Pi packages are installed and reconciled"
	else
		error "Package sync failed. Check the log and GitHub SSH access, then rerun."
	fi
}

shell_rc() {
	local shell_name="${SHELL##*/}"
	case "$shell_name" in
		zsh) printf '%s/.zshrc' "${ZDOTDIR:-$HOME}" ;;
		bash) printf '%s/.bashrc' "$HOME" ;;
		*) return 1 ;;
	esac
}

write_shell_config() {
	[[ "$WRITE_SHELL_CONFIG" == true ]] || return 0
	local rc
	if ! rc="$(shell_rc)"; then
		warn "Could not identify a Bash or Zsh startup file; add these exports manually:"
		printf '  export PI_CODING_AGENT_DIR=%q\n' "$CONFIG_DIR"
		printf '  export PI_CODING_AGENT_SESSION_DIR=%q\n' "$SESSION_DIR"
		return
	fi

	local begin="# pi-agent-setup: begin"
	if [[ -f "$rc" ]] && grep -Fq "$begin" "$rc"; then
		ok "Shell configuration already contains the Pi profile (${rc})"
		return
	fi

	local config_quoted session_quoted
	printf -v config_quoted '%q' "$CONFIG_DIR"
	printf -v session_quoted '%q' "$SESSION_DIR"
	if [[ "$DRY_RUN" == true || "$CHECK_ONLY" == true ]]; then
		printf '%s  would append to %s:%s\n' "$C_DIM" "$rc" "$C_RESET"
		printf '%s\n' "$begin" "export PI_CODING_AGENT_DIR=${config_quoted}" "export PI_CODING_AGENT_SESSION_DIR=${session_quoted}" "# pi-agent-setup: end"
		return
	fi

	mkdir -p "$(dirname "$rc")"
	{
		printf '\n%s\n' "$begin"
		printf 'export PI_CODING_AGENT_DIR=%s\n' "$config_quoted"
		printf 'export PI_CODING_AGENT_SESSION_DIR=%s\n' "$session_quoted"
		printf '%s\n' '# pi-agent-setup: end'
	} >> "$rc"
	ok "Added Pi profile exports to ${rc}"
}

print_next_steps() {
	printf '\n%s%sNext steps%s\n' "$C_BLUE" "" "$C_RESET"
	printf '  1. For this shell: export PI_CODING_AGENT_DIR=%q\n' "$CONFIG_DIR"
	printf '  2. Start Pi: PI_CODING_AGENT_DIR=%q pi\n' "$CONFIG_DIR"
	printf '  3. Authenticate providers from inside Pi if needed.\n'
	if [[ "$WARNINGS" -gt 0 ]]; then
		printf '  4. Review the warnings above before relying on this machine.\n'
	fi
	if [[ -n "$LOG_FILE" ]]; then
		printf '\n%sFull log: %s%s\n' "$C_DIM" "$LOG_FILE" "$C_RESET"
	fi
}

printf '%sPi agent setup%s\n' "$C_BLUE" "$C_RESET"
printf '%s  checkout: %s%s\n' "$C_DIM" "$ROOT_DIR" "$C_RESET"
printf '%s  config:   %s%s\n' "$C_DIM" "$CONFIG_DIR" "$C_RESET"
printf '%s  mode:     %s%s\n\n' "$C_DIM" "$(if [[ "$CHECK_ONLY" == true ]]; then printf check; elif [[ "$DRY_RUN" == true ]]; then printf dry-run; else printf install; fi)" "$C_RESET"

if [[ "$OFFLINE" == true ]]; then
	NO_PACKAGES=true
fi

step "Checking runtime prerequisites"
check_node
check_required_tools
check_optional_tools
check_ssh_github
validate_checkout

if [[ "$ERRORS" -eq 0 ]]; then
	ensure_pi
	sync_packages
	write_shell_config
else
	warn "Prerequisite errors found; installation steps were skipped."
fi

print_next_steps

if [[ "$ERRORS" -gt 0 ]]; then
	printf '\n%sFinished with %s error(s) and %s warning(s).%s\n' "$C_RED" "$ERRORS" "$WARNINGS" "$C_RESET"
	exit 1
fi
printf '\n%sFinished successfully with %s warning(s).%s\n' "$C_GREEN" "$WARNINGS" "$C_RESET"
