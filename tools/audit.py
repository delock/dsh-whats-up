#!/usr/bin/env python3
"""DSH 会话审计:扫描 ~/.dsh/sessions,找出做到一半被遗忘的会话。

判断信号:
  1. 最后一次 todo/write 仍有 pending / in_progress 项
  2. 最后一条真实用户消息之后没有任何 assistant 回复(问了就走了)
  3. 最后一个 turn 有 start 无 end,或 turn/end 原因不是 completed(被中断)

特殊处理:
  - pr-board 等工具派生的自动会话(首条消息为 "This session is for working on ...")单独归类
  - 可用 DSH_AUDIT_EXCLUDE="<id>,<id>" 排除指定会话(比如当前会话)

输出: Markdown 报告(默认 session-report.md)
"""
import glob
import json
import os
import re
import subprocess
import time
from datetime import datetime

SESSIONS_DIR = os.path.expanduser(os.environ.get("DSH_SESSIONS_DIR", "~/.dsh/sessions"))
OUT_PATH = os.environ.get("DSH_AUDIT_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "session-report.md"))
EXCLUDE = {x.strip() for x in os.environ.get("DSH_AUDIT_EXCLUDE", "").split(",") if x.strip()}

BOARD_PREFIX = "This session is for working on"

STATUS_ORDER = {"half": 0, "unanswered": 1, "board": 2, "done": 3}
STATUS_LABEL = {
    "half": "🔴 做到一半(有未完成 todo 或被中断的实质工作)",
    "unanswered": "🟡 你问了没回(最后一条是你发的,没有下文)",
    "board": "🔵 看板/工具自动会话(pr-board 派生)",
    "done": "🟢 大概率完成",
}


def real_user_text(ev):
    """提取真实用户文本(过滤 system-reminder / 指令注入)。"""
    data = ev.get("data", {})
    if data.get("role") != "user":
        return None
    src = data.get("source") or {}
    if src.get("kind") not in (None, "user"):
        return None
    parts = []
    for c in data.get("content", []):
        if isinstance(c, dict) and c.get("type") == "text":
            parts.append(c.get("text", ""))
    text = "\n".join(parts).strip()
    if not text or text.startswith("<system-reminder>"):
        return None
    return text


def assistant_text(ev):
    data = ev.get("data", {})
    msg = data.get("message") or data
    parts = []
    for c in msg.get("content", []):
        if isinstance(c, dict) and c.get("type") == "text":
            parts.append(c.get("text", ""))
    text = "\n".join(parts).strip()
    return text or None


def excerpt(s, n=180):
    s = " ".join(s.split())
    return s[:n] + ("…" if len(s) > n else "")


def fmt_time(ms):
    return datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M")


def short_id(sid):
    m = re.search(r"session-([0-9a-f]{8})", sid or "")
    return m.group(1) if m else (sid or "?")[:12]


def scan_file(path):
    try:
        raw = subprocess.run(["zstd", "-dc", path], capture_output=True, timeout=30).stdout
    except Exception:
        return None
    sess = {
        "file": path,
        "id": None, "cwd": None, "created": None,
        "title": None,
        "last_time": 0,
        "n_user": 0, "n_assistant": 0, "n_tool": 0, "n_turns": 0,
        "first_user": None,          # (time, text)
        "last_user": None,           # (time, text)
        "last_assistant": None,      # (time, text)
        "last_todo": None,           # (time, todos)
        "open_turn": False,
        "open_turn_kind": None,      # 'running' | 'interrupted' | 'aborted' | ...
        "forked": False,
    }
    turn_starts, turn_ends = {}, {}
    for line in raw.splitlines():
        try:
            ev = json.loads(line)
        except Exception:
            continue
        t = ev.get("type")
        ts = ev.get("time", 0)
        if ts > sess["last_time"]:
            sess["last_time"] = ts
        if t == "session":
            sess["id"] = ev.get("id")
            sess["cwd"] = ev.get("cwd")
            sess["created"] = ev.get("createdAt")
        elif t == "session/title":
            sess["title"] = ev.get("data", {}).get("title")
        elif t == "session/end-seed":
            sess["forked"] = True
        elif t == "user/message":
            txt = real_user_text(ev)
            if txt is not None:
                sess["n_user"] += 1
                if sess["first_user"] is None:
                    sess["first_user"] = (ts, txt)
                sess["last_user"] = (ts, txt)
        elif t == "assistant/message":
            sess["n_assistant"] += 1
            txt = assistant_text(ev)
            if txt is not None:
                sess["last_assistant"] = (ts, txt)
        elif t == "tool/call":
            sess["n_tool"] += 1
        elif t == "turn/start":
            turn_starts[ev.get("data", {}).get("turn")] = ts
        elif t == "turn/end":
            d = ev.get("data", {})
            turn_ends[d.get("turn")] = ts
        elif t == "todo/write":
            sess["last_todo"] = (ts, ev.get("data", {}).get("todos", []))
    sess["n_turns"] = len(turn_starts)
    # 最后一个 turn 是否没有正常结束
    if turn_starts:
        last_turn = max(turn_starts)
        if last_turn not in turn_ends:
            sess["open_turn"] = True
            sess["open_turn_kind"] = "running"
        else:
            # 找最后一个 turn/end 的原因
            reason = None
            for line in raw.splitlines():
                pass  # reason 已在下面统一补读
    # 补读最后一个 turn/end 的 reason
    last_reason = None
    for line in raw.splitlines():
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") == "turn/end":
            last_reason = (ev.get("data", {}).get("reason") or {}).get("kind")
    if turn_starts and max(turn_starts) in turn_ends and last_reason not in ("completed", None):
        sess["open_turn"] = True
        sess["open_turn_kind"] = last_reason

    # ---- 分类 ----
    is_board = bool(sess["first_user"] and sess["first_user"][1].startswith(BOARD_PREFIX))
    open_todo = False
    if sess["last_todo"]:
        open_todo = any(td.get("status") in ("pending", "in_progress") for td in sess["last_todo"][1])
    unanswered = sess["last_user"] is not None and (
        sess["last_assistant"] is None or sess["last_user"][0] > sess["last_assistant"][0]
    )
    if is_board:
        sess["status"] = "board"
    elif open_todo or sess["open_turn"]:
        sess["status"] = "half"
    elif unanswered:
        sess["status"] = "unanswered"
    else:
        sess["status"] = "done"
    sess["is_board"] = is_board
    sess["open_todo"] = open_todo
    sess["unanswered"] = unanswered
    return sess


def main():
    files = sorted(glob.glob(os.path.join(SESSIONS_DIR, "*", "*", "session.jsonl.zstd")))
    now = time.time() * 1000
    sessions = []
    for f in files:
        s = scan_file(f)
        if not s or not s["last_time"] or s["id"] in EXCLUDE:
            continue
        sessions.append(s)

    counts = {"half": 0, "unanswered": 0, "board": 0, "done": 0}
    for s in sessions:
        counts[s["status"]] += 1
    sessions.sort(key=lambda s: (STATUS_ORDER[s["status"]], -s["last_time"]))

    lines = []
    lines.append("# DSH 会话清点报告")
    lines.append("")
    lines.append(f"- 扫描时间:{datetime.now().strftime('%Y-%m-%d %H:%M')},共 **{len(sessions)}** 个会话")
    lines.append(
        f"- {STATUS_LABEL['half']}:**{counts['half']}** 个 ｜ {STATUS_LABEL['unanswered']}:**{counts['unanswered']}** 个"
        f" ｜ {STATUS_LABEL['board']}:{counts['board']} 个 ｜ {STATUS_LABEL['done']}:{counts['done']} 个"
    )
    lines.append("")
    lines.append("> 判断依据:未完成的 todo / 中断的 turn / 最后一条用户消息无回复。仅供参考,以实际内容为准。")
    lines.append("> 回去续上:Web GUI 会话列表里按标题找;TUI 可用 `dsh --profile tui --resume session-<短id>`。")
    lines.append("")

    cur = None
    for s in sessions:
        if s["status"] != cur:
            cur = s["status"]
            lines.append(f"## {STATUS_LABEL[cur]} · {counts[cur]} 个")
            lines.append("")
        proj = s["cwd"] or os.path.dirname(os.path.dirname(os.path.dirname(s["file"])))
        days = max(0, int((now - s["last_time"]) / 86400000))
        title = s["title"] or "(无标题)"
        lines.append(f"### {title}")
        lines.append(
            f"- 项目:`{proj}` · 最后活动:{fmt_time(s['last_time'])}({days} 天前)"
            f" · {s['n_turns']} 轮 / {s['n_tool']} 次工具调用 · 短id `{short_id(s['id'])}`"
        )
        flags = []
        if s["open_todo"]:
            td = s["last_todo"][1]
            open_items = [t.get("content", "?") for t in td if t.get("status") in ("pending", "in_progress")]
            flags.append("遗留 todo:" + ";".join(excerpt(i, 100) for i in open_items[:3]))
        if s["open_turn_kind"] == "running":
            flags.append("最后一个 turn 没有结束记录(进行中或直接关闭)")
        elif s["open_turn"]:
            flags.append(f"最后一个 turn 被中断(reason={s['open_turn_kind']})")
        if s["unanswered"] and not s["is_board"]:
            if s["n_assistant"] == 0:
                flags.append("一句话就走了(全程无回复)")
            else:
                flags.append("你最后发了消息但没有得到回复")
        if s["forked"]:
            flags.append("曾被派生(fork)出新会话,后续工作可能在新会话里")
        for fl in flags:
            lines.append(f"- ⚠️ {fl}")
        if s["last_user"] and not s["is_board"]:
            lines.append(f"- 最后你说:{excerpt(s['last_user'][1])}")
        if s["last_assistant"]:
            lines.append(f"- 最后回复:{excerpt(s['last_assistant'][1])}")
        lines.append("")

    report = "\n".join(lines)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        fh.write(report)
    print(f"总 会话: {len(sessions)}")
    print(f"做到一半: {counts['half']}")
    print(f"问了没回: {counts['unanswered']}")
    print(f"看板自动: {counts['board']}")
    print(f"大概率完成: {counts['done']}")
    print(f"报告已写入: {OUT_PATH}")


if __name__ == "__main__":
    main()
