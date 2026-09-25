import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthInfo } from '@modelcontextprotocol/server';

import { RelayError, type RelayStore } from './store.js';

/**
 * Who is making a request.
 *
 * - `admin`: the owner, authenticated by the admin token or a dashboard
 *   session. Can act as any agent, so tool calls must name the slug.
 * - `agent`: an agent authenticated by its own token. It can act only as
 *   itself; slug arguments default to, and must match, its own slug.
 */
/** An agent principal from a worker run's token carries the task being run. */
export type Principal = { kind: 'admin' } | { kind: 'agent'; slug: string; runTaskId?: string };

const SESSION_COOKIE = 'crosschat_session';
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export class Authenticator {
  constructor(
    private readonly adminToken: string,
    private readonly store: RelayStore,
  ) {}

  /** Resolve an `Authorization: Bearer` header to a principal. */
  fromBearer(request: { headers: Headers }): Principal | undefined {
    const supplied = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!supplied) return undefined;
    if (constantTimeEquals(supplied, this.adminToken)) return { kind: 'admin' };
    const agent = this.store.resolveAgentToken(supplied);
    return agent ? { kind: 'agent', slug: agent.slug, ...(agent.runTaskId ? { runTaskId: agent.runTaskId } : {}) } : undefined;
  }

  /** Resolve the dashboard session cookie. Sessions always belong to the admin. */
  fromSession(request: { headers: Headers }): Principal | undefined {
    const value = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    if (!value) return undefined;
    const [expiresAt, signature] = value.split('.');
    if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return undefined;
    return constantTimeEquals(signature, this.sign(expiresAt)) ? { kind: 'admin' } : undefined;
  }

  /** Check a pasted admin token and, if it matches, return a Set-Cookie header for a new session. */
  createSession(suppliedToken: string, secure: boolean): string | undefined {
    if (!constantTimeEquals(suppliedToken.trim(), this.adminToken)) return undefined;
    const expiresAt = String(Date.now() + SESSION_LIFETIME_MS);
    return serializeCookie(`${expiresAt}.${this.sign(expiresAt)}`, SESSION_LIFETIME_MS / 1000, secure);
  }

  clearSession(secure: boolean): string {
    return serializeCookie('', 0, secure);
  }

  // Signing with the admin token means rotating it signs every session out.
  private sign(expiresAt: string): string {
    return createHmac('sha256', this.adminToken).update(`session:${expiresAt}`).digest('base64url');
  }
}

export function toAuthInfo(principal: Principal, token: string): AuthInfo {
  return {
    token,
    clientId: principal.kind === 'agent' ? principal.slug : 'admin',
    scopes: [],
    extra: { principal },
  };
}

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal {
  const principal = authInfo?.extra?.principal as Principal | undefined;
  if (!principal) throw new RelayError('The request is not authenticated.', 'unauthorized', undefined, 401);
  return principal;
}

/**
 * Work out which agent a tool call acts as. Agents act as themselves; the
 * admin must say which agent it is acting as.
 */
export function actingSlug(principal: Principal, supplied: string | undefined, field: string): string {
  if (principal.kind === 'agent') {
    if (supplied !== undefined && supplied !== principal.slug) {
      throw new RelayError(
        `This token belongs to “${principal.slug}”; it cannot act as “${supplied}”. Omit ${field} or use your own slug.`,
        'identity_mismatch',
        { tokenSlug: principal.slug, [field]: supplied },
        403,
      );
    }
    return principal.slug;
  }
  if (supplied === undefined) {
    throw new RelayError(`${field} is required when using the admin token.`, 'slug_required', { field }, 400);
  }
  return supplied;
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function serializeCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  // SameSite=Strict keeps other sites from riding on the session (CSRF).
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
