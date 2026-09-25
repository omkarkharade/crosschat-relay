import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChangedFile } from './activity.js';

/**
 * What a worker run changed on disk, found by listing its folders before and
 * after the run. This catches every file, including ones a harness writes
 * through scripts it runs, which its own event stream doesn't report.
 */

export interface Snapshot {
  files: Map<string, { size: number; modified: number }>;
  /** False when a folder was too big to list in time; the caller falls back to what the harness reported. */
  complete: boolean;
}

/** Folders that are large, generated, or not the work itself. */
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo', '.gradle', 'target']);
const MAX_FILES = 50_000;
const MAX_MS = 5_000;
const MAX_CHANGES = 500;

export async function snapshot(folders: string[]): Promise<Snapshot> {
  const files = new Map<string, { size: number; modified: number }>();
  const deadline = Date.now() + MAX_MS;
  const pending = [...new Set(folders)];
  let complete = true;
  while (pending.length > 0) {
    if (files.size >= MAX_FILES || Date.now() > deadline) {
      complete = false;
      break;
    }
    const folder = pending.pop()!;
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) pending.push(path);
      } else if (entry.isFile()) {
        const info = await stat(path).catch(() => undefined);
        if (info) files.set(path, { size: info.size, modified: info.mtimeMs });
      }
    }
  }
  return { files, complete };
}

/** Files added, changed, or deleted between two snapshots, most recent first. */
export function changes(before: Snapshot, after: Snapshot): ChangedFile[] {
  const result: Array<ChangedFile & { modified: number }> = [];
  for (const [path, file] of after.files) {
    const previous = before.files.get(path);
    if (!previous) result.push({ path, change: 'added', size: file.size, modified: file.modified });
    else if (previous.size !== file.size || previous.modified !== file.modified) result.push({ path, change: 'changed', size: file.size, modified: file.modified });
  }
  // A partial listing can't tell a deleted file from one it didn't reach.
  if (before.complete && after.complete) {
    for (const path of before.files.keys()) if (!after.files.has(path)) result.push({ path, change: 'deleted', modified: 0 });
  }
  return result
    .sort((a, b) => b.modified - a.modified)
    .slice(0, MAX_CHANGES)
    .map(({ modified: _modified, ...file }) => file);
}
