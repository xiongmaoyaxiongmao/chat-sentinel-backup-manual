#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DEFAULT_ST="/Users/money/SillyTavern-Launcher/SillyTavern"
ST="${SILLYTAVERN_DIR:-$DEFAULT_ST}"
OWNER_FILE=".chat-sentinel-backup-owner"
OWNER_VALUE="chat-sentinel-backup-manual"
STAMP="$(date +%Y%m%d-%H%M%S)"

die() {
  print -u2 -- "失败：$1"
  exit 1
}

owned_target() {
  local target="$1"
  [[ -f "$target/$OWNER_FILE" ]] && [[ "$(<"$target/$OWNER_FILE")" == "$OWNER_VALUE" ]]
}

preflight_link() {
  local link="$1"
  local expected="$2"
  if [[ -L "$link" ]]; then
    local actual
    actual="$(cd -- "$(dirname -- "$link")" && realpath "$link")" \
      || die "$link 是损坏或无法解析的链接，已停止；没有改动现有安装。"
    [[ "$actual" == "$expected" ]] && return 0
    owned_target "$actual" || die "$link 指向未知插件，已停止；没有改动现有安装。"
    return 0
  fi
  if [[ -e "$link" ]]; then
    [[ -d "$link" ]] && owned_target "$link" \
      || die "$link 是没有本插件所有权标记的目录或文件，已停止；没有改动现有安装。"
  fi
}

[[ -f "$REPO/plugins/chat-sentinel-backup/index.cjs" \
   && -f "$REPO/plugins/chat-sentinel-backup/$OWNER_FILE" \
   && -f "$REPO/extensions/chat-sentinel-backup/index.js" \
   && -f "$REPO/extensions/chat-sentinel-backup/manifest.json" \
   && -f "$REPO/extensions/chat-sentinel-backup/$OWNER_FILE" ]] \
  || die "源码仓库的前端或服务端目标不完整。"
[[ -f "$ST/server.js" && -d "$ST/data/default-user/extensions" && -d "$ST/plugins" ]] \
  || die "SillyTavern 路径不正确：$ST"

PLUGIN_LINK="$ST/plugins/chat-sentinel-backup"
EXT_LINK="$ST/data/default-user/extensions/chat-sentinel-backup"
PLUGIN_TARGET="$REPO/plugins/chat-sentinel-backup"
EXT_TARGET="$REPO/extensions/chat-sentinel-backup"
PLUGIN_NEXT="${PLUGIN_LINK}.next-$$"
EXT_NEXT="${EXT_LINK}.next-$$"
PLUGIN_BACKUP=""
EXT_BACKUP=""
PLUGIN_STATE="untouched"
EXT_STATE="untouched"

preflight_link "$PLUGIN_LINK" "$PLUGIN_TARGET"
preflight_link "$EXT_LINK" "$EXT_TARGET"
node "$REPO/scripts/check-syntax.mjs"

ln -s -- "$PLUGIN_TARGET" "$PLUGIN_NEXT"
ln -s -- "$EXT_TARGET" "$EXT_NEXT"
[[ "$(cd -- "$(dirname -- "$PLUGIN_NEXT")" && realpath "$PLUGIN_NEXT")" == "$PLUGIN_TARGET" ]] \
  || die "服务端 staging 链接校验失败。"
[[ "$(cd -- "$(dirname -- "$EXT_NEXT")" && realpath "$EXT_NEXT")" == "$EXT_TARGET" ]] \
  || die "前端 staging 链接校验失败。"

