// dsh-whats-up — What's up · 会话动态面板 for DeepSeek Harness
// ---------------------------------------------------------------
// Host 半:扫描 <DSH_HOME>/sessions 下每个会话的 jsonl.zstd 事件流,用纯规则
// (不调 LLM)判断每个会话的现状:
//   active      15 分钟内仍有事件(正在做,不是遗忘)
//   blank       从未有过真实用户消息(空白会话)
//   half        做到一半:最后一次 todo/write 仍有 pending/in_progress,
//               或最后一个 turn 被中断(reason != completed)/ 有 start 无 end
//   unanswered  问了没回:最后一条真实用户消息晚于最后一条 assistant 回复
//   board       pr-board 等工具自动派生的会话(首条消息为
//               "This session is for working on ...")
//   done        大概率完成(最后一条是完整回复)
// 增量策略:每次请求只 stat 文件指纹(mtime+size);指纹不变 → 完全不重算;
// 变了的文件才重新解压分析,结果缓存在内存里。
// Client 半:client/client.js — 侧栏小组件 + 全屏面板 + 点卡片跳回会话。

import { readdir, stat, readFile } from "node:fs/promises";
import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

export const name = "whats-up";
export const inject = ["webServer"];

// ---------------------------------------------------------------- config

function sessionsRoot() {
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, "sessions");
  return join(homedir(), ".dsh", "sessions");
}

const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
const BOARD_PREFIX = "This session is for working on";
const TEXT_CAP = 280; // per-excerpt character cap sent to the browser
const TODO_CAP = 5; // open-todo items kept per session
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_MIN_TURNS = 3;
const RECENT_MIN_TOOLS = 10;

const STATUS_ORDER = { active: 0, half: 1, unanswered: 2, board: 3, done: 4, blank: 5 };

// ---------------------------------------------------------------- LLM summaries
// 规则管分类,LLM 管讲述:每个"值得看"的会话生成一行现状摘要,每个 tab 生
// 成一句总述。跑在 host 进程里,用和 GUI 主模型同一套 provider 凭据
// (zai-coding-cn / glm)。摘要按文件指纹缓存到 ~/.dsh,重启不重算;LLM
// 不可用时优雅降级为规则拼出的兜底文案。DSH_SA_NO_LLM=1 可完全关闭。

const LLM_DISABLED = process.env.DSH_SA_NO_LLM === "1";
const SUMMARY_TARGETS = new Set(["half", "unanswered", "active"]);
const SUMMARY_HARD_CAP = 40; // 单轮最多摘要的会话数(最新优先)
const LLM_CONCURRENCY = 2;
const DIGEST_TABS = ["recent", "half", "unanswered", "active"];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

// sid -> { v:3, fp, goal, state, achieved, at }(v3:+achieved;v1/v2 条目弃用重生成)
const summaryCache = new Map();
const SUMMARY_FILE = join(dshHome(), "whats-up.summaries.json");
let summarySaveTimer = null;

async function loadSummaryCache() {
  try {
    const raw = JSON.parse(await readFile(SUMMARY_FILE, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [sid, v] of Object.entries(raw)) {
        if (v && v.v === 3 && typeof v.fp === "string" && typeof v.goal === "string" && typeof v.state === "string") {
          summaryCache.set(sid, v);
        }
      }
    }
  } catch (e) {
    /* 首次运行没有缓存文件 */
  }
}

function scheduleSummarySave() {
  if (summarySaveTimer) return;
  summarySaveTimer = setTimeout(async () => {
    summarySaveTimer = null;
    const out = {};
    for (const [sid, v] of summaryCache.entries()) out[sid] = v;
    try {
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(SUMMARY_FILE, JSON.stringify(out), "utf8");
    } catch (e) {
      /* 磁盘写失败不影响内存工作 */
    }
  }, 3000);
}

// 摘要缓存增长上限:超过 800 条丢最旧的
function trimSummaryCache() {
  if (summaryCache.size <= 800) return;
  const keys = [...summaryCache.keys()].sort((a, b) => (summaryCache.get(a).at || 0) - (summaryCache.get(b).at || 0));
  for (const k of keys.slice(0, summaryCache.size - 800)) summaryCache.delete(k);
}

