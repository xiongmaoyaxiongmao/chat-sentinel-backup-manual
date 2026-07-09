# Chat Sentinel Backup

SillyTavern local chat snapshot guard.

This repository contains two parts:

- `plugins/chat-sentinel-backup`: server-side plugin. It writes JSONL snapshots to the user's backup directory.
- `extensions/chat-sentinel-backup`: frontend extension. It adds the SillyTavern settings UI and calls the local plugin APIs.

## Install

Recommended local install/update on macOS:

```bash
./install-or-update.command
```

Or double-click `install-or-update.command` in Finder.

The script will:

- run `git pull --ff-only` when this folder is a Git repo;
- mount the frontend extension into `data/default-user/extensions/chat-sentinel-backup`;
- mount the server plugin into `plugins/chat-sentinel-backup`;
- run a quick syntax check.

If your SillyTavern folder is not in the default location, run:

```bash
SILLYTAVERN_DIR="/path/to/SillyTavern" ./install-or-update.command
```

Make sure server plugins are enabled in SillyTavern config:

```yaml
enableServerPlugins: true
```

Restart SillyTavern after installing or updating the plugin.

## What It Does

- Automatically snapshots the current server-side chat file after chat changes.
- Never calls SillyTavern's native save routine or uploads the full chat from the browser.
- Rejects suspicious snapshots when a chat suddenly drops far below its protected message count.
- Saves independent JSONL snapshots under `data/default-user/backups/sentinel-chat`.
- Supports manual snapshot of the current chat.
- Supports backing up all chats under the current character or group.
- Supports selecting specific chat files to back up.
- Supports marking selected snapshots as `KEEP` so automatic cleanup will not remove them.
- Hides snapshots for chats you delete in SillyTavern and exposes them under a separate deleted-chat recovery view.

## Manual

See [docs/chat-sentinel-backup-manual.md](docs/chat-sentinel-backup-manual.md).
