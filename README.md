# Chat Sentinel Backup

Chat Sentinel Backup 是 SillyTavern 的纯本地聊天快照与恢复工具。它从服务器已经落盘的 JSONL 创建独立快照，不从浏览器上传聊天全文，不调用模型 API，也不包含遥测或云备份。

仓库分成两部分：

- `plugins/chat-sentinel-backup`：身份与路径校验、v2 inventory/index、快照存储与保留、安全恢复、API。
- `extensions/chat-sentinel-backup`：事件捕获、按聊天 scheduler、设置入口和独立管理界面。

## 独立测试

需要 Node.js 20 或更高版本。仓库没有第三方运行或测试依赖：

```bash
npm test
```

语法检查：

```bash
npm run check
```

## 安装当前版本

```bash
./install-or-update.command
```

这个命令只安装当前 checkout，不访问网络。它会：

1. 检查服务端和前端源文件语法；
2. 检查现有安装是否属于本插件；
3. 对已确认属于本插件的旧安装保留 `.bak-时间` 可回滚备份；
4. 先同时校验并 staging 前后端两个链接，再切换；
5. 第二个链接切换失败时，自动恢复第一个链接和两个旧安装。

如果目标是未知 symlink、文件或没有本插件所有权标记的目录，安装会停止，不删除或覆盖任何内容。

自定义 SillyTavern 路径：

```bash
SILLYTAVERN_DIR="/path/to/SillyTavern" ./install-or-update.command
```

## 单独拉取源码更新

```bash
./scripts/update-source.command
```

更新和安装是两个动作。更新脚本只允许干净 Git worktree，先 fetch，再 fast-forward；网络失败不会改安装链接。更新后仍需明确运行安装当前版本。

SillyTavern 必须启用：

```yaml
enableServerPlugins: true
```

服务器插件只有在用户授权重启 SillyTavern 后才会加载新版本。

## 数据

每个 SillyTavern 用户的目录完全隔离。默认用户的文件位于：

```text
data/default-user/backups/sentinel-chat/
```

其中：

- `*.jsonl`：不可变快照正文；
- `.sentinel-chat-index.v2.json`：原子写入的 v2 inventory、去重事实、长期保留、回收站和恢复状态；
- `.sentinel-chat-state.json`：只作为旧版迁移输入，新代码不再向它写入。

旧 JSONL 不会自动改名或删除。首次创建 v2 索引时，旧文件先进入可见的“待归属旧备份 / 隔离项”。只有文件本身或旧状态能唯一证明同一用户目录、稳定实体 ID 和聊天文件身份时，才会绑定到新的 canonical identity；证据不足时永久保留原名并停止猜测。新快照只写 v2 identity，不双写旧 identity。

如果 v2 索引损坏，原件会先改名隔离保存，存储健康标记为降级，再扫描现有 JSONL 重建。无法推导的 `长期保留`、回收站和 hash 状态不会被伪造；用户明确确认修复前，保留清理和永久删除均被阻止。

## 管理界面

扩展设置抽屉只显示本地存储健康摘要和“打开聊天守护”入口。独立管理界面包含：

- `聊天守护`：当前聊天、最近快照、版本数、存储健康和唯一主操作；
- `备份历史`：当前聊天、全部聊天、回收站；
- `版本详情`：元数据、最近几轮预览、长期保留、安全恢复和回收站操作；
- `设置`：自动守护、最短间隔、固定 10 个循环保护点、存储位置/健康、安装版本。

## 恢复安全合同

所有恢复共用一条流程：

1. 校验快照 canonical identity 与目标聊天；
2. 逐行解析完整 JSONL；
3. 目标存在时先创建不可自动清理的 `pre-restore` 保险快照；
4. 临时文件写入并 `fsync`，再原子替换；
5. 目标、群聊元数据、保险快照和索引处于同一个提交合同；任一步失败都会一起回滚；
6. 返回恢复来源、目标、保险快照和结果。

自动守护遇到显著缩水会继续拒绝。用户在界面明确确认时，系统先把旧完整基线设为长期保留，再写入标记为“人工确认删改”的新快照。

详细使用说明见 [docs/chat-sentinel-backup-manual.md](docs/chat-sentinel-backup-manual.md)。
