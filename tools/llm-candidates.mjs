// 开发诊断:复现 index.js 的候选链解析,打印决策结果
import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const dshHome = join(homedir(), ".dsh");

// settings.yaml
const raw = readFileSync(join(dshHome, "settings.yaml"), "utf8");
const dm = /agent-default-model:\s*\n\s*provider:\s*(\S+)[\s\S]*?\n\s*model:\s*(\S+)/.exec(raw);
console.log("GUI 默认模型:", dm[1] + "/" + dm[2]);

const pm = /llm-pi-ai:\s*\n\s*providers:\s*\n([\s\S]*?)(?=\n\S|$)/.exec(raw);
let cur = null;
const providers = [];
for (const line of pm[1].split("\n")) {
  const pid = /^ {4}([A-Za-z0-9_-]+):\s*$/.exec(line);
  if (pid) { cur = { id: pid[1], apiKeyEnv: "", models: [] }; providers.push(cur); continue; }
  if (!cur) continue;
  const env = /^ {6}apiKeyEnv:\s*(\S+)/.exec(line);
  if (env) cur.apiKeyEnv = env[1];
  const mid = /^ {8}- id:\s*(\S+)/.exec(line);
  if (mid) cur.models.push(mid[1]);
}
console.log("settings providers:", providers.map((p) => `${p.id}(models:${p.models.length})`).join(", "));

// pi-ai 注册表
let dir = dirname(realpathSync(process.argv[1]));
let providersDir = "";
for (let i = 0; i < 10 && !providersDir; i++) {
  const c = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers");
  if (existsSync(c)) providersDir = c;
  else dir = dirname(dir);
}
console.log("注册表目录:", providersDir);
const pi = new Map();
for (const f of readdirSync(providersDir)) {
  if (!f.endsWith(".js") || f.endsWith(".models.js")) continue;
  const src = readFileSync(join(providersDir, f), "utf8");
  const base = /baseUrl:\s*"([^"]+)"/.exec(src);
  if (base) pi.set(f.replace(/\.js$/, ""), base[1]);
}
console.log("已知 endpoint:", [...pi.keys()].join(", "));

// 凭据
function hasCred(envName) {
  if (!envName) return false;
  if (process.env[envName]) return true;
  try {
    const r = readFileSync(join(dshHome, ".credentials.yaml"), "utf8");
    return r.includes(envName + ":");
  } catch {
    return false;
  }
}

console.log("\n候选链(按优先级):");
let rank = 1;
if (pi.has(dm[1]) && hasCred("ZAI_CODING_CN_API_KEY")) {
  console.log(` ${rank++}. ${dm[1]}/${dm[2]}  key:有  endpoint:${pi.get(dm[1])}`);
}
for (const p of providers) {
  if (p.id === dm[1]) continue;
  const envNames = [p.apiKeyEnv, ...(pi.has(p.id) ? [] : [])].filter(Boolean);
  const keyOk = hasCred(p.apiKeyEnv);
  const endpoint = pi.get(p.id);
  console.log(` ${rank++}. ${p.id}/${p.models[0] || "?"}  key:${keyOk ? "有" : "无"}  endpoint:${endpoint ? endpoint.slice(0, 45) : "未知(跳过)"}`);
}
