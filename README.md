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
| 📌 近期工作 | 7 天内活跃 + 有实质工作量(≥3 轮或 ≥10 次工具),不限分类——连续推进的项目(比如连做了几天的 kernel 开发)即使每轮都答完了也会 surfaced |

## LLM 摘要(host 端,glm)

- 每个值得看的会话(近期/半途/没回/进行中,上限 40 个)提取两个结构化字段:
  - **goal**(卡片标题):用户想达到的目标,祈使句式待办(≤25 字)
  - **status**(状态行):当前大致状态一句话,含关键进展/下一步/阻塞(≤50 字)
- 原 LLM 会话标题降级为卡片上的小字注释(`💬 原题`),跳转搜索兜底仍用它
- 每个 tab(近期/半途/没回/进行中)生成 1–2 句总述
- **模型选择机制(多 provider)**:候选链 = `DSH_SA_MODEL`(支持
  `provider/model` 或裸模型名)→ settings.yaml 的 `agent-default-model`
  (GUI 默认模型)→ settings 里其他凭据可解析的 provider(按声明顺序)。
  endpoint 从 dsh 安装内的 pi-ai provider 注册表运行时解析(46 家,GUI
  同源不硬编码);凭据解析 env(`apiKeyEnv`/注册表 env 名)→
  `~/.dsh/.credentials.yaml`。运行时探活:401/403/网络错误 → 当前候选
  阵亡 30 分钟自动切换;glm 系模型自动附 `thinking: disabled`
- 摘要按文件指纹缓存到 `~/.dsh/whats-up.summaries.json`(v2 格式),会话没变不重算
- LLM 不可用时降级为规则拼出的兜底文案(todo/最后一条消息),面板照常可用

## 更新策略

每次请求只 `stat` 文件指纹(mtime + size);指纹不变完全不重算,变了才重新解压
分析对应文件。全量首扫约 4.5s(123 个会话),之后增量近乎零成本。摘要生成期间
面板每 12s 自动重拉直到补齐。

## 安装(web profile)

```bash
cd ~/.dsh/profiles/web

# 1. 克隆本仓库到任意位置,例如 ~/dsh-whats-up
git clone https://github.com/delock/dsh-whats-up.git ~/dsh-whats-up

# 2. package.json 的 dsh.profile.bundles 加 "dsh-whats-up",
#    dependencies 加 "dsh-whats-up": "link:<克隆路径>"
#    (link: 协议是符号链接,改代码只需重启,无需重新 install)

# 3. 安装并重启
pnpm install
# 重启 dsh web
```

## 使用

- 侧栏"会话清点"小组件:🔴 半途 N / 🟡 没回 M,点击开面板
- 面板内点任意卡片 → 直接跳回该会话(`ctx.sessions.open`)
- `Alt+J` 开关面板,`Esc` 关闭
- host 端数据接口:`GET /api/whats-up/data`(`?fresh=1` 强制全量重扫)

## 开发

- `index.js` — host 端:多帧 zstd 解码 + 会话事件流分析 + 增量缓存
- `client/client.js` — 浏览器端:侧栏组件 + 全屏面板
- `tools/test-host.mjs` — 用真实会话数据验证 host 分类(`node tools/test-host.mjs`)
- `tools/audit.py` — 项目起点的独立 Python 审计脚本(一次性清点报告)(`node tools/test-host.mjs`)
