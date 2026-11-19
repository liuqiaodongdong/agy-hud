#!/usr/bin/env node
/**
 * agy-hud.mjs — Antigravity CLI (agy) 赛博风 + 哈基米星芒猫娘动态颜文字 HUD
 * 作用：在会话底部实时显示：
 *   1. 哈基米（Gemini 星芒猫娘）动态颜文字：随思考、查文件、写代码、跑命令、冲浪、等确认、满血/微汗/炸毛哈气实时变脸
 *   2. tps（基于当前会话 SQLite 纳秒级遥测，实时展示本轮纯吐字 TPS 与综合 TPS）
 *   3. context（内嵌百分比加长进度条 + 已用/总 Token 数）
 *   4. Gemini 配额限制（5h、7day、内嵌余量百分比加长进度条 + 重置倒计时）
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 赛博朋克风 TrueColor (24-bit ANSI) 调色盘
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  // 哈基米（Gemini 星芒猫娘）专属蓝紫粉渐变色
  gemStar: "\x1b[1;38;2;78;149;255m",     // #4E95FF Gemini 四角星芒蓝
  gemCat: "\x1b[1;38;2;224;130;255m",     // #E082FF 星芒猫娘幻彩紫粉
  // 标签霓虹色
  neonBolt: "\x1b[1;38;2;255;215;0m",     // #FFD700 电光亮金（tps 标签）
  neonCyan: "\x1b[1;38;2;0;240;255m",     // #00F0FF 赛博青（context 标签）
  neonPink: "\x1b[1;38;2;255;42;133m",    // #FF2A85 霓虹粉（5h 标签）
  neonPurple: "\x1b[1;38;2;191;64;255m",  // #BF40FF 电光紫（7day 标签）
  // 状态与数值色
  neonMint: "\x1b[38;2;0;255;159m",       // #00FF9F 荧光薄荷绿（健康状态）
  cyberYellow: "\x1b[38;2;255;230;0m",    // #FFE600 赛博黄（中度预警）
  laserRed: "\x1b[1;38;2;255;0;85m",      // #FF0055 激光红（高危/哈气预警）
  barText: "\x1b[1;38;2;240;248;255m",    // #F0F8FF 极光亮白（进度条内嵌百分比）
  // 辅助信息色
  iceBlue: "\x1b[38;2;130;170;255m",      // #82AAFF 冰川蓝（Token 明细）
  cyberAmber: "\x1b[38;2;255;176;0m",     // #FFB000 琥珀流光金（重置倒计时）
  trackDark: "\x1b[38;2;58;68;102m",      // #3A4466 暗夜靛蓝（进度条底槽）
  sepViolet: "\x1b[38;2;110;86;207m",     // #6E56CF 霓虹暗紫（分隔符）
};

// 工具分类映射表
const READ_TOOLS = new Set([
  "read_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
  "find_by_name",
  "grep_search",
]);
const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
]);
const CMD_TOOLS = new Set([
  "run_command",
  "send_command_input",
  "manage_task",
]);
const WEB_TOOLS = new Set([
  "search_web",
  "read_url_content",
]);
const SUBAGENT_TOOLS = new Set([
  "invoke_subagent",
  "define_subagent",
  "send_message",
  "manage_subagents",
]);

/**
 * 格式化 Token 数量（例如 188054 -> "188k", 1048576 -> "1.0M"）
 */
function formatTokens(n) {
  if (typeof n !== "number" || Number.isNaN(n) || n < 0) return "0";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return String(Math.round(n));
}

/**
 * 格式化剩余重置时间（秒 -> "4h40m" 或 "6d17h" 或 "35m"）
 */
