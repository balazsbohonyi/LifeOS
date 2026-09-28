#!/bin/bash
# LifeOS Pulse — POSIX Process Management
# Usage: manage.sh {start|stop|restart|status|install|uninstall}

set -eu

PLIST_NAME="com.lifeos.pulse"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
ORIGINAL_HOME="${HOME:?HOME must be set}"

absolute_from_home() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    '~') printf '%s\n' "$ORIGINAL_HOME" ;;
    '~/'*) printf '%s/%s\n' "$ORIGINAL_HOME" "${1#~/}" ;;
    *) printf '%s/%s\n' "$ORIGINAL_HOME" "$1" ;;
  esac
}

canonical_dir() {
  candidate="$(absolute_from_home "$1")"
  if [ ! -d "$candidate" ]; then
    echo "ERROR: expected directory does not exist: $candidate" >&2
    return 1
  fi
  (CDPATH= cd -- "$candidate" && pwd -P)
}

canonical_file_path() {
  candidate="$(absolute_from_home "$1")"
  parent="$(dirname -- "$candidate")"
  leaf="$(basename -- "$candidate")"
  parent="$(canonical_dir "$parent")" || return 1
  printf '%s/%s\n' "$parent" "$leaf"
}

HOME="$(canonical_dir "$ORIGINAL_HOME")" || exit 1

# The installed script locates its own runtime by default. Explicit roots are
# accepted for repair/update callers; relative values resolve exactly once
# against HOME, matching RuntimePaths.ts.
if [ -n "${PULSE_DIR:-}" ]; then
  PULSE_DIR="$(canonical_dir "$PULSE_DIR")" || exit 1
elif [ -n "${LIFEOS_DIR:-}" ]; then
  PULSE_DIR="$(canonical_dir "$(absolute_from_home "$LIFEOS_DIR")/PULSE")" || exit 1
elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  PULSE_DIR="$(canonical_dir "$(absolute_from_home "$CLAUDE_CONFIG_DIR")/LIFEOS/PULSE")" || exit 1
else
  PULSE_DIR="$SCRIPT_DIR"
fi

if [ -n "${LIFEOS_DIR:-}" ]; then
  LIFEOS_DIR="$(canonical_dir "$LIFEOS_DIR")" || exit 1
else
  LIFEOS_DIR="$(canonical_dir "$PULSE_DIR/..")" || exit 1
fi
if [ "$PULSE_DIR" != "$LIFEOS_DIR/PULSE" ]; then
  echo "ERROR: PULSE_DIR is not owned by LIFEOS_DIR: $PULSE_DIR" >&2
  exit 1
fi

if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  CLAUDE_CONFIG_DIR="$(canonical_dir "$CLAUDE_CONFIG_DIR")" || exit 1
else
  CLAUDE_CONFIG_DIR="$(canonical_dir "$LIFEOS_DIR/..")" || exit 1
fi
if [ "$LIFEOS_DIR" != "$CLAUDE_CONFIG_DIR/LIFEOS" ]; then
  echo "ERROR: LIFEOS_DIR is not owned by CLAUDE_CONFIG_DIR: $LIFEOS_DIR" >&2
  exit 1
fi

if [ -n "${LIFEOS_CONFIG_PATH:-}" ]; then
  LIFEOS_CONFIG_PATH="$(canonical_file_path "$LIFEOS_CONFIG_PATH")" || exit 1
else
  LIFEOS_CONFIG_PATH="$(canonical_file_path "$LIFEOS_DIR/USER/CONFIG/LIFEOS_CONFIG.toml")" || exit 1
fi

export HOME CLAUDE_CONFIG_DIR LIFEOS_DIR LIFEOS_CONFIG_PATH PULSE_DIR

PLIST_SRC="$PULSE_DIR/$PLIST_NAME.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
SERVICE_SRC="$PULSE_DIR/$PLIST_NAME.service"
SYSTEMD_SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_DST="$SYSTEMD_SERVICE_DIR/$PLIST_NAME.service"
LOCK_FILE="$PULSE_DIR/state/pulse.lock.json"
STATE_FILE="$PULSE_DIR/state/state.json"
RENDERER="$PULSE_DIR/lib/service-template.ts"
IDENTITY_HELPER="$PULSE_DIR/lib/posix-process-identity.ts"

# Prefer stable Bun installs over temporary package-manager shims.
if [ -x "$HOME/.bun/bin/bun" ]; then
  BUN_PATH="$HOME/.bun/bin/bun"
elif [ -x "/opt/homebrew/bin/bun" ]; then
  BUN_PATH="/opt/homebrew/bin/bun"