// API key 解析链:进程 env → ~/.dsh/.credentials.yaml 的 refs 段。
// DSH 把凭据集中在 credentials 文件里管理(不一定导出到 web 宿主的 env),
// 轻量正则解析,不引 yaml 依赖。结果缓存,失败不缓存以便重试。
let cachedApiKey;
function getApiKey() {
  if (cachedApiKey !== undefined) return cachedApiKey;
  cachedApiKey = process.env.ZAI_CODING_CN_API_KEY || null;
  if (!cachedApiKey) {
    try {
      const raw = readFileSync(join(dshHome(), ".credentials.yaml"), "utf8");
      const m = /ZAI_CODING_CN_API_KEY:\s*["']?([^"'\n]+)["']?/.exec(raw);
      if (m && m[1].trim()) cachedApiKey = m[1].trim();
    } catch (e) {
      /* 凭据文件不存在或不可读 */
    }
  }
  return cachedApiKey;
}

async function llmComplete(userText, maxTokens) {
  return (await llmChat(
    [
      {
        role: "system",
        content:
          "你是会话清点助手。根据一个 DSH 会话的结构化信息提取两个字段:\n" +
          "- goal: 用户在这件事上想达到的目标,祈使句式待办,不超过 25 字,像看板卡片标题" +
          "(例:\"给 X 模型各版本做架构差异调研并验证\" 或 \"审完目标 PR 并给出结论\")\n" +
          "- status: 当前大致状态,一句话不超过 50 字,点出关键进展/下一步/阻塞" +
          "(例:\"代码全部完成,仅剩 GPU 实测,实例已关机\")\n" +
          "- achieved: 该目标当前是否已达成(boolean)。只有确已完成才算 true;" +
          "仍有剩余工作、被阻塞、在等待外部资源时为 false;信息不足可省略该字段\n" +
          '只输出 JSON:{"goal":"...","status":"...","achieved":false},不要其他内容。',
      },
      { role: "user", content: userText },
    ],
    maxTokens
  )).slice(0, 400);
}

// 解析 {"goal":"...","status":"..."};解析失败返回 null(由调用方降级)
function parseGoalStatus(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ""));
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const goal = typeof o.goal === "string" ? o.goal.trim().slice(0, 40) : "";
    const state = typeof o.status === "string" ? o.status.trim().slice(0, 90) : "";
    const achieved = typeof o.achieved === "boolean" ? o.achieved : undefined;
    if (goal && state) return { goal, state, achieved };
  } catch (e) {}
  return null;
}

function summaryInput(s) {
  const parts = [
    "标题: " + (s.title || "(无标题)"),
    "项目目录: " + (s.cwd || ""),
    "规模: " + s.nTurns + " 轮对话, " + s.nTools + " 次工具调用",
  ];
  if (s.firstUser) parts.push("用户最初说: " + s.firstUser);
  if (s.lastUser) parts.push("用户最后说: " + s.lastUser);
  if (s.lastAssistant) parts.push("助手最后回复: " + s.lastAssistant);
  if (s.openTodos && s.openTodos.length) parts.push("未完成事项: " + s.openTodos.join("; "));
  if ((s.flags || []).includes("forked")) parts.push("备注: 该会话曾派生出新会话继续工作");
  return parts.join("\n").slice(0, 1600);
}

let summarizing = false;
let summariesQueuedAgain = false;
let pendingSummaries = 0; // 模块级:跨请求持久,不被新 scan 重置
let tabDigests = {}; // 同上:tab -> 总述文本
const enrichedBySid = new Map(); // sid -> enriched 会话对象(跨请求持久)

// 内部字段(__fp)不进响应
function stripInternal(s) {
  const { __fp, ...rest } = s;
  return rest;
}

function currentTargets() {
  return [...enrichedBySid.values()]
    .filter((s) => !s.markedDone && !s.archived && (SUMMARY_TARGETS.has(s.status) || s.recent))
    .sort((a, b) => b.lastTime - a.lastTime)
    .slice(0, SUMMARY_HARD_CAP);
}

async function ensureSummaries(sidFp) {
  if (LLM_DISABLED) return;
  if (summarizing) {
    summariesQueuedAgain = true;
    return;
  }
  summarizing = true;
  try {
    await runSummaries(sidFp);
  } finally {
    summarizing = false;
    if (summariesQueuedAgain) {
      summariesQueuedAgain = false;
      ensureSummaries(sidFp);
    }
  }
}

