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
echo "正在修复安装链接..."
PLUGIN_LINK="$ST/plugins/chat-sentinel-backup"
EXT_LINK="$ST/data/default-user/extensions/chat-sentinel-backup"

find "$ST/data/default-user/extensions" -maxdepth 1 -type d -name 'chat-sentinel-backup.bak-*' -exec rm -rf {} +
find "$ST/plugins" -maxdepth 1 -type d -name 'chat-sentinel-backup.bak-*' -exec rm -rf {} +

if [ -e "$PLUGIN_LINK" ] && [ ! -L "$PLUGIN_LINK" ]; then
  rm -rf "$PLUGIN_LINK"
fi

if [ -e "$EXT_LINK" ] && [ ! -L "$EXT_LINK" ]; then
  rm -rf "$EXT_LINK"
fi

ln -sfn "$REPO/plugins/chat-sentinel-backup" "$PLUGIN_LINK"
ln -sfn "$REPO/extensions/chat-sentinel-backup" "$EXT_LINK"

echo "正在检查脚本语法..."
node --check "$PLUGIN_LINK/index.cjs"
node --check "$EXT_LINK/index.js"

echo
echo "更新完成。"
echo "如果只是界面变化，刷新 SillyTavern 页面即可。"
echo "如果更新内容包含服务端插件/API，请重启 SillyTavern。"
echo
read -r "reply?按回车关闭窗口..."
