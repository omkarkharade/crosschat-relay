# Contributing

Thanks for helping improve Crosschat Relay!

## Development setup

You need Node.js 22.16 or newer.

```bash
npm install
npm run dev      # starts the relay on :4318 and restarts it on changes
npm run dev:web  # in a second terminal: the dashboard on :5173 with hot reload
```

`dev:web` proxies `/api` and `/mcp` to the relay on port 4318 (override with `CROSSCHAT_DEV_RELAY`). For UI work you can skip the relay entirely: `npm run dev:demo` runs the dashboard against sample data with simulated live activity (`web/src/demo.ts`, never included in production builds).

Before opening a pull request, make sure these all pass:

```bash
npm run check    # type-check the server and the dashboard
npm test         # store and HTTP tests
npm run build    # server into dist/, dashboard into dist/public/
```

## Project layout

| Path | What it contains |
|---|---|
| `src/index.ts` | Command-line entry point: flags, environment, admin token, startup and shutdown |
| `src/http.ts` | HTTP server: routing, host/origin checks, MCP authentication, static dashboard, `/health` |
| `src/auth.ts` | Principals (admin or agent), bearer tokens, and dashboard sessions |
| `src/mcp.ts` | MCP tool and resource definitions |
| `src/api.ts` | The dashboard's REST API and live change stream |
| `src/store.ts` | The task ledger on SQLite: state transitions, tokens, long-polling, maintenance, migration |
| `src/schemas.ts` | Input validation shared by MCP and the REST API |
| `src/cli.ts` | Command-line entry: dispatches `service` and `open`, otherwise starts the relay |
| `src/service.ts`, `src/service-cli.ts` | The background service for Windows, macOS, and Linux, and its commands |
| `src/worker.ts` | Workers: run tasks with local harnesses, keep leases alive, report results |
| `src/snapshot.ts` | Compares a run's folders before and after, to list the files it changed |
| `src/files.ts` | Picture previews and "Show in folder" for files a run changed |
| `src/browse.ts` | Lists this computer's folders and programs for the dashboard's pickers |
| `src/activity.ts` | The live view of worker runs: parsers for harness event streams, and the recorder that stores the steps |
| `src/harnesses.ts` | Harness presets (headless flags, safety, connecting to the relay) and running commands without a shell |
| `web/` | The React dashboard (Vite) |
| `desktop/` | The Electron tray app. `npm start` runs it from source (after `npm run build` at the root); `npm run dist` builds installers, bundling the relay with `relay.vite.config.mjs` |
| `test/` | Vitest tests |

## Guidelines

- **Keep the relay a relay.** Features that add chatty, conversational traffic between agents (acknowledgements, free-form messaging) are out of scope.
- **State changes stay synchronous.** `node:sqlite` is synchronous, and each change in `RelayStore` runs inside `transact()` as one synchronous step. That is what makes it atomic without locks, so never `await` inside a transaction.
- **Schema changes need a migration.** Bump `SCHEMA_VERSION` in `src/store.ts` and migrate existing databases forward; people upgrade in place.
- **The dashboard only talks to `/api`.** Don't read the database or MCP from the browser, and send the `x-crosschat-request` header on writes (`web/src/api.ts` does this).
- **Add a test** for every bug fix and behaviour change. A test that fails without your change is the most convincing kind.
- **Update the docs.** If a change affects tools, flags, or behaviour, update `README.md` and add an entry under *Unreleased* in `CHANGELOG.md`.
- Match the existing code style: TypeScript strict mode, small functions, and comments that explain *why* rather than *what*.

## Reporting bugs and suggesting features

Use the issue templates. For security problems, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
