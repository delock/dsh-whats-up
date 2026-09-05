// 开发期验证:直接调用 host 插件的 route handler,检查真实数据下的分类结果。
import { apply } from "../index.js";

let route;
const ctx = {
  effect(fn, label) {
    const dispose = fn();
    return undefined;
  },
  webServer: {
    register(r) {
      if (r.path === "/api/whats-up/data") route = r; // 插件注册多条路由,只取 data
      return () => {};
    },
  },
};
apply(ctx);

const chunks = [];
const res = {
  writeHead(code, headers) {
    this.code = code;
  },
  end(body) {
    chunks.push(body);
  },
};
const req = { method: "GET", url: "/api/whats-up/data" };

const t0 = Date.now();
route.handler(req, res);
// handler 是异步的:轮询等结果
await new Promise((r) => setTimeout(r, 50));
let agg = null;
for (let i = 0; i < 200; i++) {
  if (chunks.length) {
    try {
      agg = JSON.parse(chunks[0]);
      break;
    } catch (e) {}
  }
  await new Promise((r) => setTimeout(r, 100));
}
if (!agg) {
  console.error("no response");
  process.exit(1);
}
console.log("scan ms:", Date.now() - t0);
console.log("total:", agg.total, "counts:", JSON.stringify(agg.counts));
console.log("--- half sessions ---");
for (const s of agg.sessions.filter((x) => x.status === "half")) {
  console.log(` [${s.id.slice(8, 16)}] ${s.title} · ${s.nTurns}轮 · todos=${s.openTodos.length} flags=${s.flags.join(",")}`);
}
console.log("--- unanswered sessions ---");
for (const s of agg.sessions.filter((x) => x.status === "unanswered")) {
  console.log(` [${s.id.slice(8, 16)}] ${s.title} · last="${(s.lastUser || "").slice(0, 40)}"`);
}
console.log("--- active ---");
for (const s of agg.sessions.filter((x) => x.status === "active")) {
  console.log(` [${s.id.slice(8, 16)}] ${s.title}`);
}
// 抽查 payload 大小
console.log("payload KB:", Math.round(chunks[0].length / 1024));
