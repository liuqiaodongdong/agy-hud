import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hudScript = path.resolve(__dirname, "..", "agy-hud.mjs");
const isPreview = process.argv.includes("--preview");

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();

const base = {
  agent_state: "idle",
  session_id: "nonexistent-test-session",
  conversation_id: "nonexistent-test-session",
  transcript_path: "",
  terminal_width: 140,
  model: {
    id: "Gemini 4 Neon (XHigh)",
    display_name: "Gemini 4 Neon (XHigh)",
    effort: "xhigh",
  },
  tps: {
    text_tps: 108,
    e2e_tps: 84,
  },
  context_window: {
    context_window_size: 1_048_576,
    total_input_tokens: 128_000,
    used_percentage: 12.2,
    thinking_tokens: 0,
  },
  quota: {
    "3p-5h": {
      remaining_fraction: 1.0,
      reset_in_seconds: 17900,
    },
    "gemini-5h": {
      remaining_fraction: 0.92,
      reset_in_seconds: 15480,
    },
    "gemini-weekly": {
      remaining_fraction: 0.86,
      reset_in_seconds: 558000,
    },
  },
};

function runHud(patch = {}, env = {}) {
  const payload = JSON.stringify({
    ...base,
    ...patch,
    context_window: {
      ...base.context_window,
      ...(patch.context_window || {}),
    },
  });
  return execFileSync("node", [hudScript], {
    input: payload,
    env: { ...process.env, AGY_HUD_TEST: "1", ...env },
    encoding: "utf8",
  }).trimEnd();
}

const testCases = [
  {
    name: "Gemini 4 Neon — Coding + Peak TPS (512k limit)",
    patch: {},
    env: { AGY_HUD_MODE: "coding" },
    expect: ["写代码..", "108t/s|总84", "25% (128k/512k)", "5h", "92%", "7day", "86%"],
    forbid: ["3p"],
  },
  {
    name: "Gemini 4 Carbon — Thinking Mode (512k limit)",
    patch: {
      model: { id: "Gemini 4 Carbon (High)", display_name: "Gemini 4 Carbon (High)" },
      tps: { text_tps: 58, e2e_tps: 44 },
      context_window: { total_input_tokens: 256_000, used_percentage: 24.4 },
    },
    env: { AGY_HUD_MODE: "thinking" },
    expect: ["思考..", "58t/s|总44", "50% (256k/512k)"],
  },
  {
    name: "Gemini 4 Argon — Subagent Mode (512k limit)",
    patch: {
      model: { id: "Gemini 4 Argon (High)", display_name: "Gemini 4 Argon (High)" },
      context_window: { total_input_tokens: 51_200, used_percentage: 4.88 },
    },
    env: { AGY_HUD_MODE: "subagent" },
    expect: ["摇猫猫..", "10% (51.2k/512k)"],
  },
  {
    name: "Gemini 4 Hydrogen — Command Mode (512k limit)",
    patch: {
      model: { id: "Gemini 4 Hydrogen (High)", display_name: "Gemini 4 Hydrogen (High)" },
      context_window: { total_input_tokens: 102_400, used_percentage: 9.76 },
    },
    env: { AGY_HUD_MODE: "command" },
    expect: ["跑命令..", "20% (102k/512k)"],
  },
  {
    name: "Orchestrator (Neon) — Recognizes 512k even without 'gemini' in label",
    patch: {
      model: { id: "Orchestrator (Neon)", display_name: "Orchestrator (Neon)" },
      context_window: { total_input_tokens: 128_000, used_percentage: 12.2 },
    },
    expect: ["25% (128k/512k)"],
  },
  {
    name: "Gemini 3.8 Flash — Fallback 256k limit",
    patch: {
      model: { id: "Gemini 3.8 Flash (High)", display_name: "Gemini 3.8 Flash (High)" },
      context_window: { total_input_tokens: 128_000, used_percentage: 12.2 },
    },
    expect: ["50% (128k/256k)"],
  },
  {
    name: "Claude Opus 5.5 (1M raw) — Compaction fallback 840k",
    patch: {
      model: { id: "Claude Opus 5.5 (High)", display_name: "Claude Opus 5.5 (High)" },
      context_window: { total_input_tokens: 420_000, used_percentage: 40.0 },
    },
    expect: ["50% (420k/840k)"],
  },
  {
    name: "Claude Sonnet 5.5 (200k raw) — Clamped to physical 200k",
    patch: {
      model: { id: "Claude Sonnet 5.5 (Medium)", display_name: "Claude Sonnet 5.5 (Medium)" },
      context_window: { context_window_size: 200_000, total_input_tokens: 100_000, used_percentage: 50 },
    },
    expect: ["50% (100k/200k)"],
  },
  {
    name: "Warning State — 68% context triggers Sweat mascot",
    patch: {
      context_window: { total_input_tokens: 348_160, used_percentage: 33.2 },
    },
    expect: ["💦", "68% (348k/512k)"],
  },
  {
    name: "Critical State — 91% context triggers Hiss mascot + red TPS",
    patch: {
      tps: { text_tps: 27, e2e_tps: 21 },
      context_window: { total_input_tokens: 465_920, used_percentage: 44.4 },
    },
    expect: ["哈!", "27t/s|总21", "91% (466k/512k)"],
  },
  {
    name: "Narrow Terminal Adaptation — Drops '|总XX' compactly",
    patch: {
      terminal_width: 92,
      tps: { text_tps: 108, e2e_tps: 84 },
    },
    expect: ["108t/s", "25% (128k/512k)"],
    forbid: ["|总84"],
  },
];

let passed = 0;
for (const tc of testCases) {
  const colored = runHud(tc.patch, tc.env);
  const plain = stripAnsi(colored);

  for (const needle of tc.expect || []) {
    assert.ok(
      plain.includes(needle),
      `[${tc.name}] Expected output to contain ${JSON.stringify(needle)}, got:\n  ${plain}`
    );
  }
  for (const banned of tc.forbid || []) {
    assert.ok(
      !plain.includes(banned),
      `[${tc.name}] Expected output NOT to contain ${JSON.stringify(banned)}, got:\n  ${plain}`
    );
  }

  passed++;
  if (isPreview) {
    console.log(`\x1b[2m# ${tc.name}\x1b[0m\n  ${colored}\n`);
  } else {
    console.log(`PASS  ${tc.name}`);
  }
}

console.log(`\nAll ${passed}/${testCases.length} agy-hud tests passed!`);