function formatDurationSeconds(sec) {
  if (typeof sec !== "number" || Number.isNaN(sec) || sec <= 0) return "";
  const totalMinutes = Math.ceil(sec / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;

  if (days > 0) {
    return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  }
  return `${mins}m`;
}

/**
 * 从桶对象中解析剩余秒数
 */
function getResetSeconds(bucket) {
  if (!bucket || typeof bucket !== "object") return null;
  if (typeof bucket.reset_in_seconds === "number" && bucket.reset_in_seconds > 0) {
    return bucket.reset_in_seconds;
  }
  const rawTime = bucket.reset_time ?? bucket.resets_at ?? bucket.resetTime;
  if (typeof rawTime === "number" && rawTime > 0) {
    const targetMs = rawTime > 1e12 ? rawTime : rawTime * 1000;
    const diffSec = Math.round((targetMs - Date.now()) / 1000);
    return diffSec > 0 ? diffSec : null;
  }
  if (typeof rawTime === "string" && rawTime.trim()) {
    const targetMs = Date.parse(rawTime);
    if (!Number.isNaN(targetMs)) {
      const diffSec = Math.round((targetMs - Date.now()) / 1000);
      return diffSec > 0 ? diffSec : null;
    }
  }
  return null;
}

/**
 * 生成加长连续赛博风进度条
 */
function renderBar(pct, width = 8, color = C.neonMint) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `${color}${"█".repeat(filled)}${C.trackDark}${"░".repeat(empty)}${C.reset}`;
}

function getUsedColor(usedPercent) {
  if (usedPercent >= 85) return C.laserRed;
  if (usedPercent >= 60) return C.cyberYellow;
  return C.neonMint;
}

function getRemainingColor(remainPercent) {
  if (remainPercent <= 15) return C.laserRed;
  if (remainPercent <= 35) return C.cyberYellow;
  return C.neonMint;
}

function getTpsColor(tps) {
  if (tps >= 65) return C.neonMint;
  if (tps >= 35) return C.cyberYellow;
  return C.laserRed;
}

/**
 * 估算去除 ANSI 转义码后的终端显示列宽（兼容 CJK 双宽字符与 Emoji）
 */
function getVisualWidth(str) {
  const plain = String(str || "").replace(/\x1b\[[0-9;]*m/g, "");
  let width = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (!cp || cp < 0x20) continue;
    if (
      cp === 0x26a1 || // ⚡
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 轻量级零依赖 Protobuf 解码工具（用于解析 conversations/<id>.db 中的纳秒级生成遥测）
 */
function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: Number(result), offset: pos };
    }
    shift += 7n;
    if (shift > 70n) break;
  }
  return null;
}

function parseProtoFields(buf, start = 0, end = buf.length) {
  const fields = [];
  let pos = start;
  while (pos < end) {
    const tagRes = readVarint(buf, pos);
    if (!tagRes) break;
    pos = tagRes.offset;
    const fieldNo = tagRes.value >>> 3;
    const wireType = tagRes.value & 0x7;
    if (fieldNo === 0) break;

    if (wireType === 0) {
      const valRes = readVarint(buf, pos);
      if (!valRes) break;
      pos = valRes.offset;
      fields.push({ fieldNo, wireType, value: valRes.value });
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      fields.push({ fieldNo, wireType, value: buf.subarray(pos, pos + 8) });
      pos += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(buf, pos);
      if (!lenRes) break;
      pos = lenRes.offset;
      if (pos + lenRes.value > end) break;
      fields.push({ fieldNo, wireType, value: buf.subarray(pos, pos + lenRes.value) });
      pos += lenRes.value;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      fields.push({ fieldNo, wireType, value: buf.subarray(pos, pos + 4) });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function parseDurationSec(buf) {
  if (!Buffer.isBuffer(buf)) return 0;
  let sec = 0;
  let nanos = 0;
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNo === 1 && f.wireType === 0) sec = f.value;
    if (f.fieldNo === 2 && f.wireType === 0) nanos = f.value;
  }
  return sec + nanos / 1e9;
}

function parseGenMetadataBlob(buf) {
  const out = {
    stepIndices: [],
    outputTokens: 0,
    thinkingTokens: 0,
    responseTokens: 0,
    ttftSec: 0,
    streamSec: 0,
    modelSlug: "",
    modelLabel: "",
  };
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNo === 2) {
      if (f.wireType === 0) {
        out.stepIndices.push(f.value);
      } else if (f.wireType === 2) {
        let p = 0;
        while (p < f.value.length) {
          const r = readVarint(f.value, p);
          if (!r) break;
          out.stepIndices.push(r.value);
          p = r.offset;
        }
      }
    } else if (f.fieldNo === 1 && f.wireType === 2) {
      for (const cf of parseProtoFields(f.value)) {
        if (cf.fieldNo === 4 && cf.wireType === 2) {
          for (const uf of parseProtoFields(cf.value)) {
            if (uf.fieldNo === 3 && uf.wireType === 0) out.outputTokens = uf.value;
            if (uf.fieldNo === 9 && uf.wireType === 0) out.thinkingTokens = uf.value;
            if (uf.fieldNo === 10 && uf.wireType === 0) out.responseTokens = uf.value;
          }
        } else if (cf.fieldNo === 11 && cf.wireType === 2) {
          out.ttftSec = parseDurationSec(cf.value);
        } else if (cf.fieldNo === 12 && cf.wireType === 2) {
          out.streamSec = parseDurationSec(cf.value);
        } else if (cf.fieldNo === 19 && cf.wireType === 2) {
          out.modelSlug = cf.value.toString("utf8");
        } else if (cf.fieldNo === 21 && cf.wireType === 2) {
          out.modelLabel = cf.value.toString("utf8");
        }
      }
    }
  }
  return out;
}

