#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DEFAULT_ST="/Users/money/SillyTavern-Launcher/SillyTavern"
ST="${SILLYTAVERN_DIR:-}"

pause() {
  echo
  read -r "reply?按回车关闭窗口..."
}

die() {
  echo
  echo "失败：$1"
  pause
  exit 1
}

find_sillytavern_root() {
  local dir="$REPO"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/server.js" ] && [ -d "$dir/data" ] && [ -d "$dir/plugins" ]; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done

  if [ -d "$DEFAULT_ST" ] && [ -f "$DEFAULT_ST/server.js" ]; then
    echo "$DEFAULT_ST"
    return 0
  fi

  return 1
}

echo "聊天记录守护备份 - Git 安装/更新"
echo

if [ ! -d "$REPO/extensions/chat-sentinel-backup" ] || [ ! -d "$REPO/plugins/chat-sentinel-backup" ]; then
  die "脚本没有在 chat-sentinel-backup-manual 仓库里运行。"
fi

if [ -z "$ST" ]; then
  ST="$(find_sillytavern_root)" || die "找不到 SillyTavern 目录。可以先设置 SILLYTAVERN_DIR=/你的/SillyTavern 路径。"
fi

if [ ! -f "$ST/server.js" ] || [ ! -d "$ST/data/default-user/extensions" ] || [ ! -d "$ST/plugins" ]; then
  die "SillyTavern 路径不对：$ST"
fi

echo "仓库：$REPO"
echo "SillyTavern：$ST"
echo

if [ -d "$REPO/.git" ]; then
  echo "正在拉取 GitHub 更新..."
  cd "$REPO"
  git pull --ff-only || die "git pull 失败。请确认没有本地冲突，或者网络/GitHub 权限正常。"
else
  echo "未检测到 .git，跳过拉取，只修复本地挂载。"
fi

PLUGIN_LINK="$ST/plugins/chat-sentinel-backup"
EXT_LINK="$ST/data/default-user/extensions/chat-sentinel-backup"
PLUGIN_TARGET="$REPO/plugins/chat-sentinel-backup"
EXT_TARGET="$REPO/extensions/chat-sentinel-backup"

echo
echo "正在修复安装链接..."

find "$ST/data/default-user/extensions" -maxdepth 1 -type d -name 'chat-sentinel-backup.bak-*' -exec rm -rf {} +
find "$ST/plugins" -maxdepth 1 -type d -name 'chat-sentinel-backup.bak-*' -exec rm -rf {} +

if [ -L "$PLUGIN_LINK" ]; then
  rm "$PLUGIN_LINK"
elif [ -e "$PLUGIN_LINK" ]; then
  rm -rf "$PLUGIN_LINK"
fi

if [ -L "$EXT_LINK" ]; then
  rm "$EXT_LINK"
elif [ -e "$EXT_LINK" ]; then
  rm -rf "$EXT_LINK"
fi

ln -s "$PLUGIN_TARGET" "$PLUGIN_LINK"
ln -s "$EXT_TARGET" "$EXT_LINK"

echo "正在检查脚本语法..."
if command -v node >/dev/null 2>&1; then
  node --check "$PLUGIN_LINK/index.cjs" || die "后端插件语法检查失败。"
  node --check "$EXT_LINK/index.js" || die "前端扩展语法检查失败。"
else
  echo "没有找到 node，跳过语法检查。"
fi

echo
echo "安装/更新完成。"
echo
echo "已挂载："
echo "- $EXT_LINK"
echo "- $PLUGIN_LINK"
echo
echo "重要：这个插件包含后端 API。安装或更新后请重启 SillyTavern，再刷新浏览器页面。"
pause