async function runSummaries(sidFp) {
  const targets = currentTargets();

  // 待补摘要:缓存缺失或指纹变了。安静窗口:最后事件 <10 分钟的会话
  // 视为"还在写",沿用旧摘要(哪怕指纹已变)——给正在写的草稿反复拍照
  // 只会立刻过时,纯浪费 token;停下来 10 分钟后的下次拉取才出定稿。
  const QUIET_MS = 10 * 60 * 1000;
  const pending = [];
  for (const s of targets) {
    const fp = sidFp.get(s.id) || s.__fp || "";
    const hit = summaryCache.get(s.id);
    const hot = Date.now() - s.lastTime < QUIET_MS;
    if (hit && hit.fp === fp) {
      s.goal = hit.goal;
      s.stateText = hit.state;
      s.goalAchieved = hit.achieved;
      s.summaryState = "ok";
    } else if (hot && s.summaryState === "ok" && s.goal) {
      // 还在写且已有旧摘要:沿用旧文案但不写缓存(指纹不匹配保留在缓存里,
      // 安静后的下一轮自然会重算定稿——把旧文按新指纹写回会让它永远不更新)
    } else if (s.summaryState !== "pending") {
      s.summaryState = "pending";
    }
    if (s.summaryState === "pending" && !hot) pending.push({ s, fp });
  }
  pendingSummaries = pending.length;

  // 并发受限地逐个补
  let idx = 0;
  async function worker() {
    while (idx < pending.length) {
      const job = pending[idx++];
      try {
        const raw = await llmComplete(summaryInput(job.s));
        const parsed = parseGoalStatus(raw);
        if (!parsed) throw new Error("unparseable summary: " + raw.slice(0, 80));
        job.s.goal = parsed.goal;
        job.s.stateText = parsed.state;
        job.s.goalAchieved = parsed.achieved;
        job.s.summaryState = "ok";
        summaryCache.set(job.s.id, { v: 3, fp: job.fp, goal: parsed.goal, state: parsed.state, achieved: parsed.achieved, at: Date.now() });
        scheduleSummarySave();
        trimSummaryCache();
      } catch (e) {
        job.s.summaryState = "failed";
      }
      pendingSummaries = Math.max(0, pendingSummaries - 1);
    }
  }
  await Promise.all(Array.from({ length: LLM_CONCURRENCY }, worker));

  // ---------------- tab 总述 ----------------
  const all = [...enrichedBySid.values()];
  for (const tab of DIGEST_TABS) {
    const members = (tab === "recent" ? all.filter((s) => s.recent) : all.filter((s) => s.status === tab && s.status !== "board")).filter((s) => !s.markedDone && !s.archived);
    if (!members.length) {
      tabDigests[tab] = "";
      continue;
    }
    const key = tab + "|" + members.map((s) => s.id + ":" + (s.goal || "") + "/" + (s.stateText || "")).join("|").slice(0, 4000);
    if (digestCache.has(key)) {
      const hit = digestCache.get(key);
      tabDigests[tab] = typeof hit === "string" ? hit : hit.text;
      continue;
    }
    // 只等真正在生成队列里的摘要(pendingSummaries);被安静窗口推迟的
    // (还在写的会话)不算——否则活跃会话会永远堵住总述不生成
    if (pendingSummaries > 0) continue;
    try {
      const lines = members
        .slice(0, 15)
        .map((s) => "- " + (s.goal || s.title) + " —— " + (s.stateText || ""))
        .join("\n");
      const text = await llmDigest("以下是我最近的一些 DSH 工作会话的单行概括(分类: " + tab + ")。请用一到两句中文(不超过 90 字)总述这些会话合起来反映我在做什么、整体状态如何。直接输出总述:\n" + lines);
      digestCache.set(key, { text, at: Date.now() });
      scheduleDigestSave();
      tabDigests[tab] = text;
    } catch (e) {
      tabDigests[tab] = "";
    }
  }
}

async function llmDigest(userText) {
  return (await llmChat(
    [
      { role: "system", content: "你是工作简报助手,输出精炼的中文总述,不列清单、不加前缀。" },
      { role: "user", content: userText },
    ],
    400
  )).slice(0, 160);
}