function parsePlannerStepBlob(buf) {
  let thinkingSec = 0;
  let toolCalls = 0;
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNo === 20 && f.wireType === 2) {
      for (const pf of parseProtoFields(f.value)) {
        if (pf.fieldNo === 7 && pf.wireType === 2) toolCalls++;
        if (pf.fieldNo === 11 && pf.wireType === 2) thinkingSec = parseDurationSec(pf.value);
      }
    }
  }
  return { thinkingSec, toolCalls };
}

/**
 * 解析 executor_metadata.data 中的模型标识与服务端自动压缩阈值
 * 路径：f10(cascade_config) -> f1(planner_config).f28(model_name)
 *                            -> f2(checkpoint_config).f5(max_token_limit)
 */
function parseExecutorMetadataBlob(buf) {
  let modelName = "";
  let maxTokenLimit = 0;
  for (const f of parseProtoFields(buf)) {
    if (f.fieldNo === 10 && f.wireType === 2) {
      for (const cf of parseProtoFields(f.value)) {
        if (cf.fieldNo === 1 && cf.wireType === 2) {
          for (const pf of parseProtoFields(cf.value)) {
            if (pf.fieldNo === 28 && pf.wireType === 2) {
              modelName = pf.value.toString("utf8");
            }
          }
        } else if (cf.fieldNo === 2 && cf.wireType === 2) {
          for (const ck of parseProtoFields(cf.value)) {
            if (ck.fieldNo === 5 && ck.wireType === 0) {
              maxTokenLimit = ck.value;
            }
          }
        }
      }
    }
  }
  return { modelName, maxTokenLimit };
}

/**
 * 读取当前活跃会话的精确遥测数据（仅打开当前会话 .db 一次：实时压缩阈值 + 精确 TPS）
 */
