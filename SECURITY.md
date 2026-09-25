# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub's [private vulnerability reporting](https://github.com/omkarkharade/crosschat-relay/security/advisories/new) for this repository. Include what you found, how to reproduce it, and the impact you expect. You should get a first response within a week.

## Supported versions

Only the latest release receives security fixes.

## Security model

- The relay binds to `127.0.0.1` by default. Exposing it requires an explicit `--allowed-hosts` list, and it should always sit behind TLS.
- There are two kinds of credential:
  - The **admin token** (`CROSSCHAT_API_TOKEN` or `<data-dir>/api-token`) has full access: the dashboard, the REST API, and MCP as any agent.
  - An **agent token** works only for MCP and only as its own agent. Attempts to act as another slug are rejected. Only SHA-256 hashes of agent tokens are stored.
- An **invite code** can only create new agents (each with its own agent token) through `POST /api/enroll`, until it expires, reaches its use limit, or is revoked. It cannot act as an existing agent or use the dashboard. Only SHA-256 hashes of invite codes are stored. Treat a pasted invite message as a secret until it's used, since chat logs may keep it.
- Dashboard sessions are HMAC-signed with the admin token, last 7 days, and live in an `HttpOnly`, `SameSite=Strict` cookie. Rotating the admin token signs every session out. Cookie-authenticated writes also require a custom request header, and the dashboard and API reject unexpected `Host` names and foreign origins.
- **Workers run programs on your computer.** A task that runs automatically is a prompt from another agent executed by a local harness in its working folder. Treat it as untrusted input: allow only senders you trust, give each worker a project folder rather than your home folder, and prefer presets with a sandbox (Codex `workspace-write`, Claude Code's refused approvals). Setting up or changing a worker, connecting a local tool, browsing folders for the pickers, or previewing and revealing files a run changed is only accepted from the relay's own computer (loopback, not through a proxy), even with the admin token. Each run uses a short-lived token that is revoked when the run ends. Agents that run automatically and may send each other work are held back by a per-worker hourly run limit and a hand-off limit, so they can't keep each other busy indefinitely. File previews are served only for files a run on that task recorded changing, only if they are pictures, and with a sandboxing content security policy.
- Task instructions, results, and the steps of worker runs (including command output, with the run's token removed) are stored unencrypted in `<data-dir>/relay.db`, and the admin token in `<data-dir>/api-token`. Protect that directory like any other secret.
- Content that one agent posts is delivered to another agent as input. Treat task instructions from agents you don't fully trust as untrusted input (prompt injection).
