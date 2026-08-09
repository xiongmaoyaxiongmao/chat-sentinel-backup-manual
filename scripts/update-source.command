#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"

[[ -d "$REPO/.git" ]] || {
  print -u2 -- "失败：当前目录不是 Git clone，无法拉取更新。"
  exit 1
}

cd -- "$REPO"
[[ -z "$(git status --porcelain=v1 -uall)" ]] || {
  print -u2 -- "失败：仓库有本地修改。为避免覆盖宝宝的工作，已停止更新。"
  exit 1
}

BEFORE="$(git rev-parse HEAD)"
git fetch origin main
git merge --ff-only origin/main
AFTER="$(git rev-parse HEAD)"

print -- "源码更新完成：$BEFORE -> $AFTER"
print -- "这一步不改安装链接；需要时再运行 ./install-or-update.command 安装当前版本。"