function readCurrentSessionTelemetry(DatabaseSync, data) {
  const result = { tps: null, execMeta: null };
  if (!DatabaseSync) return result;
  const convId = data?.conversation_id || data?.session_id;
  if (!convId || convId === "none") return result;

  const dbPath = path.join(
    os.homedir(),
    ".gemini",
    "antigravity-cli",
    "conversations",
    `${convId}.db`
  );
  if (!fs.existsSync(dbPath)) return result;

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    // 1. 读取最新一轮 executor_metadata 中服务端下发的实际自动压缩上限（max_token_limit）
    try {
      const execRow = db
        .prepare("SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT 1")
        .get();
      if (execRow?.data) {
        const parsed = parseExecutorMetadataBlob(Buffer.from(execRow.data));
        if (parsed.maxTokenLimit > 0) {
          result.execMeta = parsed;
        }
      }
    } catch {
      // 无 executor_metadata 表或读取失败时静默回退到模型静态阈值
    }

    // 2. 读取当前活跃会话的精确 TPS 数据
    try {
      const rows = db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx DESC LIMIT 10").all();
      if (rows && rows.length > 0) {
        const stepStmt = db.prepare("SELECT step_payload FROM steps WHERE idx = ?");
        for (const row of rows) {
          if (!row?.data) continue;
          const m = parseGenMetadataBlob(Buffer.from(row.data));
          const totalSec = m.ttftSec + m.streamSec;
          if (m.outputTokens <= 0 || totalSec < 0.05) continue;

          const e2eTps = m.outputTokens / totalSec;
          let textTps = 0;
          let isText = false;

          const stepIdx = m.stepIndices[0];
          if (stepIdx !== undefined) {
            const s = stepStmt.get(stepIdx);
            if (s?.step_payload) {
              const p = parsePlannerStepBlob(Buffer.from(s.step_payload));
              const decodeSec = p.thinkingSec > 0 ? totalSec - p.thinkingSec : m.streamSec;
              if (p.toolCalls === 0 && m.responseTokens >= 15 && decodeSec >= 0.12) {
                textTps = m.responseTokens / decodeSec;
                isText = true;
              }
            }
          }

          result.tps = { e2eTps, textTps, isText };
          break;
        }
      }
    } catch {
      // ignore TPS errors
    }

    return result;
  } catch {
    return result;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * 构建当前会话 TPS 吐字测速段落（提供 full / compact 宽度自适应）
 */
function buildTpsSegment(data, sessionTps) {
  // 支持测试脚本直接注入 mock tps 数据
  if (data?.tps && typeof data.tps === "object") {
    const txt = Math.round(data.tps.text_tps || data.tps.tps || 0);
    const e2e = Math.round(data.tps.e2e_tps || 0);
    if (txt > 0) {
      const col = getTpsColor(txt);
      const eStr = e2e > 0 ? `${C.sepViolet}|${C.reset}${C.iceBlue}总${e2e}${C.reset}` : "";
      return {
        full: `${C.neonBolt}tps${C.reset} ${col}${txt}t/s${C.reset}${eStr}`,
        compact: `${C.neonBolt}tps${C.reset} ${col}${txt}t/s${C.reset}`,
      };
    }
  }

  // 情况 1：最新一步为纯正文回复，展示本轮纯吐字 TPS + 含思考总 TPS
  if (sessionTps && sessionTps.isText && sessionTps.textTps > 0) {
    const txt = Math.round(sessionTps.textTps);
    const e2e = Math.round(sessionTps.e2eTps);
    const col = getTpsColor(txt);
    return {
      full: `${C.neonBolt}tps${C.reset} ${col}${txt}t/s${C.reset}${C.sepViolet}|${C.reset}${C.iceBlue}总${e2e}${C.reset}`,
      compact: `${C.neonBolt}tps${C.reset} ${col}${txt}t/s${C.reset}`,
    };
  }

  // 情况 2：正在执行工具链中间步，展示当前步综合 TPS（⚡）
  if (sessionTps && sessionTps.e2eTps > 0) {
    const e2e = Math.round(sessionTps.e2eTps);
    const col = getTpsColor(e2e);
    const boltSeg = `${C.neonBolt}tps${C.reset} ${C.cyberAmber}⚡${C.reset}${col}${e2e}t/s${C.reset}`;
    return { full: boltSeg, compact: boltSeg };
  }

  if (process.env.AGY_HUD_TEST) return null;

  const placeholder = `${C.neonBolt}tps${C.reset} ${C.trackDark}--${C.reset}`;
  return { full: placeholder, compact: placeholder };
}

/**
 * 快速读取当前会话 transcript.jsonl 尾部最后几步，识别实时工具动作
 */
function inspectRecentTranscript(data) {
  const candidates = [];
  const convId = data?.conversation_id || data?.session_id;
  if (convId) {
    candidates.push(
      path.join(
        os.homedir(),
        ".gemini",
        "antigravity-cli",
        "brain",
        convId,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      )
    );
  }
  if (typeof data?.transcript_path === "string" && data.transcript_path) {
    candidates.push(
      data.transcript_path.replace(/([\\/])antigravity([\\/])/, "$1antigravity-cli$2")
    );
    candidates.push(data.transcript_path);
  }

  let filePath = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        filePath = p;
        break;
      }
    } catch {
      // 忽略路径检查错误
    }
  }
  if (!filePath) return null;

  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) return null;
    // 只读文件尾部最多 32KB，保证 < 1ms 极速返回
    const readSize = Math.min(stat.size, 32 * 1024);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const lines = buf
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const steps = [];
    for (let i = lines.length - 1; i >= 0 && steps.length < 6; i--) {
      try {
        steps.push(JSON.parse(lines[i]));
      } catch {
        // 如果第一行因为截断不完整则跳过
      }
    }
    if (steps.length === 0) return null;

    const latest = steps[0];
    const latestPlanner = steps.find((s) => s.type === "PLANNER_RESPONSE");
    const toolNames = (latestPlanner?.tool_calls || [])
      .map((tc) => tc?.name || tc?.tool_name || "")
      .filter(Boolean);

    const recentlyEdited = steps.some((s) =>
      (s?.tool_calls || []).some((tc) => WRITE_TOOLS.has(tc?.name || tc?.tool_name || ""))
    );

    const isFresh = Date.now() - stat.mtimeMs < 60_000;

    return {
      isFresh,
      latestType: latest.type,
      latestStatus: latest.status,
      latestToolNames: (latest.tool_calls || [])
        .map((tc) => tc?.name || tc?.tool_name || "")
        .filter(Boolean),
      recentToolNames: toolNames,
      recentlyEdited,
    };
  } catch {
    return null;
  }
}

