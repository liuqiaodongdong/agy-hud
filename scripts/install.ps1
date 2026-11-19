param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$RepoRawUrl = "https://raw.githubusercontent.com/liuqiaodongdong/agy-hud/main/agy-hud.mjs"
$AgyDir = Join-Path $HOME ".gemini\antigravity-cli"
$TargetScript = Join-Path $AgyDir "agy-hud.mjs"
$TargetScriptPosix = $TargetScript -replace "\\", "/"
$SettingsFile = Join-Path $AgyDir "settings.json"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "[agy-hud] Node.js is required (>=18; >=22.5 recommended for built-in node:sqlite live TPS & dynamic compaction limits)."
  exit 1
}

if ($Uninstall) {
  if (Test-Path $SettingsFile) {
    $uninstallJs = @'
const fs = require("node:fs");
const file = process.argv[2];
const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
if (!raw) process.exit(0);
const cfg = JSON.parse(raw);
if (cfg.statusLine && String(cfg.statusLine.command || "").includes("agy-hud.mjs")) {
  delete cfg.statusLine;
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log("[agy-hud] Removed statusLine entry from", file);
}
'@
    $uninstallJs | node - $SettingsFile
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  if (Test-Path $TargetScript) {
    Remove-Item -Force $TargetScript
    Write-Host "[agy-hud] Removed $TargetScript"
  }
  Write-Host "[agy-hud] Uninstalled cleanly."
  exit 0
}

New-Item -ItemType Directory -Force -Path $AgyDir | Out-Null

# Prefer local file if executed from a cloned repository; otherwise download from GitHub
$LocalSource = $null
if ($PSScriptRoot) {
  $Candidate = Join-Path (Split-Path -Parent $PSScriptRoot) "agy-hud.mjs"
  if (Test-Path $Candidate) {
    $LocalSource = $Candidate
  }
}

if ($LocalSource) {
  Copy-Item -Force $LocalSource $TargetScript
  Write-Host "[agy-hud] Installed local agy-hud.mjs -> $TargetScript"
} else {
  Invoke-WebRequest -UseBasicParsing -Uri $RepoRawUrl -OutFile $TargetScript
  Write-Host "[agy-hud] Downloaded agy-hud.mjs -> $TargetScript"
}

$mergeJs = @'
const fs = require("node:fs");
const settingsFile = process.argv[2];
const targetScript = process.argv[3];

let cfg = {};
if (fs.existsSync(settingsFile)) {
  const raw = fs.readFileSync(settingsFile, "utf8").replace(/^\uFEFF/, "").trim();
  if (raw) {
    try {
      cfg = JSON.parse(raw);
    } catch {
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
'@

$mergeJs | node - $SettingsFile $TargetScriptPosix
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$verJs = @'
const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 5)) {
  console.log(`[agy-hud] Node.js v${process.versions.node} detected - built-in node:sqlite enabled (live TPS + dynamic server compaction limit active!).`);
} else {
  console.log(`[agy-hud] Node.js v${process.versions.node} detected - HUD will run in compatibility mode (upgrade to Node >=22.5 to unlock live SQLite TPS & dynamic compaction limits).`);
}
'@
$verJs | node -
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[agy-hud] Done! Start or continue an 'agy' session to see your new HUD."