rollback() {
  local exit_code=$?
  local rollback_failures=0
  trap - EXIT
  set +e

  /bin/rm -f -- "$PLUGIN_NEXT" || {
    print -u2 -- "回滚失败：无法清理服务端 staging 链接 $PLUGIN_NEXT"
    (( rollback_failures += 1 ))
  }
  /bin/rm -f -- "$EXT_NEXT" || {
    print -u2 -- "回滚失败：无法清理前端 staging 链接 $EXT_NEXT"
    (( rollback_failures += 1 ))
  }

  if [[ "$PLUGIN_STATE" == "installed" ]]; then
    if [[ -L "$PLUGIN_LINK" ]]; then
      /bin/rm -f -- "$PLUGIN_LINK" || {
        print -u2 -- "回滚失败：无法移除本轮安装的服务端链接 $PLUGIN_LINK"
        (( rollback_failures += 1 ))
      }
    elif [[ -e "$PLUGIN_LINK" ]]; then
      print -u2 -- "回滚失败：服务端 live target 已变成非链接，已停止删除并保留现场：$PLUGIN_LINK"
      (( rollback_failures += 1 ))
    fi
  fi
  if [[ "$EXT_STATE" == "installed" ]]; then
    if [[ -L "$EXT_LINK" ]]; then
      /bin/rm -f -- "$EXT_LINK" || {
        print -u2 -- "回滚失败：无法移除本轮安装的前端链接 $EXT_LINK"
        (( rollback_failures += 1 ))
      }
    elif [[ -e "$EXT_LINK" ]]; then
      print -u2 -- "回滚失败：前端 live target 已变成非链接，已停止删除并保留现场：$EXT_LINK"
      (( rollback_failures += 1 ))
    fi
  fi

  if [[ "$PLUGIN_STATE" == "backed_up" || "$PLUGIN_STATE" == "installed" ]]; then
    if [[ "${SENTINEL_TEST_FAIL_PLUGIN_RESTORE:-0}" == "1" ]]; then
      print -u2 -- "回滚失败：测试注入的服务端恢复失败；备份保留在 $PLUGIN_BACKUP"
      (( rollback_failures += 1 ))
    elif [[ -e "$PLUGIN_LINK" || -L "$PLUGIN_LINK" ]]; then
      print -u2 -- "回滚失败：服务端 live target 仍存在，未覆盖；备份保留在 $PLUGIN_BACKUP"
      (( rollback_failures += 1 ))
    elif [[ -e "$PLUGIN_BACKUP" || -L "$PLUGIN_BACKUP" ]]; then
      mv -- "$PLUGIN_BACKUP" "$PLUGIN_LINK" || {
        print -u2 -- "回滚失败：无法恢复服务端备份 $PLUGIN_BACKUP"
        (( rollback_failures += 1 ))
      }
    else
      print -u2 -- "回滚失败：服务端备份不存在 $PLUGIN_BACKUP"
      (( rollback_failures += 1 ))
    fi
  fi

  if [[ "$EXT_STATE" == "backed_up" || "$EXT_STATE" == "installed" ]]; then
    if [[ "${SENTINEL_TEST_FAIL_EXTENSION_RESTORE:-0}" == "1" ]]; then
      print -u2 -- "回滚失败：测试注入的前端恢复失败；备份保留在 $EXT_BACKUP"
      (( rollback_failures += 1 ))
    elif [[ -e "$EXT_LINK" || -L "$EXT_LINK" ]]; then
      print -u2 -- "回滚失败：前端 live target 仍存在，未覆盖；备份保留在 $EXT_BACKUP"
      (( rollback_failures += 1 ))
    elif [[ -e "$EXT_BACKUP" || -L "$EXT_BACKUP" ]]; then
      mv -- "$EXT_BACKUP" "$EXT_LINK" || {
        print -u2 -- "回滚失败：无法恢复前端备份 $EXT_BACKUP"
        (( rollback_failures += 1 ))
      }
    else
      print -u2 -- "回滚失败：前端备份不存在 $EXT_BACKUP"
      (( rollback_failures += 1 ))
    fi
  fi

  if (( rollback_failures == 0 )); then
    print -u2 -- "安装切换失败；本轮已变更的安装入口均已恢复，未变更的入口保持原样。"
  else
    print -u2 -- "安装切换失败，且回滚有 ${rollback_failures} 项未完成；已继续尝试所有目标，请保留备份和现场。"
  fi
  (( rollback_failures > 0 )) && exit 2
  (( exit_code == 0 )) && exit_code=1
  exit "$exit_code"
}
trap rollback EXIT

if [[ -e "$PLUGIN_LINK" || -L "$PLUGIN_LINK" ]]; then
  PLUGIN_BACKUP="${PLUGIN_LINK}.bak-${STAMP}"
  mv -- "$PLUGIN_LINK" "$PLUGIN_BACKUP"
  PLUGIN_STATE="backed_up"
fi
if [[ -e "$EXT_LINK" || -L "$EXT_LINK" ]]; then
  EXT_BACKUP="${EXT_LINK}.bak-${STAMP}"
  if [[ "${SENTINEL_TEST_FAIL_EXTENSION_BACKUP:-0}" == "1" ]]; then
    die "测试注入：前端旧安装备份失败。"
  fi
  mv -- "$EXT_LINK" "$EXT_BACKUP"
  EXT_STATE="backed_up"
fi

mv -- "$PLUGIN_NEXT" "$PLUGIN_LINK"
PLUGIN_STATE="installed"
if [[ "${SENTINEL_TEST_FAIL_SECOND_LINK:-0}" == "1" ]]; then
  die "测试注入：第二个链接切换失败。"
fi
mv -- "$EXT_NEXT" "$EXT_LINK"
EXT_STATE="installed"
trap - EXIT

[[ -n "$PLUGIN_BACKUP" ]] && print -- "已保留服务端可回滚备份：$PLUGIN_BACKUP"
[[ -n "$EXT_BACKUP" ]] && print -- "已保留前端可回滚备份：$EXT_BACKUP"
print -- "已安装：$PLUGIN_LINK -> $PLUGIN_TARGET"
print -- "已安装：$EXT_LINK -> $EXT_TARGET"
print -- ""
print -- "当前版本安装完成。没有拉取网络更新，也没有删除任何旧目录。"
print -- "服务器插件变更需要在你授权后重启 SillyTavern 才会生效。"