/**
 * 根据工具名列表归类动作
 */
function classifyToolAction(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  if (tools.includes("ask_question")) return "waiting";
  if (tools.some((t) => WRITE_TOOLS.has(t))) return "coding";
  if (tools.some((t) => CMD_TOOLS.has(t))) return "command";
  if (tools.some((t) => WEB_TOOLS.has(t))) return "web";
  if (tools.some((t) => SUBAGENT_TOOLS.has(t))) return "subagent";
  if (tools.some((t) => READ_TOOLS.has(t))) return "reading";
  return "thinking";
}

/**
 * 渲染哈基米（Gemini 星芒猫娘）动态颜文字段落
 */
function buildHajimiMascot(data, usedPct, minRemainPct) {
  const agentState = String(data?.agent_state || "idle").toLowerCase();
  const isBusy = agentState !== "idle" && agentState !== "";
  const tx = inspectRecentTranscript(data);

  const forcedMode = process.env.AGY_HUD_MODE || "";

  let mode = forcedMode;
  if (!mode) {
    const activeTurn = isBusy || Boolean(tx?.isFresh);

    if (agentState.includes("wait") || agentState.includes("confirm") || agentState.includes("ask")) {
      mode = "waiting";
    } else if (tx?.latestType === "PLANNER_RESPONSE" && tx.latestToolNames.length > 0 && activeTurn) {
      mode = classifyToolAction(tx.latestToolNames);
    } else if (
      isBusy ||
      ((tx?.latestType === "USER_INPUT" || tx?.latestType === "GENERIC") && tx?.isFresh)
    ) {
      mode = "thinking";
    } else if (usedPct >= 85 || minRemainPct <= 15) {
      mode = "hiss";
    } else if (usedPct >= 60 || minRemainPct <= 35) {
      mode = "sweat";
    } else if (tx?.recentlyEdited) {
      mode = "proud";
    } else {
      mode = "idle";
    }
  }

  const star = `${C.gemStar}✦${C.reset}`;
  switch (mode) {
    case "thinking":
      return `${star}${C.gemCat}₍^•-•^₎${C.reset}${C.neonCyan}💭思考..${C.reset}`;
    case "reading":
      return `${star}${C.gemCat}ฅ(•̀ω•́🔎)${C.reset}${C.neonCyan}翻文件..${C.reset}`;
    case "coding":
      return `${star}${C.gemCat}ฅ(^•̀ﻌ•́^)${C.reset}${C.neonMint}✎写代码..${C.reset}`;
    case "command":
      return `${star}${C.gemCat}ฅ(^•ω•^)${C.reset}${C.cyberAmber}⚡跑命令..${C.reset}`;
    case "web":
      return `${star}${C.gemCat}ฅ(^⊙ω⊙^)${C.reset}${C.iceBlue}🌐冲浪..${C.reset}`;
    case "subagent":
      return `${star}${C.gemCat}ฅ(^•ω•^)${C.reset}${C.neonPurple}🐾摇猫猫..${C.reset}`;
    case "waiting":
      return `${star}${C.gemCat}ฅ(^•ω•^?)${C.reset}${C.cyberYellow}等你喵${C.reset}`;
    case "hiss":
      return `${star}${C.laserRed}ฅ(╬\`д´)哈!${C.reset}`;
    case "sweat":
      return `${star}${C.cyberYellow}₍^•ﻌ•^💦₎${C.reset}`;
    case "proud":
      return `${star}${C.gemCat}ฅ(^•̀ω•́^)${C.gemStar}✧${C.reset}`;
    case "idle":
    default:
      return `${star}${C.gemCat}ฅ(^•ω•^ฅ)${C.reset}`;
  }
}