const digestCache = new Map(); // key(内容指纹) -> {text, at};持久化,重启即得
const DIGEST_FILE = join(dshHome(), "whats-up.digests.json");
let digestSaveTimer = null;

async function loadDigestCache() {
  try {
    const arr = JSON.parse(await readFile(DIGEST_FILE, "utf8"));
    if (Array.isArray(arr)) {
      for (const e of arr) {
        if (e && typeof e.key === "string" && typeof e.text === "string") {
          digestCache.set(e.key, { text: e.text, at: Number(e.at) || 0 });
        }
      }
    }
  } catch (e) {}
}

function scheduleDigestSave() {
  if (digestSaveTimer) return;
  digestSaveTimer = setTimeout(async () => {
    digestSaveTimer = null;
    // 上限 200 条,丢最旧
    let entries = [...digestCache.entries()].map(([key, v]) => ({ key, text: v.text, at: v.at || 0 }));
    if (entries.length > 200) {
      entries.sort((a, b) => b.at - a.at);
      entries = entries.slice(0, 200);
    }
    try {
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(DIGEST_FILE, JSON.stringify(entries), "utf8");
    } catch (e) {}
  }, 3000);
}

// ---------------------------------------------------------------- per-file analysis

function capText(s, n) {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// 真实用户文本:role=user、source.kind 缺省或 "user"、非 <system-reminder> 注入。
function realUserText(data) {
  if (!data || data.role !== "user") return null;
  const src = data.source || {};
  if (src.kind !== undefined && src.kind !== "user") return null;
  let text = "";
  for (const c of Array.isArray(data.content) ? data.content : []) {
    if (c && typeof c === "object" && c.type === "text") text += c.text + "\n";
  }
  text = text.trim();
  if (!text || text.startsWith("<system-reminder>")) return null;
  return text;
}

function assistantText(data) {
  const msg = (data && (data.message || data)) || {};
  let text = "";
  for (const c of Array.isArray(msg.content) ? msg.content : []) {
    if (c && typeof c === "object" && c.type === "text") text += c.text + "\n";
  }
  text = text.trim();
  return text || null;
}

function analyzeLines(lines, file, sessionId) {
  const s = {
    id: sessionId,
    cwd: "",
    createdTime: 0,
    title: "",
    lastTime: 0,
    nUser: 0,
    nAssistant: 0,
    nTools: 0,
    nTurns: 0,
    firstUser: "",
    lastUser: "",
    lastUserTime: 0,
    lastAssistant: "",
    lastAssistantTime: 0,
    openTodos: [],
    interrupted: false, // 最后一个 turn/end 的 reason 不是 completed
    openTurn: false, // 最后一个 turn 有 start 无 end
    forked: false,
  };
  const turnStarts = [];
  const turnEndReasons = new Map(); // turn -> reason kind
  let lastTodo = null;

  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const t = ev.type;
    const ts = ev.time || 0;
    if (ts > s.lastTime) s.lastTime = ts;
    if (t === "session") {
      s.cwd = ev.cwd || "";
      s.createdTime = ev.createdAt || 0;
      if (ev.id && typeof ev.id === "string") s.id = ev.id; // 权威 id(目录名可能是裸 uuid)
    } else if (t === "session/title") {
      const title = ev.data && ev.data.title;
      if (title) s.title = String(title);
    } else if (t === "session/end-seed") {
      s.forked = true;
    } else if (t === "user/message") {
      const text = realUserText(ev.data);
      if (text !== null) {
        s.nUser++;
        if (!s.firstUser) s.firstUser = capText(text, TEXT_CAP);
        s.lastUser = capText(text, TEXT_CAP);
        s.lastUserTime = ts;
      }
    } else if (t === "assistant/message") {
      s.nAssistant++;
      const text = assistantText(ev.data);
      if (text !== null) {
        s.lastAssistant = capText(text, TEXT_CAP);
        s.lastAssistantTime = ts;
      }
    } else if (t === "tool/call") {
      s.nTools++;
    } else if (t === "turn/start") {
      turnStarts.push(ev.data ? ev.data.turn : -1);
    } else if (t === "turn/end") {
      const d = ev.data || {};
      turnEndReasons.set(d.turn, ((d.reason && d.reason.kind) || ""));
    } else if (t === "todo/write") {
      lastTodo = ev.data ? ev.data.todos || [] : [];
    }
  }

  s.nTurns = turnStarts.length;
  if (turnStarts.length) {
    const lastTurn = turnStarts[turnStarts.length - 1];
    if (!turnEndReasons.has(lastTurn)) s.openTurn = true;
    else s.interrupted = turnEndReasons.get(lastTurn) !== "completed";
  }
  if (lastTodo) {
    s.openTodos = lastTodo
      .filter((td) => td && (td.status === "pending" || td.status === "in_progress"))
      .slice(0, TODO_CAP)
      .map((td) => capText(td.content, 120));
  }
  return s;
}

