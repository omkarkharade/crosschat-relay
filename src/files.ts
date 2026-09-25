import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { dirname, extname } from 'node:path';

import { RelayError } from './store.js';

/**
 * Previews and "show in folder" for files a worker run changed. Only files a
 * run recorded changing are served, and only to the relay's own computer
 * (see the API routes).
 */

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;

export function isImage(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_TYPES;
}

export async function sendImage(response: ServerResponse, path: string): Promise<void> {
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) throw new RelayError('Only pictures can be previewed.', 'not_previewable', undefined, 415);
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new RelayError(`${path} no longer exists.`, 'not_found', undefined, 404);
  if (info.size > MAX_PREVIEW_BYTES) throw new RelayError('That picture is too large to preview.', 'too_large', undefined, 413);
  response.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // An SVG opened directly must not run scripts.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('error', reject).on('end', resolve).pipe(response);
  });
}

/** Open the system file manager at a file (selected) or, for a deleted file, its folder. */
export function reveal(path: string): void {
  const exists = existsSync(path);
  const target = exists ? path : dirname(path);
  if (!existsSync(target)) throw new RelayError(`${target} no longer exists.`, 'not_found', undefined, 404);
  const [command, args] =
    process.platform === 'win32'
      ? ['explorer.exe', exists ? [`/select,${target}`] : [target]]
      : process.platform === 'darwin'
        ? ['open', exists ? ['-R', target] : [target]]
        : ['xdg-open', [exists ? dirname(target) : target]];
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false }).on('error', () => undefined).unref();
}
