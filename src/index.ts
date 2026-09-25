#!/usr/bin/env node
import './quiet-sqlite-warning.js';

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { format, parseArgs } from 'node:util';

import { createRelayHttpServer } from './http.js';
import { pidFilePath } from './service.js';
import { RelayStore } from './store.js';
import { WorkerManager } from './worker.js';
import { VERSION } from './version.js';

const HELP = `crosschat-relay ${VERSION}
A durable MCP inbox/outbox for coordinating AI agents.

Usage: crosschat-relay [options]            Run the relay in this terminal
       crosschat-relay service <command>  Run it in the background (install, status, stop, ...)
       crosschat-relay open               Open the dashboard in your browser

Options:
  -p, --port <port>               Port to listen on (default 4318)
      --host <host>               Interface to bind (default 127.0.0.1)
  -d, --data-dir <dir>            Where the ledger and token live (default ./data)
      --allowed-hosts <list>      Comma-separated Host names to accept (required beyond localhost)
      --allowed-origins <list>    Comma-separated browser origins to accept (default: allowed hosts)
      --task-retention-days <n>   Delete finished tasks after n days (default 30)
      --operator-slug <slug>      Agent slug the dashboard posts tasks as (default operator)
      --log-file <path>           Append log output to a file instead of the terminal
  -v, --version                   Print the version
  -h, --help                      Print this help

Every option can also be set with an environment variable (CROSSCHAT_PORT,
CROSSCHAT_HOST, CROSSCHAT_DATA_DIR, CROSSCHAT_ALLOWED_HOSTS,
CROSSCHAT_ALLOWED_ORIGINS, CROSSCHAT_TASK_RETENTION_DAYS,
CROSSCHAT_OPERATOR_SLUG) or in a .env file in the working directory. Flags win
over environment variables.

The admin token comes from CROSSCHAT_API_TOKEN. If it is not set, a token is
generated on first start and saved to <data-dir>/api-token. Sign in to the
dashboard (http://localhost:4318/ by default) with it, and issue each agent
its own token there.`;

const { values: flags } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    'data-dir': { type: 'string', short: 'd' },
    'allowed-hosts': { type: 'string' },
    'allowed-origins': { type: 'string' },
    'task-retention-days': { type: 'string' },
    'operator-slug': { type: 'string' },
    'log-file': { type: 'string' },
    version: { type: 'boolean', short: 'v' },
    help: { type: 'boolean', short: 'h' },
  },
  strict: true,
});

if (flags.help) {
  console.log(HELP);
  process.exit(0);
}
if (flags.version) {
  console.log(VERSION);
  process.exit(0);
}

if (flags['log-file']) logToFile(resolve(flags['log-file']));

// Values already in the environment take precedence over the .env file.
if (existsSync('.env')) process.loadEnvFile('.env');

const setting = (flag: string | undefined, variable: string) => flag ?? process.env[variable];

const port = parsePort(setting(flags.port, 'CROSSCHAT_PORT') ?? '4318');
const host = setting(flags.host, 'CROSSCHAT_HOST') ?? '127.0.0.1';
const dataDirectory = resolve(setting(flags['data-dir'], 'CROSSCHAT_DATA_DIR') ?? './data');
const taskRetentionDays = parsePositiveNumber(
  'CROSSCHAT_TASK_RETENTION_DAYS',
  setting(flags['task-retention-days'], 'CROSSCHAT_TASK_RETENTION_DAYS') ?? '30',
);
const localHostnames = ['localhost', '127.0.0.1', '[::1]'];
const isLoopbackBind = host === '127.0.0.1' || host === '::1' || host === 'localhost';
const allowedHosts = requiredList(
  'CROSSCHAT_ALLOWED_HOSTS',
  setting(flags['allowed-hosts'], 'CROSSCHAT_ALLOWED_HOSTS'),
  isLoopbackBind ? localHostnames : undefined,
);
// Harnesses and workers on this computer always reach the relay as localhost.
for (const name of localHostnames) if (!allowedHosts.includes(name)) allowedHosts.push(name);
const allowedOrigins = parseList(setting(flags['allowed-origins'], 'CROSSCHAT_ALLOWED_ORIGINS')) ?? allowedHosts;