elif [ -x "/usr/local/bin/bun" ]; then
  BUN_PATH="/usr/local/bin/bun"
else
  BUN_PATH="$(command -v bun || true)"
fi
if [ -z "$BUN_PATH" ] || [ ! -x "$BUN_PATH" ]; then
  echo "ERROR: Bun executable not found" >&2
  exit 1
fi
BUN_PATH="$(canonical_file_path "$BUN_PATH")" || exit 1
export BUN_PATH

OS="$(uname -s)"
if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  echo "ERROR: manage.sh supports macOS and Linux only (found $OS)" >&2
  exit 1
fi

render_service() {
  src="$1"
  format="$2"
  dst="$3"
  tmp="$dst.tmp.$$"
  if ! "$BUN_PATH" run "$RENDERER" "$src" "$format" > "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$dst"
}

# Return a PID only when the lock, live process command, selected runtime, and
# selected config all describe the same Pulse instance. Any ambiguity fails
# closed: no PID is printed, so callers cannot signal an unrelated process.
owned_pid() {
  EXPECTED_RUNTIME_ROOT="$LIFEOS_DIR" \
  EXPECTED_CONFIG_PATH="$LIFEOS_CONFIG_PATH" \
  EXPECTED_SCRIPT_PATH="$PULSE_DIR/pulse.ts" \
  EXPECTED_EXECUTABLE_PATH="$BUN_PATH" \
  LOCK_FILE="$LOCK_FILE" \
  "$BUN_PATH" run "$IDENTITY_HELPER" owned-pid 2>/dev/null
}

registered_service_owned() {
  if [ "$OS" = "Linux" ]; then
    if [ ! -f "$SERVICE_DST" ]; then return 1; fi
    SERVICE_FILE="$SERVICE_DST" EXPECTED_PULSE_DIR="$PULSE_DIR" EXPECTED_SCRIPT="$PULSE_DIR/pulse.ts" \
    "$BUN_PATH" -e '
      import { readFileSync } from "node:fs";
      const text = readFileSync(process.env.SERVICE_FILE!, "utf8");
      const expectedDir = process.env.EXPECTED_PULSE_DIR!;
      const expectedScript = process.env.EXPECTED_SCRIPT!;
      const rawWorking = text.match(/^WorkingDirectory=(.+)$/m)?.[1]?.trim() ?? "";
      const rawExec = text.match(/^ExecStart=(.+)$/m)?.[1] ?? "";
      const decode = (value: string) => {
        const unescaped = value.replaceAll("%%", "%");
        if (!unescaped.startsWith("\"")) return unescaped;
        try { return JSON.parse(unescaped); } catch { return ""; }
      };
      if (decode(rawWorking) !== expectedDir) process.exit(2);
      if (!rawExec.replaceAll("%%", "%").includes(expectedScript)) process.exit(3);
    ' >/dev/null 2>&1
    return $?
  fi
  if [ ! -f "$PLIST_DST" ]; then return 1; fi
  working="$(/usr/bin/plutil -extract WorkingDirectory raw -o - "$PLIST_DST" 2>/dev/null || true)"
  script="$(/usr/bin/plutil -extract ProgramArguments.2 raw -o - "$PLIST_DST" 2>/dev/null || true)"
  [ "$working" = "$PULSE_DIR" ] && { [ "$script" = "$PULSE_DIR/pulse.ts" ] || [ "$script" = "pulse.ts" ]; }
}

stop_registered_service() {
  destination="$SERVICE_DST"
  if [ "$OS" != "Linux" ]; then destination="$PLIST_DST"; fi
  if [ ! -f "$destination" ]; then return 0; fi
  if ! registered_service_owned; then
    echo "ERROR: refusing to stop or replace an unowned $PLIST_NAME definition: $destination" >&2
    return 1
  fi
  if [ "$OS" = "Linux" ]; then
    systemctl --user stop "$PLIST_NAME" 2>/dev/null || true
  else
    launchctl unload "$PLIST_DST" 2>/dev/null || true
  fi
}

stop_owned_remainder() {
  pid="$(owned_pid || true)"
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    echo "LifeOS Pulse stopped (verified PID $pid)"
  fi
}

health_matches_runtime() {
  HEALTH_JSON="$1" \
  EXPECTED_RUNTIME_ROOT="$LIFEOS_DIR" \
  EXPECTED_CONFIG_PATH="$LIFEOS_CONFIG_PATH" \
  EXPECTED_SCRIPT_PATH="$PULSE_DIR/pulse.ts" \
  EXPECTED_EXECUTABLE_PATH="$BUN_PATH" \
  LOCK_FILE="$LOCK_FILE" \
  "$BUN_PATH" run "$IDENTITY_HELPER" health >/dev/null 2>&1
}

