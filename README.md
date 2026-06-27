# Chat Sentinel Backup

SillyTavern local chat snapshot guard.

This repository contains two parts:

- `plugins/chat-sentinel-backup`: server-side plugin. It writes JSONL snapshots to the user's backup directory.
- `extensions/chat-sentinel-backup`: frontend extension. It adds the SillyTavern settings UI and calls the local plugin APIs.

## Install

Copy the server plugin:

```bash
cp -R plugins/chat-sentinel-backup /path/to/SillyTavern/plugins/chat-sentinel-backup
```

Copy the frontend extension:

```bash
cp -R extensions/chat-sentinel-backup /path/to/SillyTavern/data/default-user/extensions/chat-sentinel-backup
```

Make sure server plugins are enabled in SillyTavern config:

```yaml
enableServerPlugins: true
```

Restart SillyTavern after installing or updating the plugin.

## What It Does

- Automatically snapshots the current chat after chat changes.
- Saves independent JSONL snapshots under `data/default-user/backups/sentinel-chat`.
- Supports manual snapshot of the current chat.
- Supports backing up all chats under the current character or group.
- Supports selecting specific chat files to back up.
- Supports marking selected snapshots as `KEEP` so automatic cleanup will not remove them.

## Manual

See [docs/chat-sentinel-backup-manual.md](docs/chat-sentinel-backup-manual.md).
