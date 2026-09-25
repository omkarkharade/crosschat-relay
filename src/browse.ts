import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { RelayError } from './store.js';

/**
 * Folder and program browsing for the dashboard's pickers. A browser can't
 * hand a web page the full path of a folder the user picks, so the relay
 * lists this computer's folders itself. Only reachable from the relay's own
 * computer (see the API route).
 */

export interface BrowseEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
}

export interface BrowseResult {
  path: string;
  parent?: string;
  entries: BrowseEntry[];
  /** Places to jump to: home, common folders, and drives or the filesystem root. */
  places: Array<{ name: string; path: string }>;
  /** Entries left out because the folder is very large. */
  truncated: boolean;
}

const MAX_ENTRIES = 3000;
const WINDOWS_PROGRAM = /\.(exe|cmd|bat|com)$/i;
const SCRIPT = /\.(js|cjs|mjs)$/i;

export async function browse(options: { path?: string; mode: 'dir' | 'file'; hidden?: boolean }): Promise<BrowseResult> {
  const path = resolve(options.path?.trim() || homedir());
  if (options.path && !isAbsolute(options.path.trim())) throw new RelayError('Give a full path.', 'invalid_path', undefined, 400);

  let names: import('node:fs').Dirent[];
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new RelayError(`${path} is not a folder.`, 'not_a_folder', undefined, 400);
    names = await readdir(path, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof RelayError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new RelayError(`${path} doesn't exist.`, 'not_found', undefined, 404);
    if (code === 'EACCES' || code === 'EPERM') throw new RelayError(`You don't have access to ${path}.`, 'no_access', undefined, 403);
    throw error;
  }

  const entries: BrowseEntry[] = [];
  for (const entry of names) {
    if (!options.hidden && entry.name.startsWith('.')) continue;
    const full = join(path, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const target = await stat(full).catch(() => undefined);
      isDirectory = Boolean(target?.isDirectory());
      isFile = Boolean(target?.isFile());
    }
    if (isDirectory) entries.push({ name: entry.name, path: full, kind: 'dir' });
    else if (isFile && options.mode === 'file' && (await isProgram(full, entry.name))) entries.push({ name: entry.name, path: full, kind: 'file' });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.kind === 'dir' ? -1 : 1));

  const parent = dirname(path);
  return {
    path,
    ...(parent !== path ? { parent } : {}),
    entries: entries.slice(0, MAX_ENTRIES),
    places: places(),
    truncated: entries.length > MAX_ENTRIES,
  };
}

/** Files a worker can start: programs, Windows wrappers, and Node.js scripts. */
async function isProgram(path: string, name: string): Promise<boolean> {
  if (SCRIPT.test(name)) return true;
  if (process.platform === 'win32') return WINDOWS_PROGRAM.test(name);
  const info = await stat(path).catch(() => undefined);
  return Boolean(info && info.mode & 0o111);
}

function places(): Array<{ name: string; path: string }> {
  const home = homedir();
  const list = [{ name: 'Home', path: home }];
  // Windows often keeps Desktop and Documents in OneDrive.
  const bases = [home, ...(process.platform === 'win32' ? [process.env.OneDrive ?? join(home, 'OneDrive')] : [])];
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const path = bases.map((base) => join(base, name)).find((candidate) => existsSync(candidate));
    if (path) list.push({ name, path });
  }
  if (process.platform === 'win32') {
    for (let letter = 67; letter <= 90; letter += 1) {
      const drive = `${String.fromCharCode(letter)}:\\`;
      if (existsSync(drive)) list.push({ name: drive, path: drive });
    }
  } else {
    list.push({ name: 'Computer', path: parse(home).root });
    if (process.platform === 'darwin' && existsSync('/Applications')) list.push({ name: 'Applications', path: '/Applications' });
  }
  return list;
}
