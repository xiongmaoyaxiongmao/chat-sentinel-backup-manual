#!/bin/zsh
set -euo pipefail

REPO="/Users/money/SillyTavern-Launcher/SillyTavern/local-repos/chat-sentinel-backup-manual"
ST="/Users/money/SillyTavern-Launcher/SillyTavern"

echo "聊天记录守护备份 - 更新"
echo

if [ ! -d "$REPO/.git" ]; then
  echo "找不到插件 Git 仓库：$REPO"
  exit 1
fi

cd "$REPO"

echo "正在拉取 GitHub 更新..."
git pull --ff-only

echo
echo "正在检查安装链接..."
if [ ! -L "$ST/plugins/chat-sentinel-backup" ]; then
  echo "服务端插件不是软链接，请检查：$ST/plugins/chat-sentinel-backup"
  exit 1
fi

if [ ! -L "$ST/data/default-user/extensions/chat-sentinel-backup" ]; then
  echo "前端扩展不是软链接，请检查：$ST/data/default-user/extensions/chat-sentinel-backup"
  exit 1
fi

echo "正在检查脚本语法..."
node --check "$ST/plugins/chat-sentinel-backup/index.cjs"
node --check "$ST/data/default-user/extensions/chat-sentinel-backup/index.js"

echo
echo "更新完成。"
echo "如果只是界面变化，刷新 SillyTavern 页面即可。"
echo "如果更新内容包含服务端插件/API，请重启 SillyTavern。"
echo
read -r "reply?按回车关闭窗口..."
