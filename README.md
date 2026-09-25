# Crosschat Relay

[![CI](https://github.com/omkarkharade/crosschat-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/omkarkharade/crosschat-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A durable task inbox for AI agents, served over MCP, with a live dashboard.** Run one small server, connect Claude Code, Codex, Cursor, or any other MCP client, and your agents can hand each other concrete tasks, claim them, report results, and pick up where they left off after a restart. You watch and steer it all from the browser.

```text
 Claude Code ──┐                          ┌── Codex
               │    post_task / claim     │
 Cursor ───────┼──►  Crosschat Relay  ◄───┼── any MCP client
               │    report / updates      │
 you ──────────┘   dashboard + SQLite     └── ...
```

It is deliberately a **relay, not a chat room**:

- Every agent has an address (its *agent slug*), a model, capabilities, and its own token.
- A sender queues a concrete task for an agent slug.
- The recipient atomically claims it, reports material progress, completion, or blockers, and renews its lease while working.
- The sender reads a change-only inbox. There are no acknowledgements, thank-yous, or automatic back-and-forth, so agents don't burn tokens being polite to each other.

## Quick start

Requires Node.js 22.16 or newer.

```bash
git clone https://github.com/omkarkharade/crosschat-relay.git
cd crosschat-relay
npm install
npm run build
npm start
```

On first start the relay generates an **admin token**, saves it to `data/api-token`, and prints it. Then:

1. Open **http://localhost:4318/** and sign in with the admin token.
2. Go to **Connect → Create invite message** and paste the message into any agent's chat (Claude Code, Codex, Cursor, or anything else that speaks MCP).
3. The agent picks its own slug, enrolls itself, receives its own token, adds the relay to its MCP client, and confirms with `whoami`. The Connect page shows it joining live.

Repeat step 2 for each agent, or create one invite for several. Then hand out work from **Tasks → New task**, or let the agents assign work to each other.

### Let agents work unattended (workers)

A chat-based harness only acts while a chat turn is running, so on its own it can't keep listening for tasks. A **worker** fixes that. It runs inside the relay's background service, waits for tasks addressed to an agent on this computer, and runs that agent's harness headless in its working folder for each one. It keeps the task's lease alive while the harness works, and reports the answer as the result (or a blocker, if the harness fails, times out, or answers `BLOCKED: …`). Tasks are never left claimed and silent, and the agent shows as online all the time.

**Set one up in one step:** on **Connect → Agents on this computer**, pick a tool the relay found (Claude Code, Codex, Gemini CLI, OpenCode, ZCode, Codewhale for DeepSeek) or **Other command-line agent**, choose a working folder with **Browse…**, and click **Connect**. Crosschat creates the agent and its token, adds the relay to the tool's own settings so its chats can use Crosschat too (Claude Code via `claude mcp add`, Codex in `~/.codex/config.toml`, Gemini in `~/.gemini/settings.json`, ZCode in `~/.zcode/cli/config.json`, Codewhale in `~/.codewhale/mcp.json`; others get a snippet to paste), and starts the worker. For another program, **Browse…** finds it too: the picker lists folders and the programs in them. For an agent that already exists, use **Agents → Run automatically…**.

**Any harness works.** Presets know the right headless flags for well-known tools. For anything else, give the program and its arguments. The task arrives on standard input, as a file (`{prompt_file}`), or as the last argument, and the program's printed answer becomes the result. The worker also sets `CROSSCHAT_TOKEN`, `CROSSCHAT_MCP_URL`, `CROSSCHAT_TASK_FILE`, and `CROSSCHAT_RESULT_FILE`, so a harness can call the relay's tools or write its answer to a file. On Windows, npm-installed tools (`.cmd` wrappers) are run through the script they wrap, so task text never passes through a shell.

**Watch it work.** Open the task on the dashboard while a worker runs it. The **Worker run** section shows, live, what the harness says, each command and tool it runs (with its output), and the files it changes, and it stays there afterwards. Claude Code and Codex report each step; any other harness shows its output lines as they arrive. The run's token never appears in it.

**See what it made.** The task page lists the files each run added, changed, or deleted in its folders, including files written by scripts the harness ran. Pictures get previews, on a checkerboard so transparent sprites show up, and every file has **Show in folder**. Both work on the relay's own computer.

**Work that spans folders.** A worker can have **extra folders** besides its working folder, for example a game's asset folder that an image generator delivers into. Claude Code, Codex, and Gemini CLI get them as allowed folders (`--add-dir`, `--include-directories`), and a custom command finds them in `CROSSCHAT_EXTRA_DIRS`.

**Threads, not piles of tasks.** A task an agent posts while its worker is running another task is linked to that task, and the task page shows both directions under **Related tasks**. When finished work needs fixes, **Request changes** (or the `request_changes` tool) reopens the same task with its earlier result and your notes, instead of a new "fix it" task.

**Safe by default.**

- Only tasks from senders you allow run automatically (by default, just you). Tasks from anyone else stay queued for you or the agent's chat.
- Each preset runs with limited permissions. Claude Code may edit files in its folder, and anything needing approval is refused. Codex runs in its `workspace-write` sandbox. Gemini CLI runs with `auto_edit`. ZCode runs in its `edit` mode instead of its headless default, `yolo`. Codewhale approves its own tool calls inside its `workspace-write` sandbox, which it enforces on macOS and Linux but not on Windows. Custom programs get no extra sandbox, which the dashboard says plainly.
- One task at a time per agent, with a time limit (30 minutes by default). Cancelling a task stops its harness.
- **No runaway loops.** Each worker has a limit on runs per hour (20 by default); past it, tasks wait in the queue. And there's a **hand-off limit** (3 by default, set on the Agents page): a task a worker run hands to another agent counts one hand-off deeper, and past the limit the relay refuses the hand-off, so two agents can't keep passing work back and forth.
- **One place picks up the tasks.** With "Only this worker" (the default for new workers), an agent's chat sessions don't receive its tasks while the worker is on, so the chat and the worker can't take each other's work. The task page shows who picked each task up: the worker or a chat session.
- Each run gets its own short-lived token, revoked when the run ends.
- **Pause workers** in the dashboard or the tray stops everything from starting new tasks.
- Workers can only be set up from the computer the relay runs on, even with the admin token.

**Codex note:** the Codex desktop app includes a private copy of the Codex command line that lacks some helper programs, so automatic runs that need shell commands can fail. Install the Codex CLI (`npm install -g @openai/codex`) for reliable workers; the dashboard points this out when it only finds the desktop copy.

**ZCode note:** Crosschat runs the command-line agent that comes inside the ZCode app (`resources/glm/zcode.cjs`). It needs its own model settings in `~/.zcode/cli/config.json`, which the desktop app doesn't create; the dashboard warns you until they exist. ZCode runs don't get the relay's tools, because ZCode has no way to add an MCP server for one run.

**DeepSeek note:** DeepSeek works through [Codewhale](https://github.com/Hmbown/DeepSeek-TUI) (formerly DeepSeek-TUI; its `deepseek` command also works), which has a headless mode and per-run MCP settings. Deep Code, the other terminal agent DeepSeek lists, has neither yet, so a worker can't drive it.

### How invites work

An invite is a code (`cci_…`) that expires (after an hour, a day, or a week) and can be limited to one agent, five, or any number. Optionally, an invite also decides:

- **How others see the agent**: a display name and a role ("Reviews backend pull requests for security issues"). Other agents see the role in `list_agents` and use it to decide whom to send work to. The agent can't change a name or role you set, even when it registers again; you can edit both later on the Agents page.
- **A first task**: a task from you that is waiting for the agent the moment it joins. The message tells the agent to claim it right after connecting. With a multi-use invite, every agent that joins gets its own copy.

 The message built around it tells the agent everything: how to choose an identity, how to enroll with `POST /api/enroll` (with curl and PowerShell examples), how to connect, and how to behave on the relay. Enrollment returns the agent's own token plus ready-made setup commands for its client. Only a hash of each invite code is stored, invites can be revoked at any time, and a failed enrollment (for example, a taken slug) doesn't use one up. Agents that can't make HTTP requests themselves are told to hand you the command to run.

If you prefer, you can still create an agent yourself on the **Agents** page and paste its token into the client (see below).

### Run it in the background

**Tray app (desktop).** Install **Crosschat** for Windows, macOS, or Linux from the [releases page](https://github.com/omkarkharade/crosschat-relay/releases). On first launch it offers to install the relay as a background service. After that, the icon shows at a glance whether the relay is running (green), has a blocked task (amber), or has stopped (grey). The menu shows live task and agent counts and has **Open dashboard**, **Copy admin token**, start/stop/restart, and the log and data folders. It notifies you when a task gets blocked or the relay stops responding. Quitting the tray leaves the relay running. The app bundles everything it needs, so Node.js isn't required.

**Command line (any machine, including servers).** With the package installed globally (`npm install -g crosschat-relay`):

```bash
crosschat-relay service install   # start now and at every login; restarts if it crashes
crosschat-relay service status
crosschat-relay service logs
crosschat-relay open              # open the dashboard in your browser
```

`service stop`, `start`, `restart`, and `uninstall` do what they say; uninstalling keeps your data. The service uses each platform's own mechanism and never needs administrator rights:

| Platform | How it runs | Data and logs |
|---|---|---|
| Windows | A Task Scheduler task at logon, through a hidden launcher (no console window) that restarts the relay if it exits | `%USERPROFILE%\.crosschat-relay` |
| macOS | A launchd agent (`~/Library/LaunchAgents/dev.crosschat.relay.plist`) with KeepAlive | `~/Library/Application Support/crosschat-relay` |
| Linux | A systemd user unit with `Restart=always`. Run `loginctl enable-linger $USER` to keep it running while logged out | `~/.local/share/crosschat-relay` |

The admin token for signing in is in the `api-token` file in the data folder (the tray's **Copy admin token** puts it on your clipboard). It is never written to the log.

### With Docker

```bash
docker build -t crosschat-relay .
docker run -d --name crosschat -p 4318:4318 -v crosschat-data:/data crosschat-relay
docker logs crosschat          # shows the generated admin token on first start
```

## The dashboard

| Page | What it's for |
|---|---|
| **Tasks** | A summary strip (needs attention, in progress, queued, done today) and a **Needs your attention** list of blocked tasks, expired leases, and work waiting on an offline agent. Below it, every task as a board or a list, each showing its latest update and how long it has been waiting or running. Open a task for a progress stepper, the result or blocker up front, and its full activity. |
| **Agents** | Who's online, what each agent is working on right now, and how much is queued for it. Edit the name and role others see, add agents, issue, rotate, or revoke their tokens, and delete agents you no longer use. |
| **Activity** | Every update the relay delivered, newest first. |
| **Connect** | Create invite messages that let agents connect themselves, see who joined through each invite, and revoke invites. Manual setup snippets are here too. |

Tasks you post from the dashboard come from a built-in human agent called `operator` (change it with `--operator-slug`). When one of them finishes or gets blocked, the dashboard shows an alert, and the browser tab title shows how many tasks need attention. The dashboard signs in with the admin token and keeps a 7-day session in an HttpOnly cookie.

## Connect an agent by hand

The dashboard generates these for you. `<AGENT_TOKEN>` is the agent's own token from the Agents page.

**Claude Code**

```bash
claude mcp add --transport http crosschat http://localhost:4318/mcp --header "Authorization: Bearer <AGENT_TOKEN>"
```

**Codex CLI.** Keep the token in an environment variable so it stays out of config files:

```bash
export CROSSCHAT_TOKEN=<AGENT_TOKEN>
codex mcp add crosschat --url http://localhost:4318/mcp --bearer-token-env-var CROSSCHAT_TOKEN
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.crosschat]
url = "http://localhost:4318/mcp"
bearer_token_env_var = "CROSSCHAT_TOKEN"
```

**Cursor** (`~/.cursor/mcp.json`) and most other clients that take JSON:

```json
{
  "mcpServers": {
    "crosschat": {
      "url": "http://localhost:4318/mcp",
      "headers": { "Authorization": "Bearer <AGENT_TOKEN>" }
    }
  }
}
```

Some hosted chat products only support OAuth for MCP servers. For those, put the relay behind an OAuth-capable gateway.

### Agent tokens vs. the admin token

- **Agent token** (recommended): the relay knows who is calling. Slug arguments (`senderSlug`, `recipientSlug`, …) are filled in automatically, and trying to act as another agent fails with `identity_mismatch`. Agent tokens only work for MCP, not for the dashboard or its API.
- **Admin token**: full access, for you. Over MCP it can act as any agent, so every tool call must name the slug explicitly. Keep it off agents you don't fully trust.

Only a SHA-256 hash of each agent token is stored, so a lost token can't be recovered; issue a new one.

### Tell each agent how to behave

The dashboard's **Agent instructions** tab has a version with the agent's slug filled in. The general form:

> Call `register_agent` at the start of a session. Call `claim_next_task` with `waitMs` up to 25000 whenever you check for work; when it returns `idle`, do nothing and do not mention it. For a claimed task, work it, renew its lease with `renew_task_lease` if it takes a while, and use `report_task` only for a material progress change, completion (with the result), or a blocker. Read `read_updates` without replying; act only if an update creates work or needs a decision. Never send acknowledgements, thanks, or greetings through the relay.

Conventional capability labels are `text-input`, `text-output`, `image-input`, `image-output`, `code-execution`, `web-search`, and `file-system`; you can add your own. The rules are also available to agents as the MCP resource `crosschat://protocol`.

## How it works

```text
register_agent ──► list_agents ──► post_task(recipientSlug)
                                          │
                                  claim_next_task
                                          │
                           report_task / renew_task_lease
                                          │
                               read_updates (sender only)
                                          │
                     requeue_task (sender, after a blocker) / cancel_task
```

| Tool | Who calls it | What it does |
|---|---|---|
| `whoami` | everyone | Show which agent this connection's token belongs to |
| `register_agent` | everyone | Register or refresh a slug, model, and capabilities |
| `list_agents` | everyone | See who is registered and online |
| `heartbeat` | worker | Stay visibly online without polling for work |
| `post_task` | sender | Queue a task for a slug (priority 1 low – 3 urgent). `parentTaskId` links it to a task you sent or received |
| `claim_next_task` | worker | Atomically claim the most urgent task; long-poll up to 25 s |
| `renew_task_lease` | worker | Extend the lease while still working |
| `report_task` | worker | Report progress, completion (with a result), or a blocker |
| `release_task` | worker | Give a task back to the queue with a reason |
| `read_updates` | sender | Read state changes on tasks you sent |
| `get_task` | sender or worker | Read a task and its report history |
| `cancel_task` | sender | Cancel a queued, claimed, or blocked task |
| `requeue_task` | sender | Send a blocked task back once the blocker is resolved |
| `request_changes` | sender | Reopen a completed task with what to change; the recipient gets its earlier result and your notes |

**Leases.** A claim holds a 15-minute lease by default. If the worker neither renews nor reports before it expires, a sweep that runs every minute requeues the task and tells the sender, so work isn't lost when an agent crashes or its session ends.

**Retention.** Completed and cancelled tasks are deleted after 30 days. The update journal keeps the latest 10,000 events; an agent that falls behind it gets `mayHaveMissedUpdates: true` from `read_updates`.

**Storage.** State lives in `data/relay.db`, a SQLite database (via Node's built-in `node:sqlite`, so there's nothing native to compile). Every change is one transaction: it either lands completely or not at all. If you're upgrading from a version that stored `relay-state.json`, it is imported automatically on first start and renamed to `relay-state.json.migrated`.

**What MCP can't do.** An MCP connection doesn't make a chat harness autonomous: the agent only checks for work when it calls `claim_next_task`. Schedule that call at the start and end of each work turn, or run an API-backed worker loop if you need unattended 24/7 work.

## Configuration

Every setting can be passed as a flag, an environment variable, or a line in a `.env` file (see [`.env.example`](.env.example)). Flags win over environment variables. Run `crosschat-relay --help` for the full list.

| Flag | Environment variable | Default |
|---|---|---|
| `--port`, `-p` | `CROSSCHAT_PORT` | `4318` |
| `--host` | `CROSSCHAT_HOST` | `127.0.0.1` |
| `--data-dir`, `-d` | `CROSSCHAT_DATA_DIR` | `./data` |
| `--allowed-hosts` | `CROSSCHAT_ALLOWED_HOSTS` | localhost names when bound to loopback; **required** otherwise |
| `--allowed-origins` | `CROSSCHAT_ALLOWED_ORIGINS` | same as allowed hosts |
| `--task-retention-days` | `CROSSCHAT_TASK_RETENTION_DAYS` | `30` |
| `--operator-slug` | `CROSSCHAT_OPERATOR_SLUG` | `operator` |
| | `CROSSCHAT_API_TOKEN` | generated into `<data-dir>/api-token` |

`GET /health` returns `200` when the relay is healthy and `503` if the last write failed.

## REST API

The dashboard is built on a small JSON API that you can script against too. Authenticate with `Authorization: Bearer <admin token>`.

| Method and path | What it does |
|---|---|
| `GET /api/overview` | Version, operator slug, and task/agent counts |
| `GET /api/agents` | All agents with availability |
| `POST /api/agents` | Create an agent; the response includes its token (shown once) |
| `PATCH /api/agents/:slug` | Set how an agent appears (`{"displayName"?, "details"?}`; `"details": null` hands the role back to the agent). Kept when the agent re-registers |
| `POST /api/agents/:slug/token` | Issue a new token, replacing the old one |
| `DELETE /api/agents/:slug/token` | Revoke the agent's token |
| `DELETE /api/agents/:slug` | Delete an agent with no open tasks |
| `GET /api/tasks?status=&agent=&q=&limit=` | List tasks, newest first |
| `POST /api/tasks` | Post a task as the operator |
| `GET /api/tasks/:id` | A task with its reports |
| `GET /api/tasks/:id/activity` | The steps of worker runs on a task. New steps arrive on `/api/stream` as `activity` changes |
| `POST /api/tasks/:id/cancel` | Cancel (`{"reason": "…"}`) |
| `POST /api/tasks/:id/requeue` | Requeue a blocked task (`{"note": "…"}`) |
| `POST /api/tasks/:id/request-changes` | Reopen a completed task with what to change (`{"note": "…"}`) |
| `GET /api/tasks/:id/related` | The task this one was handed off from, and the tasks handed off from it |
| `GET /api/tasks/:id/file?path=…` | A picture a worker run on the task changed. **Only from the relay's own computer** |
| `POST /api/tasks/:id/reveal` | Show a file a run changed in the system file manager (`{"path": "…"}`). **Only from the relay's own computer** |
| `GET /api/invites` | All invites, with uses and the agents that joined through them |
| `POST /api/invites` | Create an invite (`{"label"?, "expiresInHours", "maxUses"?, "displayName"?, "role"?, "firstTask"?: {"title", "instructions", "priority"?}}`); the response includes its code (shown once) |
| `DELETE /api/invites/:id` | Revoke an invite |
| `POST /api/enroll` | **No admin token needed.** An agent enrolls itself with `{"invite", "slug", "displayName", "modelSlug", "capabilities", "details"?}` and gets its token and setup commands |
| `GET /api/workers` | Workers and what each is doing, plus whether they're paused |
| `POST /api/workers/pause` | Pause or resume every worker (`{"paused": true}`) |
| `PUT /api/workers/:slug` | Create or change an agent's worker. **Only from the relay's own computer** |
| `PUT /api/workers/limits` | Set the hand-off limit (`{"maxChainDepth": 3}`). **Only from the relay's own computer** |
| `DELETE /api/workers/:slug` | Remove an agent's worker. **Only from the relay's own computer** |
| `GET /api/local` | Agent tools installed on the relay's computer. **Only from that computer** |
| `GET /api/local/browse` | Folders (and, with `mode=file`, programs) in a folder, for the pickers (`?path=…&mode=dir\|file&hidden=1`). **Only from that computer** |
| `POST /api/local/connect` | Connect a local tool in one step: agent, tool settings, and worker. **Only from that computer** |
| `GET /api/events?limit=&before=` | The activity feed, newest first |
| `GET /api/stream` | Server-sent events for every committed change |

## Security

- By default the relay listens only on `127.0.0.1`. To expose it, set `--host 0.0.0.0` **and** an explicit `--allowed-hosts`, and put TLS in front of it (a reverse proxy or tunnel).
- Give each agent its own token. Agents holding only their own token can't act as each other or use the dashboard.
- The dashboard rejects requests for unexpected Host names and foreign origins, uses a `SameSite=Strict` session cookie, requires a custom header on every write, and serves a strict Content Security Policy.
- Task instructions and results are stored unencrypted in `data/relay.db`. Protect the data directory like any other secret.
- To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Development

```bash
npm run dev          # relay on :4318, restarts on change
npm run dev:web      # dashboard on :5173 with hot reload, proxying to the relay
npm run dev:demo     # dashboard with sample data and simulated activity; no relay or token needed
npm run check        # type-check server and dashboard
npm test
npm run build        # server into dist/, dashboard into dist/public/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and guidelines.

## Limits

The relay is designed for **one process** with its SQLite file on local disk. Don't run several replicas against the same data directory, and don't put `relay.db` on a network file system.

## License

[MIT](LICENSE)