// 各模型系列的服务端自动压缩软阈值静态回退值（仅在首轮尚无 executor_metadata 或刚切换模型时兜底）
const MODEL_COMPACT_FALLBACKS = {
  "gemini-4": 512_000,
  "orchestrator": 512_000,
  "gemini-3.8-flash": 256_000,
  "claude": 840_000,
};

/**
 * 将模型 slug 或显示名称归类为统一系列，用于校验实时 executor_metadata 与当前模型是否一致
 */
function normalizeModelFamily(name) {
  const s = String(name || "").toLowerCase().trim();
  if (!s) return "";
  if (s.includes("orchestrator")) {
    if (s.includes("neon")) return "orchestrator-neon";
    if (s.includes("argon")) return "orchestrator-argon";
    return "orchestrator-carbon";
  }
  if (s.includes("neon")) return "gemini-4-neon";
  if (s.includes("carbon")) return "gemini-4-carbon";
  if (s.includes("argon")) return "gemini-4-argon";
  if (s.includes("hydrogen")) return "gemini-4-hydrogen";
  if (s.includes("3.8") && s.includes("flash")) return "gemini-3.8-flash";
  if (s.includes("claude")) {
    if (s.includes("opus")) return "claude-opus";
    if (s.includes("sonnet")) return "claude-sonnet";
    return "claude";
  }
  if (s.includes("gpt-oss") || s.includes("gpt")) return "gpt-oss";
  if (s.includes("gemini-4") || s.includes("gemini 4")) return "gemini-4";
  if (s.includes("gemini")) return "gemini";
  return s;
}

/**
 * 解析当前会话的有效上下文上限：
 * 1. 优先读取当前会话 SQLite executor_metadata 中的实时服务端 CheckpointConfig.max_token_limit
 * 2. 首轮无记录或刚切换模型时，按最新模型默认压缩阈值回退（Gemini 4 / Orchestrator 为 512k）
 */
