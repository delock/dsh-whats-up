#!/usr/bin/env bash
# 等 dsh-whats-up 仓库满 1 天(+10 分钟缓冲),推空提交重触发 PR #4465 的
# Submission gate,等 3 分钟后打印检查结果。自校准:每轮按 GitHub 返回的
# created_at 精确计算剩余等待,不会因启动偏早而失败。
set -u
PR=4465
CATALOG=awesome-dsh-plugin/awesome-dsh-plugin
BRANCH=add-dsh-whats-up
NEED=$((86400 + 600)) # 1 天 + 10 分钟安全垫

while true; do
  created=$(gh api repos/delock/dsh-whats-up --jq .created_at 2>/dev/null) || { echo "WARN: cannot read repo age, sleep 10min"; sleep 600; continue; }
  age=$(($(date +%s) - $(date -d "$created" +%s)))
  if [ "$age" -ge "$NEED" ]; then
    echo "repo age ${age}s >= ${NEED}s, ready"
    break
  fi
  remain=$((NEED - age))
  echo "repo age ${age}s, sleeping ${remain}s (~$((remain/3600))h$(( (remain%3600)/60 ))m)"
  sleep "$remain"
done

# 推空提交重触发
head=$(gh api "repos/$CATALOG/git/ref/heads/$BRANCH" --jq .object.sha)
tree=$(gh api "repos/$CATALOG/git/commits/$head" --jq .tree.sha)
new=$(gh api -X POST "repos/$CATALOG/git/commits" \
  -f message="chore: retrigger submission gate (repo now 1+ day old)" \
  -f tree="$tree" -f "parents[]=$head" --jq .sha) || { echo "ERR: create commit failed"; exit 1; }
gh api -X PATCH "repos/$CATALOG/git/refs/heads/$BRANCH" -f sha="$new" >/dev/null || { echo "ERR: update ref failed"; exit 1; }
echo "retriggered: empty commit $new pushed to $BRANCH"

# 等 CI 出结果
sleep 180
echo "=== PR checks after retrigger ==="
gh pr checks "$PR" --repo "$CATALOG" || true