const operatorSlug = (setting(flags['operator-slug'], 'CROSSCHAT_OPERATOR_SLUG') ?? 'operator').trim().toLowerCase();

const { token, source: tokenSource } = await resolveToken(dataDirectory);

const store = new RelayStore(dataDirectory, { taskRetentionMs: taskRetentionDays * 24 * 60 * 60 * 1000 });
// Fail at startup, not on the first request, if the ledger cannot be read.
await store.init();
// Lets `crosschat-relay service stop` and status find this process.
writeFileSync(pidFilePath(dataDirectory), String(process.pid));
process.on('exit', () => rmSync(pidFilePath(dataDirectory), { force: true }));
await store.ensureOperator(operatorSlug);
store.startMaintenance(60_000);

const localMcpUrl = `http://localhost:${port}/mcp`;
// Run files live with this relay's data, so a restart finds and cleans up only its own interrupted runs.
const workers = new WorkerManager(store, { mcpUrl: localMcpUrl, runDirectory: join(dataDirectory, 'runs') });

const httpServer = createRelayHttpServer({ store, token, allowedHosts, allowedOrigins, operatorSlug, workers, localMcpUrl });

httpServer.listen(port, host, () => {
  // Harnesses started by workers reach the relay over HTTP, so start workers once it is listening.
  workers.start().catch((error: unknown) => console.error('[worker] could not start workers:', error));
  const displayHost = isLoopbackBind ? 'localhost' : host;
  const origin = `http://${displayHost}:${port}`;
  console.log(`Crosschat relay ${VERSION}`);
  console.log(`  Dashboard:  ${origin}/`);
  console.log(`  MCP:        ${origin}/mcp`);
  console.log(`  Data:       ${dataDirectory}`);
  if (tokenSource === 'generated') {
    if (flags['log-file']) {
      // Never write the secret into a log file; point to where it is instead.
      console.log(`Generated an admin token and saved it to ${join(dataDirectory, 'api-token')}.`);
    } else {
      console.log(`\nGenerated an admin token and saved it to ${join(dataDirectory, 'api-token')}:\n`);
      console.log(`  ${token}\n`);
    }
    console.log('Sign in to the dashboard with it, then create a token for each agent under Agents.');
  } else if (tokenSource === 'file') {
    console.log(`  Admin token: ${join(dataDirectory, 'api-token')}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    httpServer.close(() => process.exit(0));
    // Let woken long-polls answer, close the database, then drop the remaining
    // connections (idle keep-alives and dashboard streams).
    void workers
      .stop()
      .then(() => store.close())
      .then(() => httpServer.closeAllConnections());
  });
}

async function resolveToken(directory: string): Promise<{ token: string; source: 'environment' | 'file' | 'generated' }> {
  const fromEnvironment = process.env.CROSSCHAT_API_TOKEN?.trim();
  if (fromEnvironment) return { token: fromEnvironment, source: 'environment' };

  const tokenFile = join(directory, 'api-token');
  try {
    const fromFile = (await readFile(tokenFile, 'utf8')).trim();
    if (fromFile) return { token: fromFile, source: 'file' };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const generated = randomBytes(32).toString('base64url');
  await mkdir(directory, { recursive: true });
  // 'wx' refuses to overwrite a token another process created meanwhile.
  await writeFile(tokenFile, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return { token: generated, source: 'generated' };
}

/** Send console output to a file (used by the background service). Rotates once past 5 MB. */
function logToFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (statSync(path).size > 5 * 1024 * 1024) renameSync(path, `${path}.1`);
  } catch {
    // No log yet.
  }
  const write = (level: string) => (...args: unknown[]) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${level} ${format(...args)}\n`);
    } catch {
      // Never let logging take the relay down.
    }
  };
  console.log = write('info');
  console.info = write('info');
  console.warn = write('warn');
  console.error = write('error');
}

function parseList(supplied: string | undefined): string[] | undefined {
  if (!supplied) return undefined;
  return supplied
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function requiredList(name: string, supplied: string | undefined, fallback?: string[]): string[] {
  const values = parseList(supplied) ?? fallback;
  if (!values || values.length === 0) {
    throw new Error(`${name} (or --allowed-hosts) is required when binding beyond localhost (for example, relay.example.com).`);
  }
  return values;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('The port must be a valid TCP port (1-65535).');
  return port;
}

function parsePositiveNumber(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}
