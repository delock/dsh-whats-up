# dsh-whats-up

DSH What's up · 会话动态面板:host 端扫描 `~/.dsh/sessions` 的会话事件流,把每个会话分类为
**近期工作 / 做到一半 / 问了没回 / 进行中 / 自动会话 / 已完成 / 空白**,并为每个
会话生成 LLM 一行摘要、为每个 tab 生成总述;侧栏小组件显示数量,全屏面板点卡片
直接跳回那个被遗忘的会话。

## 判断规则(分类纯规则)

| 分类 | 依据 |
| --- | --- |
| ⚡ 进行中 | 15 分钟内仍有事件 |
| 🔴 做到一半 | 最后一次 `todo/write` 仍有 pending/in_progress;或最后一个 turn 被中断 / 有 start 无 end |
| 🟡 问了没回 | 最后一条真实用户消息晚于最后一条 assistant 回复 |
| 🔵 自动会话 | 首条消息以 `This session is for working on` 开头(pr-board 派生) |
| 🟢 已完成 | 最后一条是完整回复 |
| ⚪ 空白 | 从未有过真实用户消息 |
| 📌 近期工作 | 7 天内活跃 + 有实质工作量(≥3 轮或 ≥10 次工具),不限分类——连续推进的项目(如给 Qwen 写 kernel)即使每轮都答完了也会 surfaced |

## LLM 摘要(host 端,glm)

- 每个值得看的会话(近期/半途/没回/进行中,上限 40 个)提取两个结构化字段:
  - **goal**(卡片标题):用户想达到的目标,祈使句式待办(≤25 字)
  - **status**(状态行):当前大致状态一句话,含关键进展/下一步/阻塞(≤50 字)
- 原 LLM 会话标题降级为卡片上的小字注释(`💬 原题`),跳转搜索兜底仍用它
- 每个 tab(近期/半途/没回/进行中)生成 1–2 句总述
- 凭据解析链:env `ZAI_CODING_CN_API_KEY` → `~/.dsh/.credentials.yaml`;
  模型默认 `glm-5.3` 且 `thinking: disabled`(思考模式会把 max_tokens 烧在
  reasoning_content 里,正文恒空;实测 14s→1.1s);`DSH_SA_MODEL` 可换模型,
  `DSH_SA_NO_LLM=1` 完全关闭
- 摘要按文件指纹缓存到 `~/.dsh/session-audit.summaries.json`(v2 格式),会话没变不重算
- LLM 不可用时降级为规则拼出的兜底文案(todo/最后一条消息),面板照常可用

## 更新策略

每次请求只 `stat` 文件指纹(mtime + size);指纹不变完全不重算,变了才重新解压
分析对应文件。全量首扫约 4.5s(123 个会话),之后增量近乎零成本。摘要生成期间
面板每 12s 自动重拉直到补齐。

## 安装(web profile)

```bash
# ~/.dsh/profiles/web/package.json
#   dependencies 加 "dsh-session-audit": "link:/home/akey/dsh"(link: 改代码只需重启)
#   dsh.profile.bundles 加 "dsh-session-audit"
cd ~/.dsh/profiles/web && pnpm install
# 重启 dsh web
```

## 使用

- 侧栏"会话清点"小组件:🔴 半途 N / 🟡 没回 M,点击开面板
- 面板内点任意卡片 → 直接跳回该会话(`ctx.sessions.open`)
- `Alt+J` 开关面板,`Esc` 关闭
- host 端数据接口:`GET /api/session-audit/data`(`?fresh=1` 强制全量重扫)

## 开发

- `index.js` — host 端:多帧 zstd 解码 + 会话事件流分析 + 增量缓存
- `client/client.js` — 浏览器端:侧栏组件 + 全屏面板
- `tools/test-host.mjs` — 用真实会话数据验证 host 分类(`node tools/test-host.mjs`)
- `tools/audit.py` — 项目起点的独立 Python 审计脚本(一次性清点报告)(`node tools/test-host.mjs`)
