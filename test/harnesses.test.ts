import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectHarnesses, findPreset, replaceTomlTable, resolveInvocation, tomlString, type RunContext } from '../src/harnesses.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const context: RunContext = {
  workdir: '/work/game',
  promptFile: '/runs/t1/task.md',
  resultFile: '/runs/t1/result.md',
  mcpConfigFile: '/runs/t1/mcp.json',
  mcpUrl: 'http://localhost:4318/mcp',
  extraDirs: [],
};

describe('harness presets', () => {
  it('runs Claude Code headless with edits allowed, the relay wired in, and the prompt on stdin', () => {
    const spec = findPreset('claude-code')!.run!(context);
    expect(spec.promptOnStdin).toBe(true);
    expect(spec.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--mcp-config', '/runs/t1/mcp.json', '--allowedTools', 'mcp__crosschat-run']);
    expect(spec.relayServer).toBe('crosschat-run');
    expect(spec.events).toBe('claude-stream');
  });

  it('runs Codex in its workspace-write sandbox with this run’s token and the answer in a file', () => {
    const spec = findPreset('codex')!.run!(context);
    expect(spec.args.slice(0, 3)).toEqual(['exec', '--sandbox', 'workspace-write']);
    expect(spec.args).toContain('--output-last-message');
    expect(spec.args).toContain('mcp_servers.crosschat.url="http://localhost:4318/mcp"');
    expect(spec.args).toContain('mcp_servers.crosschat.bearer_token_env_var="CROSSCHAT_TOKEN"');
    expect(spec.args).toContain('mcp_servers.crosschat.default_tools_approval_mode="approve"');
    expect(spec.args.at(-1)).toBe('-');
    expect(spec.resultInFile).toBe(true);
    expect(spec.args).toContain('--json');
    expect(spec.events).toBe('codex-json');
  });

  it('runs ZCode on one prompt with the task attached, in edit mode rather than its yolo default', () => {
    const spec = findPreset('zcode')!.run!(context);
    expect(spec.args).toEqual(['--prompt', 'Complete the task described in the attached file.', '--attach', '/runs/t1/task.md', '--cwd', '/work/game', '--mode', 'edit']);
    expect(spec.relayTools).toBe(false);
  });

  it('runs Codewhale (DeepSeek) in its workspace-write sandbox with a relay config for this run only', () => {
    const spec = findPreset('codewhale')!.run!(context);
    expect(spec.args).toEqual(['exec', '--auto', '--sandbox', 'workspace-write', 'Complete the task described in this file:', '/runs/t1/task.md']);
    const file = spec.env!.DEEPSEEK_MCP_CONFIG!;
    expect(file).toBe(join('/runs/t1', 'codewhale-mcp.json'));
    // The run's token comes from the environment, so it is never written to disk.
    expect(JSON.parse(spec.files![file]!)).toEqual({ servers: { crosschat: { url: 'http://localhost:4318/mcp', bearer_token_env_var: 'CROSSCHAT_TOKEN' } } });
  });

  it('never puts the task text on the command line for any preset', () => {
    for (const harness of detectHarnesses()) {
      const spec = findPreset(harness.id)!.run?.(context);
      if (!spec) continue;
      expect(spec.args.join(' ')).not.toContain('MODE:');
      expect(spec.promptOnStdin || spec.args.includes('/runs/t1/task.md')).toBe(true);
    }
  });
});

describe('Codex config editing', () => {
  it('replaces the crosschat table and its subtables and keeps everything else', () => {
    const before = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.crosschat]',
      'url = "http://old/mcp"',
      'bearer_token_env_var = "CROSSCHAT_TOKEN"',
      '',
      '[mcp_servers.crosschat.env]',
      'X = "1"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
    ].join('\n');
    const after = replaceTomlTable(before, 'mcp_servers.crosschat', '[mcp_servers.crosschat]\nurl = "http://new/mcp"\n');
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(after).toContain('url = "http://new/mcp"');
    expect(after).not.toContain('http://old/mcp');
    expect(after).not.toContain('X = "1"');
  });

  it('appends the table when there is none', () => {
    expect(replaceTomlTable('', 't', '[t]\na = 1\n')).toBe('[t]\na = 1\n');
  });

  it('escapes TOML strings', () => {
    expect(tomlString('C:\\a "b"')).toBe('"C:\\\\a \\"b\\""');
  });
});

describe('starting commands without a shell', () => {
  it('leaves real programs alone', () => {
    expect(resolveInvocation('/usr/bin/claude', ['-p'])).toEqual({ file: '/usr/bin/claude', args: ['-p'] });
  });

  it('runs Node.js scripts (such as ZCode\'s CLI) with Node.js', () => {
    const invocation = resolveInvocation('/apps/zcode/zcode.cjs', ['--prompt', 'x']);
    expect(invocation.args).toEqual(['/apps/zcode/zcode.cjs', '--prompt', 'x']);
    expect(invocation.file).toMatch(/node(\.exe)?$|electron|crosschat/i);
  });

  it.runIf(process.platform === 'win32')('runs the Node.js script behind an npm .cmd wrapper', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosschat-shim-'));
    directories.push(directory);
    const shim = join(directory, 'tool.cmd');
    await writeFile(shim, '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\tool\\bin\\tool" %*\r\n');
    const invocation = resolveInvocation(shim, ['run', 'x']);
    expect(invocation.args).toEqual([join(directory, 'node_modules', 'tool', 'bin', 'tool'), 'run', 'x']);
    expect(invocation.file).toMatch(/node(\.exe)?$|\.exe$/i);
  });

  it.runIf(process.platform === 'win32')('refuses a .cmd it cannot see through', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crosschat-shim-'));
    directories.push(directory);
    const shim = join(directory, 'odd.cmd');
    await writeFile(shim, '@echo off\r\nsomething %1 %2\r\n');
    expect(() => resolveInvocation(shim, [])).toThrow(/Can't run/);
  });
});
