# Project Context

This note records the important decisions from the Codex build/debug thread for this project. It is not a full transcript; it is the handoff context future maintainers need.

## Why This Exists

The user had a SillyTavern chat under the character `星球` suddenly disappear. One important version reportedly had 217 messages. Existing local files, old backups, Trash, and browser data did not reveal a recoverable 217-message copy.

This project was created to reduce the chance of that happening again by writing independent file-level JSONL snapshots outside SillyTavern's current chat file.

## Product Direction

Keep this as a custom sentinel backup system, not a wrapper around SillyTavern's native chat backup browser.

Reasons:

- SillyTavern native backups are useful but too coarse for this use case.
- Native backup names can be hard to identify, especially with Chinese names.
- Native retention is controlled by SillyTavern config, not by per-chat UI.
- The user wants clear per-chat/per-branch snapshot versions, preview, delete, keep, and restore controls.

The plugin should preserve these principles:

- No external API calls.
- No upload of chat content.
- Store snapshots locally under `data/default-user/backups/sentinel-chat`.
- Treat branches and separate chat files as separate version groups.
- Keep the UI practical and not too decorative.

## Architecture

The repo intentionally has two parts:

- `extensions/chat-sentinel-backup`: SillyTavern frontend extension.
- `plugins/chat-sentinel-backup`: SillyTavern server plugin.

The server plugin exists because the extension needs reliable filesystem operations:

- write snapshot files;
- list snapshots for the current chat;
- preview snapshot content;
- delete selected snapshots;
- mark/unmark snapshots as `KEEP`;
- restore a selected snapshot by overwriting the current chat file.

SillyTavern's built-in extension installer only installs frontend extensions into `data/default-user/extensions`. It does not install server plugins into `plugins`. For this project, do not rely on SillyTavern's "Install extension" button.

## Install And Update

Use the repo script:

```bash
./install-or-update.command
```

On the user's machine, the repo currently lives at:

```text
/Users/money/SillyTavern-Launcher/SillyTavern/local-repos/chat-sentinel-backup-manual
```

The script:

- runs `git pull --ff-only`;
- symlinks the frontend extension into `data/default-user/extensions/chat-sentinel-backup`;
- symlinks the server plugin into `plugins/chat-sentinel-backup`;
- runs `node --check` on the frontend and server files.

After install/update, SillyTavern must be restarted because server plugin APIs are loaded at startup.

## Current User Workflow

The intended workflow is:

1. Double-click `install-or-update.command`.
2. Wait for "安装/更新完成".
3. Restart SillyTavern.
4. Refresh the browser page.
5. Use `聊天记录守护备份` in extension settings.

Do not tell the user to install this repo through SillyTavern's extension installer. That path can clone the repo into the wrong place or fail with `Internal Server Error` / `Directory already exists`.

## Important Features

Current features include:

- automatic current-chat snapshots on chat events;
- manual current-chat snapshot;
- current character/group full chat backup;
- selected chat backup;
- per-chat retention count;
- `KEEP` marking to protect chosen snapshots from cleanup;
- current-chat version list;
- preview selected snapshot, showing the last two rounds;
- delete selected snapshots;
- restore one selected snapshot over the current chat file.

Restoring is intentionally limited to one selected snapshot at a time and asks for confirmation.

## Retention Rules

`每聊保留` applies to ordinary snapshots for each concrete chat file/branch. When the count is reached, new ordinary snapshots cause older ordinary snapshots for that same chat key to be cleaned.

Snapshots marked `KEEP` are excluded from automatic cleanup and can grow beyond the ordinary per-chat retention limit.

Many chat files/branches can still produce many total files because the limit is per concrete chat key, not global.

## Safety Notes

- Deleting snapshots deletes only sentinel snapshots, not the active SillyTavern chat.
- Restoring a snapshot overwrites the current active chat file on disk.
- After restore, the user should refresh or reopen the chat because SillyTavern may still have old chat content in memory.
- The plugin should refuse to snapshot empty chats.
- Snapshot ownership checks should prevent using a snapshot from one chat key against another chat.

## Known Local Paths

SillyTavern root:

```text
/Users/money/SillyTavern-Launcher/SillyTavern
```

Frontend symlink:

```text
/Users/money/SillyTavern-Launcher/SillyTavern/data/default-user/extensions/chat-sentinel-backup
```

Server plugin symlink:

```text
/Users/money/SillyTavern-Launcher/SillyTavern/plugins/chat-sentinel-backup
```

Snapshot directory:

```text
/Users/money/SillyTavern-Launcher/SillyTavern/data/default-user/backups/sentinel-chat
```

GitHub remote:

```text
https://github.com/xiongmaoyaxiongmao/chat-sentinel-backup-manual.git
```

## UI Preference

The user found the first UI too rough and visually awkward. Keep the settings panel compact, list-like, and close to SillyTavern's native settings style. Avoid large custom panels, card-heavy layout, and verbose in-app explanations.

Buttons should be direct and task-focused. Current labels such as `管理版本`, `查看两轮`, `覆盖存档`, and `删除已选` match the user's mental model better than abstract names.

## Maintenance Notes

Before changing behavior:

1. Inspect the real SillyTavern APIs and current plugin files.
2. Keep changes scoped.
3. Run:

```bash
node --check plugins/chat-sentinel-backup/index.cjs
node --check extensions/chat-sentinel-backup/index.js
git diff --check
```

When changing server routes, remind the user to restart SillyTavern.