// ---------------------------------------------------------------- multi-frame zstd
// 会话文件是"拼接帧容器":每个持久化批次一个独立 zstd frame(见
// dsh-session-persistence-jsonl 的容器格式)。node:zlib 的一次性 API 只解
// 第一帧,这里按结构扫描帧边界逐帧解压拼接。尾部撕裂帧(正在写的活跃
// 会话)直接放弃——指纹变化后的下一轮扫描会补全。

const ZSTD_MAGIC = 4247762216;

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("invalid zstd frame magic at byte " + offset);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error("reserved frame-header bit");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("reserved block type");
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

function decompressSessionLog(raw) {
  const { frames } = scanZstdFrames(raw);
  const parts = [];
  for (const f of frames) parts.push(zstdDecompressSync(raw.subarray(f.start, f.end)));
  return Buffer.concat(parts).toString("utf8");
}

async function analyzeFile(file, sessionId) {
  const raw = await readFile(file);
  let text;
  // zstd magic 28 b5 2f fd;老/明文会话直接按 utf-8 解。
  if (raw.length > 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
    text = decompressSessionLog(raw);
  } else {
    text = raw.toString("utf8");
  }
  return analyzeLines(text.split("\n"), file, sessionId);
}

// ---------------------------------------------------------------- classification

function classify(s, now) {
  const isBoard = s.firstUser.startsWith(BOARD_PREFIX);
  const openTodo = s.openTodos.length > 0;
  const unanswered = s.nUser > 0 && (s.nAssistant === 0 || s.lastUserTime > s.lastAssistantTime);

  let status;
  if (now - s.lastTime < ACTIVE_WINDOW_MS) status = "active";
  else if (s.nUser === 0) status = "blank";
  else if (isBoard) status = "board";
  else if (openTodo || s.openTurn || s.interrupted) status = "half";
  else if (unanswered) status = "unanswered";
  else status = "done";

  // 近期工作:7 天内活跃、有实质工作量(轮数/工具量)、非自动非空白。
  // 一个会话可以"收尾完好"(done)但仍是连续推进的项目——比如连做了
  // 几天的 kernel 开发,每轮都答完了,规则上没有半途,但它是用户此刻最
  // 关心的事。单独打标记给"近期工作"视图,不挤占半途分类。
  const recent =
    status !== "board" &&
    status !== "blank" &&
    now - s.lastTime < RECENT_WINDOW_MS &&
    (s.nTurns >= RECENT_MIN_TURNS || s.nTools >= RECENT_MIN_TOOLS);

  const flags = [];
  if (openTodo) flags.push("open-todo");
  if (s.openTurn) flags.push("open-turn");
  if (s.interrupted) flags.push("interrupted");
  if (unanswered && !isBoard) flags.push("unanswered");
  if (s.forked) flags.push("forked");
  return { status, recent, flags };
}

// ---------------------------------------------------------------- incremental scan

// file -> { mtimeMs, size, summary }
const cache = new Map();
let aggregate = null; // { generatedAt, counts, sessions }
let scanning = null; // in-flight promise guard

