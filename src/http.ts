import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';

import { createApiHandler, sendJson } from './api.js';
import { Authenticator, toAuthInfo } from './auth.js';
import { createRelayMcpServer } from './mcp.js';
import type { RelayStore } from './store.js';
import type { WorkerManager } from './worker.js';

export interface RelayHttpOptions {
  workers?: WorkerManager;
  /** The relay's MCP endpoint as seen by harnesses on this computer. */
  localMcpUrl?: string;
  store: RelayStore;
  /** The owner's token: full access to MCP, the REST API, and the dashboard. */
  token: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  /** The human agent the dashboard acts as. */
  operatorSlug?: string;
  /** Where the built dashboard lives; defaults to dist/public next to this file. */
  publicDirectory?: string;
}

const DEFAULT_PUBLIC_DIRECTORY = fileURLToPath(new URL('./public/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const DASHBOARD_SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

export function createRelayHttpServer({
  store,
  token,
  allowedHosts,
  allowedOrigins,
  operatorSlug = 'operator',
  publicDirectory = DEFAULT_PUBLIC_DIRECTORY,
  workers,
  localMcpUrl,
}: RelayHttpOptions): Server {
  const auth = new Authenticator(token, store);
  const handleApi = createApiHandler({ store, auth, operatorSlug, ...(workers ? { workers } : {}), ...(localMcpUrl ? { localMcpUrl } : {}) });

  // The default SSE response mode keeps long-polls alive through proxies.
  const mcp = createMcpHandler(() => createRelayMcpServer(store), {
    onerror: (error) => console.error('[mcp]', error.message),
  });

  const mcpNodeHandler = toNodeHandler({
    async fetch(request) {
      const guard = hostHeaderValidationResponse(request, allowedHosts) ?? originValidationResponse(request, allowedOrigins);
      if (guard) return withSecurityHeaders(guard, request, allowedOrigins);
      const principal = auth.fromBearer(request);
      if (!principal) return withSecurityHeaders(unauthorized(), request, allowedOrigins);
      const response = await mcp.fetch(request, { authInfo: toAuthInfo(principal, 'redacted') });
      return withSecurityHeaders(response, request, allowedOrigins);
    },
  });

  return createServer(async (request, response) => {
    try {
      // Never derive the base from the client's Host header: a malformed value
      // makes URL parsing throw. Host validation happens per route below.
      const url = new URL(request.url ?? '/', 'http://localhost');
      const { pathname } = url;

      if (pathname === '/health') {
        const healthy = store.healthy;
        sendJson(response, healthy ? 200 : 503, { status: healthy ? 'ok' : 'degraded' });
        return;
      }

      if (pathname === '/mcp') {
        if (request.method === 'OPTIONS') {
          const origin = request.headers.origin;
          if (origin && !isAllowedOrigin(origin, allowedOrigins)) {
            sendJson(response, 403, { error: 'origin_not_allowed' });
            return;
          }
          response.writeHead(204, corsHeaders(origin ?? null, allowedOrigins));
          response.end();
          return;
        }
        await mcpNodeHandler(request, response);
        return;
      }

      // The dashboard and its API use cookies, so both reject requests for
      // unexpected Host names (DNS rebinding) and foreign origins.
      if (!isAllowedHost(request.headers.host, allowedHosts)) {
        sendJson(response, 403, { error: 'host_not_allowed' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && !isAllowedOrigin(origin, allowedOrigins)) {
        sendJson(response, 403, { error: 'origin_not_allowed' });
        return;
      }

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }

      if (request.method === 'GET' || request.method === 'HEAD') {
        serveDashboard(request, response, pathname, publicDirectory);
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    } catch (error: unknown) {
      console.error('[http] request failed:', error);
      if (!response.headersSent) sendJson(response, 400, { error: 'bad_request' });
      else response.destroy();
    }
  });
}

/** Serve the built single-page dashboard; unknown paths get index.html so client routes work. */
function serveDashboard(request: IncomingMessage, response: ServerResponse, pathname: string, root: string): void {
  const indexFile = join(root, 'index.html');
  if (!existsSync(indexFile)) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('The dashboard is not built. Run `npm run build` (or `npm run dev:web` during development).\n');
    return;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: 'bad_request' });
    return;
  }
  const candidate = normalize(join(root, decoded));
  const insideRoot = candidate === normalize(root) || candidate.startsWith(normalize(root).replace(/[\\/]?$/, sep));
  const isFile = insideRoot && existsSync(candidate) && statSync(candidate).isFile();
  const file = isFile ? candidate : indexFile;
  // Hashed build assets never change; the HTML must always be revalidated.
  const cacheControl = file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';

  response.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': cacheControl,
    ...DASHBOARD_SECURITY_HEADERS,
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: 'unauthorized', message: 'Send Authorization: Bearer <admin token or per-agent token>.' }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer realm="crosschat-relay"',
      },
    },
  );
}

function withSecurityHeaders(response: Response, request: Request, allowedOrigins: string[]): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  for (const [name, value] of Object.entries(corsHeaders(request.headers.get('origin'), allowedOrigins))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(origin: string | null, allowedOrigins: string[]): Record<string, string> {
  if (!origin || !isAllowedOrigin(origin, allowedOrigins)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    vary: 'Origin',
  };
}

function isAllowedOrigin(origin: string, hosts: string[]): boolean {
  try {
    return hosts.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isAllowedHost(hostHeader: string | undefined, hosts: string[]): boolean {
  if (!hostHeader) return false;
  try {
    return hosts.includes(new URL(`http://${hostHeader}`).hostname.toLowerCase());
  } catch {
    return false;
  }
}