function resolveContextLimit(data, cw, execMeta = null) {
  const rawMax = cw?.context_window_size || 0;
  const modelName = String(
    data?.model?.id || data?.model?.display_name || data?.model || ""
  );
  const activeFamily = normalizeModelFamily(modelName);

  // 1. 优先采用当前会话 SQLite 里的实时服务端压缩上限
  if (execMeta && execMeta.maxTokenLimit > 0) {
    const execFamily = normalizeModelFamily(execMeta.modelName);
    const familyMatches = !activeFamily || !execFamily || activeFamily === execFamily;
    if (familyMatches) {
      return rawMax > 0 ? Math.min(execMeta.maxTokenLimit, rawMax) : execMeta.maxTokenLimit;
    }
  }

  // 2. 静态回退（首轮 / 刚切模型 / 测试场景）
  let fallback = 0;
  if (!activeFamily || activeFamily.startsWith("gemini-4") || activeFamily === "gemini") {
    fallback = MODEL_COMPACT_FALLBACKS["gemini-4"];
  } else if (activeFamily.startsWith("orchestrator")) {
    fallback = MODEL_COMPACT_FALLBACKS["orchestrator"];
  } else if (activeFamily === "gemini-3.8-flash") {
    fallback = MODEL_COMPACT_FALLBACKS["gemini-3.8-flash"];
  } else if (activeFamily.startsWith("claude")) {
    fallback = MODEL_COMPACT_FALLBACKS["claude"];
  }

  if (fallback > 0 && rawMax > fallback) {
    return fallback;
  }
  return rawMax;
}

/**
 * 解析并渲染 context 窗口
 */
function buildContextSegment(data, execMeta = null) {
  const cw = data?.context_window;
  if (!cw || typeof cw !== "object") {
    return { text: `${C.neonCyan}context${C.reset} ${C.trackDark}--${C.reset}`, usedPct: 0 };
  }

  const rawMaxTokens = cw.context_window_size || 0;
  const maxTokens = resolveContextLimit(data, cw, execMeta);
  const curUsage = cw.current_usage || {};
  const currentTokens =
    cw.total_input_tokens ||
    curUsage.total_tokens ||
    (curUsage.input_tokens || 0) +
      (curUsage.cache_creation_input_tokens || 0) +
      (curUsage.cache_read_input_tokens || 0) ||
    0;

  let usedPct =
    maxTokens > 0 && maxTokens !== rawMaxTokens
      ? (currentTokens / maxTokens) * 100
      : typeof cw.used_percentage === "number"
        ? cw.used_percentage
        : maxTokens > 0
          ? (currentTokens / maxTokens) * 100
          : 0;
  usedPct = Math.max(0, Math.min(100, usedPct));

  const color = getUsedColor(usedPct);
  const bar = renderBar(usedPct, 8, color);
  const pctStr = `${color}${Math.round(usedPct)}%${C.reset}`;

  let tokenStr = "";
  if (maxTokens > 0) {
    tokenStr = ` ${C.iceBlue}(${formatTokens(currentTokens)}/${formatTokens(maxTokens)})${C.reset}`;
  } else if (currentTokens > 0) {
    tokenStr = ` ${C.iceBlue}(${formatTokens(currentTokens)})${C.reset}`;
  }

  const thinking = cw.thinking_tokens || curUsage.thinking_tokens || 0;
  const thinkStr = thinking > 0 ? ` ${C.neonPurple}思:${formatTokens(thinking)}${C.reset}` : "";

  return {
    text: `${C.neonCyan}context${C.reset} ${bar} ${pctStr}${tokenStr}${thinkStr}`,
    usedPct,
  };
}

/**
 * 格式化单个配额桶显示文本（加长连续进度条 + 外部百分比）
 */
function formatQuotaBucket(label, labelColor, remainPct, resetSec) {
  const clampedRemain = Math.max(0, Math.min(100, remainPct));
  const color = getRemainingColor(clampedRemain);
  const bar = renderBar(clampedRemain, 8, color);
  const pctStr = `${color}${Math.round(clampedRemain)}%${C.reset}`;
  const resetStr = resetSec ? ` ${C.cyberAmber}${formatDurationSeconds(resetSec)}${C.reset}` : "";
  return `${labelColor}${label}${C.reset} ${bar} ${pctStr}${resetStr}`;
}

/**
 * 渲染 Gemini 配额限制（5h 与 7day）
 */