case "${1:-}" in
  start)
    if [ "$OS" = "Linux" ]; then
      if ! registered_service_owned; then
        echo "ERROR: Pulse service is missing or belongs to another runtime; run install from $PULSE_DIR" >&2
        exit 1
      fi
      systemctl --user start "$PLIST_NAME"
    else
      if [ ! -f "$PLIST_DST" ]; then
        mkdir -p "$(dirname -- "$PLIST_DST")"
        render_service "$PLIST_SRC" launchd "$PLIST_DST"
      elif ! registered_service_owned; then
        echo "ERROR: Pulse launch agent belongs to another runtime; run install from its owning root first" >&2
        exit 1
      fi
      launchctl load "$PLIST_DST" 2>/dev/null || launchctl kickstart "gui/$(id -u)/$PLIST_NAME"
    fi
    echo "LifeOS Pulse started"
    ;;

  stop)
    stop_registered_service
    sleep 1
    stop_owned_remainder
    echo "LifeOS Pulse stopped"
    ;;

  restart)
    bash "$PULSE_DIR/manage.sh" stop
    sleep 2
    bash "$PULSE_DIR/manage.sh" start
    ;;

  status)
    pid="$(owned_pid || true)"
    if [ -n "$pid" ]; then
      uptime="$(ps -p "$pid" -o etime= 2>/dev/null | xargs)"
      echo "LifeOS Pulse: RUNNING (verified PID $pid, uptime $uptime, root $LIFEOS_DIR)"
    elif [ -f "$LOCK_FILE" ]; then
      echo "LifeOS Pulse: UNVERIFIED (lock/process identity mismatch)"
    else
      echo "LifeOS Pulse: NOT RUNNING (no instance lock)"
    fi

    if [ -f "$STATE_FILE" ]; then
      echo ""
      echo "Last job runs:"
      STATE_FILE="$STATE_FILE" "$BUN_PATH" -e '
        import { readFileSync } from "node:fs";
        const state = JSON.parse(readFileSync(process.env.STATE_FILE!, "utf8"));
        for (const [name, raw] of Object.entries(state.jobs ?? {})) {
          const info: any = raw;
          const ago = Math.round((Date.now() - info.lastRun) / 60000);
          const status = info.consecutiveFailures > 0 ? ` [FAILING x${info.consecutiveFailures}]` : "";
          console.log(`  ${name}: ${ago} min ago (${info.lastResult})${status}`);
        }
      ' 2>/dev/null || true
    fi
    ;;

  install)
    mkdir -p "$PULSE_DIR/state" "$PULSE_DIR/logs"
    stop_registered_service
    sleep 1
    stop_owned_remainder

    if [ "$OS" = "Linux" ]; then
      mkdir -p "$SYSTEMD_SERVICE_DIR"
      render_service "$SERVICE_SRC" systemd "$SERVICE_DST"
      loginctl enable-linger "${USER:-$(id -un)}" 2>/dev/null || true
      systemctl --user daemon-reload
      systemctl --user enable "$PLIST_NAME"
      systemctl --user start "$PLIST_NAME"
    else
      mkdir -p "$(dirname -- "$PLIST_DST")"
      render_service "$PLIST_SRC" launchd "$PLIST_DST"
      launchctl load "$PLIST_DST"
    fi

    verified=""
    for _ in $(seq 1 20); do
      sleep 0.5
      health="$(curl --fail --silent --show-error --max-time 1 http://localhost:31337/healthz 2>/dev/null || true)"
      if [ -n "$health" ] && health_matches_runtime "$health"; then
        verified=1
        break
      fi
    done
    if [ -n "$verified" ]; then
      echo "LifeOS Pulse installed and verified on port 31337 (root: $LIFEOS_DIR, bun: $BUN_PATH)"
      exit 0
    fi

    echo "ERROR: LifeOS Pulse service did not become a verified, dashboard-serving instance within 10s." >&2
    echo "  Check: tail -50 $PULSE_DIR/logs/pulse-stderr.log" >&2
    exit 1
    ;;

  uninstall)
    stop_registered_service
    sleep 1
    stop_owned_remainder
    if [ "$OS" = "Linux" ]; then
      systemctl --user disable "$PLIST_NAME" 2>/dev/null || true
      rm -f "$SERVICE_DST"
      systemctl --user daemon-reload 2>/dev/null || true
    else
      rm -f "$PLIST_DST"
    fi
    echo "LifeOS Pulse uninstalled"
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|status|install|uninstall}"
    exit 1
    ;;
esac
