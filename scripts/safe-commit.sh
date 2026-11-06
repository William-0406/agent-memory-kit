#!/bin/sh
# 安全提交 · 只提交你这一轮真正改过的文件
#
# 用法：sh scripts/safe-commit.sh "提交信息" 文件1 [文件2 ...]
#
# 为什么存在这事：
#   `git add -A` 的问题不是它危险，是它把「我改了什么」这个判断偷偷跳过了。
#   你写一条提交信息，它却把工作室里所有人的改动一起塞进去，日后按提交记录追
#   「这段是谁写的」就会追错。要求显式列出路径，等于每次提交都必须回答一次这个问题。
#
# 它拦不住什么：如果你把别人改的文件也显式列进来，照样卷进去。
#   这条只是把「默认全加」变成「默认不加」，剩下的仍靠你看清楚。

set -e

if [ $# -lt 2 ]; then
  echo "用法：sh scripts/safe-commit.sh \"提交信息\" 文件1 [文件2 ...]"
  echo ""
  echo "当前工作区有改动的文件："
  git status --short
  exit 1
fi

MSG="$1"
shift

# 先看一眼：有没有我没列进来、但已经改了的文件？列出来但不阻止——可能是别的助手正在写。
UNLISTED=$(git status --porcelain -- . | awk '{print $NF}' | while read -r f; do
  found=0
  for a in "$@"; do
    if [ "$f" = "$a" ]; then found=1; fi
  done
  if [ "$found" -eq 0 ]; then echo "$f"; fi
done)

if [ -n "$UNLISTED" ]; then
  echo "⚠️  以下文件有改动但不在本次提交清单里（不会被提交）："
  echo "$UNLISTED" | sed 's/^/     /'
  echo "   → 如果其中有你这一轮改的，补进参数；如果是别的助手在写，就该留着。"
  echo ""
fi

git add -- "$@"
git commit -m "$MSG"
