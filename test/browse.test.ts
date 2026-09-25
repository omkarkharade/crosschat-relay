import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { browse } from '../src/browse.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'crosschat-browse-'));
  directories.push(root);
  await mkdir(join(root, 'projects'));
  await mkdir(join(root, 'Assets'));
  await mkdir(join(root, '.hidden'));
  await writeFile(join(root, 'notes.txt'), 'x');
  await writeFile(join(root, 'agent.cjs'), 'x');
  const program = join(root, process.platform === 'win32' ? 'tool.exe' : 'tool');
  await writeFile(program, 'x');
  if (process.platform !== 'win32') await chmod(program, 0o755);
  return root;
}

describe('browsing this computer', () => {
  it('lists folders first, sorted, without hidden ones unless asked', async () => {
    const root = await tree();
    const result = await browse({ path: root, mode: 'dir' });
    expect(result.path).toBe(root);
    expect(result.parent).toBeTruthy();
    expect(result.entries.map((entry) => entry.name)).toEqual(['Assets', 'projects']);
    expect(result.entries[1]).toEqual({ name: 'projects', path: join(root, 'projects'), kind: 'dir' });
    expect((await browse({ path: root, mode: 'dir', hidden: true })).entries.map((entry) => entry.name)).toContain('.hidden');
  });

  it('shows programs, not other files, when choosing a program', async () => {
    const root = await tree();
    const names = (await browse({ path: root, mode: 'file' })).entries.map((entry) => `${entry.kind}:${entry.name}`);
    expect(names).toEqual(['dir:Assets', 'dir:projects', 'file:agent.cjs', `file:${process.platform === 'win32' ? 'tool.exe' : 'tool'}`]);
  });

  it('starts at home and offers places to jump to', async () => {
    const result = await browse({ mode: 'dir' });
    expect(result.path).toBe(homedir());
    expect(result.places[0]).toEqual({ name: 'Home', path: homedir() });
  });

  it('explains missing folders, files, and relative paths', async () => {
    const root = await tree();
    await expect(browse({ path: join(root, 'nope'), mode: 'dir' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(browse({ path: join(root, 'notes.txt'), mode: 'dir' })).rejects.toMatchObject({ code: 'not_a_folder' });
    await expect(browse({ path: 'projects', mode: 'dir' })).rejects.toMatchObject({ code: 'invalid_path' });
  });
});
