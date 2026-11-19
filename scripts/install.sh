#!/usr/bin/env bash
set -euo pipefail

REPO_RAW_URL="https://raw.githubusercontent.com/liuqiaodongdong/agy-hud/main/agy-hud.mjs"
AGY_DIR="${HOME}/.gemini/antigravity-cli"
TARGET_SCRIPT="${AGY_DIR}/agy-hud.mjs"
SETTINGS_FILE="${AGY_DIR}/settings.json"

UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --uninstall|-u)
      UNINSTALL=1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "[agy-hud] Error: Node.js is required (>=18; >=22.5 recommended for built-in node:sqlite live TPS & compaction limits)." >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  if [ -f "$SETTINGS_FILE" ]; then
    node -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      const raw = fs.readFileSync(file, "utf8").trim();
      if (!raw) process.exit(0);
      const cfg = JSON.parse(raw);
      if (cfg.statusLine && String(cfg.statusLine.command || "").includes("agy-hud.mjs")) {
        delete cfg.statusLine;
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
        console.log("[agy-hud] Removed statusLine entry from", file);
      }
    ' "$SETTINGS_FILE"
  fi
  if [ -f "$TARGET_SCRIPT" ]; then
    rm -f "$TARGET_SCRIPT"
    echo "[agy-hud] Removed $TARGET_SCRIPT"
  fi
  echo "[agy-hud] Uninstalled cleanly."
  exit 0
fi

mkdir -p "$AGY_DIR"

# Prefer local file if executed from a cloned repo; otherwise download from GitHub
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/../agy-hud.mjs" ]; then
  cp "${SCRIPT_DIR}/../agy-hud.mjs" "$TARGET_SCRIPT"
  echo "[agy-hud] Installed local agy-hud.mjs -> $TARGET_SCRIPT"
else
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$REPO_RAW_URL" -o "$TARGET_SCRIPT"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TARGET_SCRIPT" "$REPO_RAW_URL"
  else
    echo "[agy-hud] Error: curl or wget is required to download agy-hud.mjs." >&2
    exit 1
  fi
  echo "[agy-hud] Downloaded agy-hud.mjs -> $TARGET_SCRIPT"
fi

chmod +x "$TARGET_SCRIPT"

# Safely merge statusLine into ~/.gemini/antigravity-cli/settings.json
node -e '
  const fs = require("node:fs");
  const settingsFile = process.argv[1];
  const targetScript = process.argv[2];

  let cfg = {};
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, "utf8").replace(/^\uFEFF/, "").trim();
    if (raw) {
      try {
        cfg = JSON.parse(raw);
      } catch (err) {
        const bak = settingsFile + ".bak";
        fs.copyFileSync(settingsFile, bak);
        console.warn("[agy-hud] Existing settings.json was invalid JSON; backed up to", bak);
        cfg = {};
      }
    }
  }

  const cmdTarget = /\s/.test(targetScript) ? `"${targetScript}"` : targetScript;
  cfg.statusLine = {
    type: "command",
    command: `node ${cmdTarget}`,
    stack_with_default: true,
  };

  fs.writeFileSync(settingsFile, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log("[agy-hud] Updated", settingsFile);
' "$SETTINGS_FILE" "$TARGET_SCRIPT"

# Inform user about Node sqlite capability
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) {
    console.log(`[agy-hud] Node.js v${process.versions.node} detected — built-in node:sqlite enabled (live TPS + dynamic server compaction limit active!).`);
  } else {
    console.log(`[agy-hud] Node.js v${process.versions.node} detected — HUD will run in compatibility mode (upgrade to Node >=22.5 to unlock live SQLite TPS & dynamic compaction limits).`);
  }
'

echo "[agy-hud] Done! Start or continue an \`agy\` session to see your new HUD."