async function discover() {
  const root = sessionsRoot();
  const out = [];
  let projects;
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch (e) {
    return out; // no sessions dir yet
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let sessionDirs;
    try {
      sessionDirs = await readdir(join(root, p.name), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue;
      // 目录名风格不一:session-<uuid> / 裸 <uuid> / main-session-<uuid>,
      // 一律以"目录里有没有会话文件"为准,id 从文件头 session 事件取权威值。
      for (const fname of ["session.jsonl.zstd", "session.jsonl"]) {
        out.push({ file: join(root, p.name, sd.name, fname), sessionId: sd.name });
      }
    }
  }
  return out;
}

async function scan(force) {
  const now = Date.now();
  await loadDoneOnce();
  const archivedSet = await loadArchivedSet();
  const found = await discover();

  // 指纹检查:只对 新出现的 / mtime或size变了的 / 缓存缺失的 文件重新分析。
  const changed = [];
  const seen = new Set();
  const sidFp = new Map(); // sid -> 指纹串(摘要缓存失效判定用)
  for (const { file, sessionId } of found) {
    let st;
    try {
      st = await stat(file);
    } catch (e) {
      continue; // 两种候选名,总有一个不存在
    }
    if (!st.isFile()) continue;
    seen.add(file);
    const hit = cache.get(file);
    if (!force && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue;
    changed.push({ file, sessionId, mtimeMs: st.mtimeMs, size: st.size });
  }
  // 会话被删掉/归档:清出缓存
  for (const key of [...cache.keys()]) if (!seen.has(key)) cache.delete(key);

  for (const c of changed) {
    try {
      const summary = await analyzeFile(c.file, c.sessionId);
      cache.set(c.file, { mtimeMs: c.mtimeMs, size: c.size, summary });
    } catch (e) {
      // 读了一半的活跃文件等下轮再试;旧的缓存先留着
    }
  }
  for (const v of cache.values()) sidFp.set(v.summary.id, v.mtimeMs + ":" + v.size);

  const sessions = [...cache.values()].map((v) => v.summary);
  const counts = { active: 0, half: 0, unanswered: 0, board: 0, done: 0, blank: 0, recent: 0, archived: 0 };
  // enriched 对象跨请求持久(挂在 enrichedBySid 上):摘要状态(summary/summaryState)
  // 是异步补上的,如果每次请求都重建对象,正在生成的摘要会挂到已被丢弃的旧对象
  // 上,响应里永远看不到。只有指纹变了的会话才重建条目。
  const seenSids = new Set();
  for (const s of sessions) {
    const verdict = classify(s, now);
    let { status, recent, flags } = verdict;
    const prevEntry = enrichedBySid.get(s.id); // goalAchieved 由摘要流程写在 enriched 对象上
    // 语义升级:对话层面收尾完好(done)但 LLM 从内容判定目标未达成
    // (剩工作/被阻塞/等资源)→ 归入"别忘了"。规则的 done 只说明
    // "最后一轮答完了",不等于"这件事做完了"。
    if (status === "done" && prevEntry && prevEntry.goalAchieved === false) {
      status = "half";
      flags = [...flags, "goal-open"];
    }
    const archived = archivedSet.has(s.id);
    if (archived) {
      counts.archived++; // 归档:不计入任何业务分类
    } else {
      counts[status]++;
      if (recent) counts.recent++;
    }
    seenSids.add(s.id);
    const prev = enrichedBySid.get(s.id);
    const fp = sidFp.get(s.id) || "";
    // 手动标记完成:应用标记 / 计数扣减 / 智能复活(标记后又有新事件则取消)
    let markedDone = false;
    if (doneMap.has(s.id)) {
      if (s.lastTime > doneMap.get(s.id) + 60000) {
        doneMap.delete(s.id); // 用户又回去做事了,复活
        scheduleDoneSave();
      } else {
        markedDone = true;
        counts[status] = Math.max(0, counts[status] - 1);
        if (recent) counts.recent = Math.max(0, counts.recent - 1);
      }
    }
    seenSids.add(s.id);
    if (prev && prev.__fp === fp) {
      // 内容没变:原地刷新分类字段,保留摘要状态
      prev.status = status;
      prev.recent = recent;
      prev.flags = flags;
      prev.markedDone = markedDone;
      prev.archived = archived;
    } else {
      enrichedBySid.set(s.id, { ...s, status, recent, flags, markedDone, archived, __fp: fp });
    }
  }
  for (const sid of [...enrichedBySid.keys()]) if (!seenSids.has(sid)) enrichedBySid.delete(sid);

  const enriched = [...enrichedBySid.values()].sort((a, b) => {
    const so = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (so) return so;
    return b.lastTime - a.lastTime;
  });
  aggregate = {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    total: enriched.length,
    counts,
    sessions: enriched.map(stripInternal),
    tabDigests,
    pendingSummaries,
  };
  // 摘要异步补齐,不阻塞响应;下一次请求自然带上
  loadSummaryCacheOnce().then(() => ensureSummaries(sidFp));
  return aggregate;
}

let summaryCacheLoaded = null;
function loadSummaryCacheOnce() {
  if (!summaryCacheLoaded) summaryCacheLoaded = loadSummaryCache().then(() => loadDigestCache());
  return summaryCacheLoaded;
}

function ensureScanned(force) {
  if (!scanning) {
    scanning = scan(force).catch(() => aggregate || { ok: false, error: "scan failed" }).finally(() => {
      scanning = null;
    });
  }
  return scanning;
}

// ---------------------------------------------------------------- 归档会话排除
// 归档是 workspace registry 的标记(会话文件不挪窝):~/.dsh/storages/
// workspace.json 的 global.archivedSessionIds。归档 = 用户主动收起,不进
// 任何计数、不摘要,单独收进"已归档" tab。

async function loadArchivedSet() {
  try {
    const raw = JSON.parse(await readFile(join(dshHome(), "storages", "workspace.json"), "utf8"));
    const ids = raw && raw.global && raw.global.archivedSessionIds;
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch (e) {
    return new Set();
  }
}

// ---------------------------------------------------------------- 手动标记完成
// host 端状态(~/.dsh/whats-up.done.json),多设备共享: sid -> { t }
// 标记后:卡片沉底、计数扣减、摘要/总述排除。
// 智能复活:标记之后会话又有新事件(lastTime > t + 60s 宽限)说明用户又回去
// 做事了,自动取消标记。

const DONE_FILE = join(dshHome(), "whats-up.done.json");
const doneMap = new Map(); // sid -> t(标记时刻)
let doneLoaded = null;
let doneSaveTimer = null;

function loadDoneOnce() {
  if (!doneLoaded) {
    doneLoaded = readFile(DONE_FILE, "utf8")
      .then((raw) => {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === "object") {
          for (const [sid, v] of Object.entries(obj)) {
            if (typeof sid === "string" && sid.length <= 120 && v && Number.isFinite(Number(v.t))) {
              doneMap.set(sid, Number(v.t));
            }
          }
        }
      })
      .catch(() => {});
  }
  return doneLoaded;
}

function scheduleDoneSave() {
  if (doneSaveTimer) return;
  doneSaveTimer = setTimeout(async () => {
    doneSaveTimer = null;
    const out = {};
    for (const [sid, t] of doneMap.entries()) out[sid] = { t };
    try {
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(DONE_FILE, JSON.stringify(out), "utf8");
    } catch (e) {}
  }, 500);
}

// ---------------------------------------------------------------- route

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function queryParam(req, key) {
  try {
    return new URL(req.url || "", "http://localhost").searchParams.get(key) || "";
  } catch (e) {
    return "";
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(buf || "{}"));
      } catch (e) {
        resolve({});
      }
    });
  });
}

export function apply(ctx) {
  ctx.effect(() => {
    const routes = [
      {
        kind: "exact",
        path: "/api/whats-up/data",
        handler: (req, res) => {
          if (req.method !== "GET") return json(res, 405, { ok: false, error: "method-not-allowed" });
          const fresh = queryParam(req, "fresh") === "1";
          ensureScanned(fresh).then((v) => json(res, 200, v), (e) => json(res, 500, { ok: false, error: String((e && e.message) || e) }));
        },
      },
      {
        kind: "exact",
        path: "/api/whats-up/done",
        handler: (req, res) => {
          if (req.method !== "POST") return json(res, 405, { ok: false, error: "method-not-allowed" });
          readBody(req).then(async (body) => {
            const sid = body && body.sid;
            if (typeof sid !== "string" || !sid || sid.length > 120) return json(res, 400, { ok: false, error: "invalid sid" });
            await loadDoneOnce();
            if (body.done === false) doneMap.delete(sid);
            else doneMap.set(sid, Date.now());
            scheduleDoneSave();
            json(res, 200, { ok: true, marked: doneMap.has(sid) });
          });
        },
      },
    ];
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "whats-up: routes");
}
