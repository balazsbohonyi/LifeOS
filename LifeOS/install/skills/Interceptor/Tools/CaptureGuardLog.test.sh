#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper_source="$(sed -n '/^has_multiple_hard_links() {/,/^}/p' "$SCRIPT_DIR/Capture.sh")"
function_source="$(sed -n '/^guard_skipped() {/,/^}/p' "$SCRIPT_DIR/Capture.sh")"
if [ -z "$helper_source" ] || [ -z "$function_source" ]; then
  echo "Capture.sh guard logging functions not found" >&2
  exit 1
fi
eval "$helper_source"
eval "$function_source"

tmp="$(mktemp -d /tmp/lifeos-capture-guard.XXXXXX)"
case "$tmp" in
  /tmp/lifeos-capture-guard.*) ;;
  *) echo "unexpected temporary test path: $tmp" >&2; exit 1 ;;
esac
trap 'rm -rf -- "$tmp"' EXIT

home="$tmp/home"
config_dir="$home/.config/LIFEOS"
user_dir="$config_dir/USER"
private_memory="$user_dir/MEMORY"
runtime_lifeos="$tmp/runtime/LIFEOS"
external="$tmp/external"
external_log="$external/capture-guard.jsonl"
mkdir -p "$private_memory" "$runtime_lifeos" "$external"
ln -s "$private_memory" "$runtime_lifeos/MEMORY"

HOME="$home"
LIFEOS_CONFIG_DIR="$config_dir"
LIFEOS_DIR="$runtime_lifeos"
OUT="$tmp/capture.png"

ln -s "$external" "$private_memory/OBSERVABILITY"
guard_skipped "directory-symlink"
test ! -e "$external_log"

rm "$private_memory/OBSERVABILITY"
mkdir "$private_memory/OBSERVABILITY"
printf 'keep-this-content\n' > "$external_log"
ln -s "$external_log" "$private_memory/OBSERVABILITY/capture-guard.jsonl"
guard_skipped "leaf-symlink"
test "$(cat "$external_log")" = "keep-this-content"

rm "$private_memory/OBSERVABILITY/capture-guard.jsonl"
ln "$external_log" "$private_memory/OBSERVABILITY/capture-guard.jsonl"
guard_skipped "leaf-hardlink"
test "$(cat "$external_log")" = "keep-this-content"
links="$(stat -c '%h' -- "$external_log" 2>/dev/null || stat -f '%l' "$external_log")"
test "$links" -eq 2

echo "Capture.sh guard log boundary tests passed."
