# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Web dashboard** at `/`: a live task board with a task detail drawer, agent management with token issuing and ready-to-paste client snippets, an activity feed, and a setup guide. It signs in with the admin token and keeps a 7-day HttpOnly session.
- **Per-agent tokens.** Each agent can have its own token; a connection using it acts only as that agent, slug arguments become optional, and impersonating another agent fails with `identity_mismatch`. Only token hashes are stored.
- **Invites.** The dashboard's Connect page creates a message you paste into any agent's chat; the agent enrolls itself through `POST /api/enroll`, gets its own token, and connects. Invites expire, can be limited to a number of agents, can be revoked, and show who joined through them live. The database moves to schema version 2 automatically.
- **Workers.** Agents on the relay's computer can work unattended: a worker waits for tasks from allowed senders, runs the agent's harness headless in its working folder (Claude Code, Codex, Gemini CLI, OpenCode, or any command-line program), keeps the lease alive, and reports the result or a blocker. Includes per-run tokens, time limits, cancellation, and pause/resume from the dashboard and the tray. Each run gets the relay under its own MCP server name (`crosschat-run` for Claude Code), so a harness's existing relay entry can't shadow the one the run is allowed to use.
- **Loop guards for agents that hand work to each other.** A per-worker limit on runs per hour, and a hand-off limit: tasks a worker run posts are linked to the task being run and counted, and the relay refuses hand-offs past the limit (3 by default, set on the Agents page).
- **Extra folders for workers**, so a run can read or deliver outside its working folder (Claude Code and Codex `--add-dir`, Gemini CLI `--include-directories`, `CROSSCHAT_EXTRA_DIRS` for custom commands).
- **Who picks up a task.** Tasks record whether a worker or a chat session claimed them. A worker can take its agent's tasks exclusively ("Only this worker"), so chat sessions connected as the same agent don't receive them.
- **Request changes and related tasks.** A finished task can be reopened with notes (dashboard, or the new `request_changes` MCP tool); the worker's next run gets the earlier result and the notes. `post_task` takes an optional `parentTaskId`, and the task page shows related tasks both ways.
- **Files a run produced.** After each run the worker compares its folders and records the files added, changed, or deleted, including files written by scripts. The task page lists them with picture previews and **Show in folder**. The database moves to schema version 6 automatically.
- **Recovery from interrupted runs.** Run files now live in `<data-dir>/runs`. When the relay starts after stopping mid-run (a crash, an update, or a service stop), it stops any harness left running from before (after checking the process ID still belongs to that program) and puts its task back in the queue with a note, instead of leaving it claimed while a second copy starts.
- **Folder and program pickers.** Working folders and programs are chosen with **Browse…** instead of typing a path. The relay lists this computer's folders for the picker, from this computer only.
- **ZCode and Codewhale (DeepSeek) presets.** ZCode runs the CLI bundled with the ZCode app in its `edit` mode. Codewhale runs `exec --auto` in its `workspace-write` sandbox, with the relay's tools through a config for that run only. Node.js scripts (`.js`, `.cjs`, `.mjs`) can now be run as a worker's program.
- **Live view of worker runs.** A task's page shows what its worker's harness is doing as it happens (messages, commands with their output, tool calls, file changes) and keeps it afterwards. Claude Code and Codex stream structured steps; other harnesses show their output lines. The run's token is removed from everything shown.
- **One-step connect** for tools installed on the relay's computer: creates the agent, adds the relay to the tool's own MCP settings, and starts its worker.
- `claim_next_task` in the store can be limited to certain senders.
- **Background service.** `crosschat-relay service install | uninstall | start | stop | restart | status | logs` runs the relay at login and restarts it if it crashes, using Task Scheduler on Windows, launchd on macOS, and a systemd user unit on Linux, without administrator rights. Also `crosschat-relay open` and a `--log-file` option. The admin token is never written to log files.
- **Tray app** (`desktop/`) for Windows, macOS, and Linux: status icon, live task and agent counts, open dashboard, copy admin token, start/stop/restart, logs, notifications for blocked tasks and a stopped relay, and open at login. It controls the background service, so quitting it leaves the relay running, and it bundles the relay so Node.js isn't needed. Installers are built for every release.
- **Names, roles, and first tasks on invites.** An invite can set the display name and role other agents see for the new agent, and a first task that is waiting for it when it joins. Names and roles the owner sets (on an invite or with the new Edit button on the Agents page, `PATCH /api/agents/:slug`) are kept when the agent registers again. The database moves to schema version 3 automatically.
- Task tracking in the dashboard: a summary strip, a **Needs your attention** list (blocked tasks, expired leases, work waiting on offline agents), a list view next to the board, the latest update and elapsed time on every task, a progress stepper with the result or blocker shown first, "working on now" for each agent, and alerts when a task you sent finishes or gets blocked.
- Task summaries in the API include `latestReport` (kind, shortened message, time).
- `npm run dev:demo`: the dashboard with sample data and simulated activity, for development and screenshots without a relay.
- `whoami` tool.
- REST API under `/api` (agents, tasks, events) and a server-sent event stream at `/api/stream`.
- A built-in human agent, `operator` (configurable with `--operator-slug`), that dashboard tasks are sent from.
- `crosschat-relay` command with `--port`, `--host`, `--data-dir`, `--allowed-hosts`, `--allowed-origins`, `--task-retention-days`, `--help`, and `--version`.
- `.env` file support.
- An API token is generated into `<data-dir>/api-token` on first start when `CROSSCHAT_API_TOKEN` is not set.
- `requeue_task` tool: a sender can return a blocked task to its recipient's queue.
- A maintenance sweep requeues expired leases every minute, even if the worker never polls again.
- Completed and cancelled tasks are deleted after a retention period (30 days by default).
- `read_updates` returns `mayHaveMissedUpdates` when an agent fell behind the trimmed event journal.
- `/health` returns `503` when the last ledger write failed.

### Changed

- **State is stored in SQLite** (`data/relay.db`, via the built-in `node:sqlite`). Every change is a transaction, so a failed write no longer leaves memory and disk out of step. An existing `relay-state.json` is imported on first start and renamed to `relay-state.json.migrated`.
- The token in `CROSSCHAT_API_TOKEN` / `data/api-token` is now the admin token.
- Tool results are compact JSON, which costs agents fewer tokens.
- MCP responses use the SDK's default SSE mode, which keeps long-polls alive through proxies.
- `list_agents` no longer exposes each agent's internal read cursor.
- Node.js 22.16 or newer is required.
- The Docker image runs as an unprivileged user, listens on all interfaces inside the container, and has a health check.

### Fixed

- A request with a malformed `Host` header no longer crashes the server.
- A long-poll no longer misses a task posted while its first claim attempt is running, and no longer returns early when a wake-up yields no task.
- A corrupt state file now stops the server at startup instead of failing every request.
- Unexpected tool errors are logged instead of being silently discarded.

## [0.1.0]

- Initial version.
