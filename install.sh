#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
OpenCode Agent installer (Linux, single owner)

  bash install.sh [--source /path/to/checkout] [--no-setup]
  bash install.sh --repo <git-url> [--ref main] [--no-setup]

OPENCODE_AGENT_HOME defaults to ~/.opencode-agent.
The installer creates ~/.local/bin/opencode-agent and an owned OpenCode V2 runtime.
EOF
}

source_dir=""
repo="${OPENCODE_AGENT_REPO:-}"
ref="main"
setup=true
while (($#)); do
  case "$1" in
    --source) source_dir="${2:?Missing source directory}"; shift 2 ;;
    --repo) repo="${2:?Missing repository URL}"; shift 2 ;;
    --ref) ref="${2:?Missing ref}"; shift 2 ;;
    --no-setup) setup=false; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" == Linux ]] || { echo 'This installer currently supports Linux.' >&2; exit 1; }

home="${OPENCODE_AGENT_HOME:-$HOME/.opencode-agent}"
mkdir -p "$home"
home="$(cd "$home" && pwd)"
export OPENCODE_AGENT_HOME="$home"

# Bootstrap system prerequisites on common fresh VM images.
missing=false
for command in curl git unzip tar flock; do
  command -v "$command" >/dev/null 2>&1 || missing=true
done
if $missing; then
  elevate=()
  if ((EUID != 0)); then
    command -v sudo >/dev/null || { echo 'Install curl, git, unzip, tar, and util-linux first.' >&2; exit 1; }
    elevate=(sudo)
  fi
  if command -v apt-get >/dev/null; then
    "${elevate[@]}" apt-get update
    "${elevate[@]}" apt-get install -y curl git unzip tar util-linux ca-certificates
  elif command -v dnf >/dev/null; then
    "${elevate[@]}" dnf install -y curl git unzip tar util-linux ca-certificates
  elif command -v pacman >/dev/null; then
    "${elevate[@]}" pacman -S --needed --noconfirm curl git unzip tar util-linux ca-certificates
  else
    echo 'Install curl, git, unzip, tar, and util-linux with your package manager, then rerun.' >&2
    exit 1
  fi
fi

if [[ -z "$source_dir" && -z "$repo" && -f "${BASH_SOURCE[0]:-}" ]]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [[ -f "$candidate/packages/telegram/src/main.ts" ]] && source_dir="$candidate"
fi
if [[ -n "$source_dir" ]]; then
  source_dir="$(cd "$source_dir" && pwd)"
  [[ -f "$source_dir/packages/telegram/src/main.ts" ]] || { echo 'Not an OpenCode Agent checkout.' >&2; exit 1; }
elif [[ -n "$repo" ]]; then
  source_dir="$home/app"
  if [[ -e "$source_dir" ]]; then
    echo "$source_dir already exists. Use --source to install that checkout; existing work is preserved." >&2
    exit 1
  fi
  git clone --branch "$ref" -- "$repo" "$source_dir"
else
  echo 'Supply --repo <git-url> for a downloaded installer, or run install.sh from a checkout.' >&2
  exit 1
fi

bun="$home/tools/bun/bin/bun"
if [[ ! -x "$bun" ]]; then
  mkdir -p "$home/tools"
  curl -fsSL https://bun.sh/install -o "$home/tools/install-bun.sh"
  BUN_INSTALL="$home/tools/bun" bash "$home/tools/install-bun.sh" bun-v1.3.14
fi
(cd "$source_dir" && "$bun" install --frozen-lockfile)
mkdir -p "$HOME/.local/bin"
launcher="$HOME/.local/bin/opencode-agent"
if [[ -e "$launcher" ]] && ! grep -q '^# OpenCode Agent managed launcher$' "$launcher"; then
  echo "Refusing to replace an unrelated $launcher" >&2
  exit 1
fi
{
  echo '#!/usr/bin/env bash'
  echo '# OpenCode Agent managed launcher'
  printf 'if [[ -z "${OPENCODE_AGENT_HOME:-}" ]]; then export OPENCODE_AGENT_HOME=%q; fi\n' "$home"
  printf 'exec %q %q "$@"\n' "$bun" "$source_dir/packages/telegram/src/main.ts"
} > "$launcher"
chmod 755 "$launcher"
printf 'Installed %s\n' "$launcher"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) printf 'Add this to your shell profile: export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac
if $setup; then
  "$launcher" setup </dev/tty
else
  printf 'Run %s setup to install the owned OpenCode V2 runtime and configure Telegram.\n' "$launcher"
fi