function buildQuotaSegment(data) {
  const items = [];
  const q = data?.quota;

  if (q && typeof q === "object") {
    const entries = Array.isArray(q)
      ? q.map((b, idx) => [b?.bucket_id || b?.display_name || String(idx), b])
      : Object.entries(q);

    for (const [key, bucket] of entries) {
      if (!bucket || typeof bucket !== "object" || bucket.disabled) continue;

      const rawId = String(bucket?.bucket_id || key || "").toLowerCase();
      const rawName = String(bucket?.display_name || "").toLowerCase();

      // 只保留 Gemini 配额桶
      const isThirdParty =
        rawId.startsWith("3p") ||
        rawId.includes("claude") ||
        rawName.includes("claude") ||
        rawName.includes("3p");
      const isGemini = rawId.includes("gemini") || rawName.includes("gemini");

      if (isThirdParty || !isGemini) continue;

      let remainPct = null;
      if (typeof bucket.remaining_fraction === "number") {
        remainPct = bucket.remaining_fraction * 100;
      } else if (typeof bucket.remainingFraction === "number") {
        remainPct = bucket.remainingFraction * 100;
      } else if (typeof bucket.remaining_percentage === "number") {
        remainPct = bucket.remaining_percentage;
      } else if (typeof bucket.used_percentage === "number") {
        remainPct = 100 - bucket.used_percentage;
      }

      if (remainPct === null) continue;
      const resetSec = getResetSeconds(bucket);

      const is5h = rawId.includes("5h") || rawName.includes("5h") || (resetSec !== null && resetSec <= 6 * 3600);
      const isWeekly = rawId.includes("week") || rawId.includes("7d") || rawName.includes("week");

      const label = is5h ? "5h" : isWeekly ? "7day" : "Gemini";
      const labelColor = is5h ? C.neonPink : C.neonPurple;
      const order = is5h ? 1 : isWeekly ? 2 : 3;

      items.push({ label, labelColor, remainPct, resetSec, order });
    }
  }

  if (items.length === 0) {
    return {
      text: `${C.neonPink}5h${C.reset} ${C.trackDark}等待同步${C.reset}`,
      minRemainPct: 100,
    };
  }

  items.sort((a, b) => a.order - b.order);
  const minRemainPct = Math.min(...items.map((it) => it.remainPct));
  const sep = ` ${C.sepViolet}╱${C.reset} `;
  const text = items
    .map((it) => formatQuotaBucket(it.label, it.labelColor, it.remainPct, it.resetSec))
    .join(sep);

  return { text, minRemainPct };
}

/**
 * 异步读取 stdin 流（兼容 Windows 管道）
 */
async function readStdin() {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => {
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }, 300);

    process.stdin.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function main() {
  const raw = await readStdin();

  let data = {};
  const cacheDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "cache");
  const cacheFile = path.join(cacheDir, "last_statusline_payload.json");

  if (raw && raw.trim()) {
    try {
      const cleanRaw = raw.replace(/^\uFEFF/, "").trim();
      data = JSON.parse(cleanRaw);
      if (!process.env.AGY_HUD_TEST) {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2), "utf8");
      }
    } catch {
      // 忽略 JSON 解析错误
    }
  }

  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    // 兼容无内置 node:sqlite 的旧版 Node.js
  }

  const { tps: sessionTps, execMeta } = readCurrentSessionTelemetry(DatabaseSync, data);
  const tpsVariants = buildTpsSegment(data, sessionTps);

  const { text: ctxSeg, usedPct } = buildContextSegment(data, execMeta);
  const { text: quotaSeg, minRemainPct } = buildQuotaSegment(data);
  const mascotSeg = buildHajimiMascot(data, usedPct, minRemainPct);

  const sep = ` ${C.sepViolet}╱${C.reset} `;
  const termWidth = Number(data?.terminal_width) > 0 ? Number(data.terminal_width) : 120;

  let line = "";
  if (tpsVariants) {
    const fullLine = [mascotSeg, tpsVariants.full, ctxSeg, quotaSeg].filter(Boolean).join(sep);
    if (getVisualWidth(fullLine) <= termWidth - 1) {
      line = fullLine;
    } else {
      line = [mascotSeg, tpsVariants.compact, ctxSeg, quotaSeg].filter(Boolean).join(sep);
    }
  } else {
    line = [mascotSeg, ctxSeg, quotaSeg].filter(Boolean).join(sep);
  }

  process.stdout.write(line + "\n");
}

main();
