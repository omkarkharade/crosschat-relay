import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { EventFormat } from './activity.js';

/**
 * What Crosschat knows about agent harnesses (command-line AI agents). A
 * worker can run any harness through a custom command; presets add the right
 * headless flags, safe defaults, and relay wiring for well-known ones, and
 * know how to connect the harness to the relay for interactive use.
 */

const run = promisify(execFile);

export interface RunContext {
  workdir: string;
  /** The task prompt, written to a file for harnesses that read files. */
  promptFile: string;
  /** Where the harness may write its final answer. */
  resultFile: string;
  /** A Claude-style MCP config file pointing at the relay with this run's token. */
  mcpConfigFile: string;
  mcpUrl: string;
  /** More folders the harness may read and change. */
  extraDirs: string[];
}

export interface RunSpec {
  args: string[];
  /** Send the prompt on standard input. */
  promptOnStdin: boolean;
  /** Read the answer from RunContext.resultFile instead of standard output. */
  resultInFile?: boolean;
  env?: Record<string, string>;
  /** Whether the harness gets the relay's tools during the run. */
  relayTools: boolean;
  /** The MCP server name the relay's tools appear under in this run. */
  relayServer?: string;
  /** Standard output is a stream of structured events in this format (for the live view); otherwise plain text. */
  events?: EventFormat;
  /** Extra files the run needs (path to content), written before it starts. */
  files?: Record<string, string>;
}

/**
 * The name of the relay server a worker injects into a run. It is unique on
 * purpose: users often have their own entry for the relay under another name,
 * which a run's permissions don't cover.
 */
export const RUN_SERVER = 'crosschat-run';

export interface ConnectContext {
  mcpUrl: string;
  token: string;
  command: string;
}

export interface ConnectResult {
  configured: boolean;
  message: string;
  /** For manual setup: the file to edit and what to put in it. */
  file?: string;
  snippet?: string;
}

export interface HarnessPreset {
  id: string;
  name: string;
  /** Executable names to look for on PATH. */
  binaries: string[];
  /** Other places the harness is commonly installed. */
  knownLocations?: () => string[];
  /** A caveat about a particular install, shown when connecting. */
  noteFor?: (path: string) => string | undefined;
  /** How a worker runs one task headless. Absent for harnesses that only connect. */
  run?: (context: RunContext) => RunSpec;
  /** Whether runs can be given folders besides the working folder. */
  extraDirs?: boolean;
  /** What the worker's defaults allow the harness to do, in plain words. */
  safety?: string;
  /** Connect the harness to the relay for interactive use. */
  connect: (context: ConnectContext) => Promise<ConnectResult>;
}

const home = () => homedir();

export const PRESETS: HarnessPreset[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    binaries: ['claude'],
    extraDirs: true,
    knownLocations: () => [join(home(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'), join(home(), '.claude', 'local', 'claude')],
    run: (context) => ({
      args: [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        // Edits inside the working folder are allowed; anything that would need approval is refused.
        '--permission-mode',
        'acceptEdits',
        '--mcp-config',
        context.mcpConfigFile,
        '--allowedTools',
        `mcp__${RUN_SERVER}`,
        ...context.extraDirs.flatMap((dir) => ['--add-dir', dir]),
      ],
      promptOnStdin: true,
      relayTools: true,
      relayServer: RUN_SERVER,
      events: 'claude-stream',
    }),
    safety: 'Can read and edit files in the working folder. Shell commands and other tools that need approval are refused.',
    connect: async ({ mcpUrl, token, command }) => {
      await run(command, ['mcp', 'remove', 'crosschat', '--scope', 'user']).catch(() => undefined);
      await run(command, ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'crosschat', mcpUrl, '--header', `Authorization: Bearer ${token}`]);
      return { configured: true, message: 'Added the relay to Claude Code for your user (claude mcp add --scope user). Restart open Claude Code sessions to load it.' };
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    binaries: ['codex'],
    extraDirs: true,
    knownLocations: () => [join(home(), '.codex', '.sandbox-bin', process.platform === 'win32' ? 'codex.exe' : 'codex')],
    // The desktop app keeps a private copy of the CLI without its helper programs.
    noteFor: (path) =>
      /[\\/]\.sandbox-bin[\\/]/.test(path)
        ? "This is the Codex desktop app's internal copy, which lacks helper programs: tasks that need shell commands can fail. Install the Codex CLI (npm install -g @openai/codex) for reliable automatic runs."
        : undefined,
    run: (context) => ({
      args: [
        'exec',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '--cd',
        context.workdir,
        // The sandbox allows writing to these as well as the working folder.
        ...context.extraDirs.flatMap((dir) => ['--add-dir', dir]),
        '--output-last-message',
        context.resultFile,
        '--json',
        '-c',
        `mcp_servers.crosschat.url=${tomlString(context.mcpUrl)}`,
        '-c',
        'mcp_servers.crosschat.bearer_token_env_var="CROSSCHAT_TOKEN"',
        // Drop any static token from the user's config so this run's token is used.
        '-c',
        'mcp_servers.crosschat.http_headers={}',
        // Headless runs refuse anything that needs approval; the relay's own tools are approved up front.
        '-c',
        'mcp_servers.crosschat.default_tools_approval_mode="approve"',
        '-',
      ],
      promptOnStdin: true,
      resultInFile: true,
      relayTools: true,
      relayServer: 'crosschat',
      events: 'codex-json',
    }),
    safety: 'Runs in the Codex workspace-write sandbox: it can change files in the working folder but not elsewhere.',
    connect: async ({ mcpUrl, token }) => {
      const file = join(home(), '.codex', 'config.toml');
      const section = `[mcp_servers.crosschat]\nurl = ${tomlString(mcpUrl)}\nhttp_headers = { Authorization = ${tomlString(`Bearer ${token}`)} }\n`;
      const current = existsSync(file) ? await readFile(file, 'utf8') : '';
      if (current) await copyFile(file, `${file}.bak`);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, replaceTomlTable(current, 'mcp_servers.crosschat', section));
      return {
        configured: true,
        file,
        message: `Set the relay in ${file} (backup: config.toml.bak). Restart Codex to load it.`,
      };
    },
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    binaries: ['gemini'],
    extraDirs: true,
    run: (context) => ({
      // A piped prompt is prepended to -p; auto_edit approves file edits only.
      args: [
        '-p',
        'Complete the task described above.',
        '--approval-mode',
        'auto_edit',
        ...(context.extraDirs.length > 0 ? ['--include-directories', context.extraDirs.join(',')] : []),
      ],
      promptOnStdin: true,
      relayTools: false,
    }),
    safety: 'Can edit files in the working folder (approval mode auto_edit). Other tools that need approval are refused.',
    connect: async ({ mcpUrl, token }) =>
      editJsonFile(join(home(), '.gemini', 'settings.json'), (settings) => {
        settings.mcpServers = { ...(settings.mcpServers as object), crosschat: { httpUrl: mcpUrl, headers: { Authorization: `Bearer ${token}` } } };
      }, 'Restart Gemini CLI to load it.'),
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    binaries: ['opencode'],
    run: (context) => ({
      args: ['run', '--dir', context.workdir, '-f', context.promptFile, 'Complete the task described in the attached file.'],
      promptOnStdin: false,
      relayTools: false,
    }),
    safety: "Follows OpenCode's own permission settings; Crosschat adds no sandbox of its own.",
    connect: async ({ mcpUrl, token }) => {
      const file = join(home(), '.config', 'opencode', 'opencode.json');
      return {
        configured: false,
        file,
        snippet: JSON.stringify({ mcp: { crosschat: { type: 'remote', url: mcpUrl, oauth: false, enabled: true, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
        message: `Add this "mcp" entry to ${file} (or opencode.jsonc). Crosschat doesn't edit it for you because the file may contain comments.`,
      };
    },
  },
  {
    id: 'zcode',
    name: 'ZCode',
    binaries: ['zcode'],
    // The ZCode app ships its command-line agent as a Node.js script.
    knownLocations: () =>
      process.platform === 'win32'
        ? [process.env.ProgramFiles, process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
            .filter((base): base is string => Boolean(base))
            .map((base) => join(base, 'ZCode', 'resources', 'glm', 'zcode.cjs'))
        : process.platform === 'darwin'
          ? ['/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', join(home(), 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs')]
          : ['/opt/ZCode/resources/glm/zcode.cjs'],
    noteFor: () =>
      existsSync(join(home(), '.zcode', 'cli', 'config.json'))
        ? undefined
        : "ZCode's command line isn't set up yet: it needs its own model settings in ~/.zcode/cli/config.json, which the desktop app doesn't create. Until you add them, automatic runs stop with \"Model config is missing\".",
    run: (context) => ({
      // The prompt goes in as an attached file; edit mode instead of the headless default, yolo.
      args: ['--prompt', 'Complete the task described in the attached file.', '--attach', context.promptFile, '--cwd', context.workdir, '--mode', 'edit'],
      promptOnStdin: false,
      relayTools: false,
    }),
    safety: 'Runs in ZCode\'s edit mode (not its headless default, yolo): it can read and edit files in the working folder; tools that need approval are refused.',
    connect: async ({ mcpUrl, token }) =>
      editJsonFile(join(home(), '.zcode', 'cli', 'config.json'), (settings) => {
        const mcp = (settings.mcp ?? {}) as Record<string, unknown>;
        settings.mcp = { ...mcp, servers: { ...(mcp.servers as object), crosschat: { type: 'http', url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } };
      }, 'Restart ZCode sessions to load it.'),
  },
  {
    // Formerly DeepSeek-TUI; its deepseek command and ~/.deepseek settings still work.
    id: 'codewhale',
    name: 'Codewhale (DeepSeek)',
    binaries: ['codewhale', 'codew', 'deepseek'],
    knownLocations: () => {
      const exe = process.platform === 'win32' ? 'codewhale.exe' : 'codewhale';
      return [join(home(), '.cargo', 'bin', exe), join(home(), '.local', 'bin', exe)];
    },
    run: (context) => {
      const mcpFile = join(dirname(context.mcpConfigFile), 'codewhale-mcp.json');
      return {
        args: ['exec', '--auto', '--sandbox', 'workspace-write', 'Complete the task described in this file:', context.promptFile],
        promptOnStdin: false,
        relayTools: true,
        relayServer: 'crosschat',
        // A config for this run only, with this run's token.
        env: { DEEPSEEK_MCP_CONFIG: mcpFile },
        files: { [mcpFile]: JSON.stringify({ servers: { crosschat: { url: context.mcpUrl, bearer_token_env_var: 'CROSSCHAT_TOKEN' } } }) },
      };
    },
    safety:
      "Approves its own tool calls (--auto) inside Codewhale's workspace-write sandbox. That sandbox is enforced on macOS and Linux only: on Windows Codewhale can run any command as you, so allow only senders you trust.",
    connect: async ({ mcpUrl, token }) => {
      // New installs keep settings in ~/.codewhale; older DeepSeek-TUI installs in ~/.deepseek.
      const legacy = join(home(), '.deepseek');
      const directory = !existsSync(join(home(), '.codewhale')) && existsSync(legacy) ? legacy : join(home(), '.codewhale');
      return editJsonFile(join(directory, 'mcp.json'), (settings) => {
        settings.servers = { ...(settings.servers as object), crosschat: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } };
      }, 'Restart Codewhale to load it.');
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    binaries: ['cursor'],
    connect: async ({ mcpUrl, token }) =>
      editJsonFile(join(home(), '.cursor', 'mcp.json'), (settings) => {
        settings.mcpServers = { ...(settings.mcpServers as object), crosschat: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } };
      }, 'Cursor picks it up after a restart.'),
  },
];

/** A harness that runs with a command you supply. */
export const CUSTOM_HARNESS = 'custom';

export function findPreset(id: string): HarnessPreset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

// ------------------------------------------------------------- detection

export interface DetectedHarness {
  id: string;
  name: string;
  path?: string;
  canRun: boolean;
  /** Whether a worker can give it folders besides the working folder. */
  extraDirs: boolean;
  safety?: string;
  note?: string;
}

export function detectHarnesses(env: NodeJS.ProcessEnv = process.env): DetectedHarness[] {
  return PRESETS.map((preset) => {
    const path = locate(preset, env);
    const note = path ? preset.noteFor?.(path) : undefined;
    return {
      id: preset.id,
      name: preset.name,
      ...(path ? { path } : {}),
      canRun: Boolean(preset.run),
      extraDirs: Boolean(preset.extraDirs),
      ...(preset.safety ? { safety: preset.safety } : {}),
      ...(note ? { note } : {}),
    };
  });
}

function locate(preset: HarnessPreset, env: NodeJS.ProcessEnv): string | undefined {
  for (const binary of preset.binaries) {
    const found = which(binary, env);
    if (found) return found;
  }
  return preset.knownLocations?.().find((path) => existsSync(path));
}

/** Find an executable on PATH, preferring real programs over Windows script wrappers. */
export function which(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const extension of extensions) {
    for (const directory of directories) {
      const candidate = join(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// ------------------------------------------------------------- invocation

export interface Invocation {
  file: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * How to start a command without a shell. Windows npm wrappers (.cmd) can't
 * be run safely with arguments that contain task text, so they are resolved
 * to the Node.js script (or program) they wrap.
 */
export function resolveInvocation(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Invocation {
  // A Node.js script (ZCode ships its CLI as one) runs with Node.js.
  if (/\.(js|cjs|mjs)$/i.test(command)) return runWithNode(command, args, env);
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { file: command, args };
  const script = readFileSync(command, 'utf8');
  const target = /"%(?:~?dp0)%\\?([^"]+)"\s+%\*/i.exec(script)?.[1];
  if (!target) {
    throw new Error(`Can't run ${command} safely: point the worker at the program it wraps (an .exe or a Node.js script) instead.`);
  }
  const resolved = resolve(dirname(command), target);
  if (/\.exe$/i.test(resolved)) return { file: resolved, args };
  return runWithNode(resolved, args, env);
}

function runWithNode(script: string, args: string[], env: NodeJS.ProcessEnv): Invocation {
  const node = which('node', env);
  if (node) return { file: node, args: [script, ...args] };
  // Inside the desktop app, its own Electron binary can act as Node.js.
  return { file: process.execPath, args: [script, ...args], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// ------------------------------------------------------------ file helpers

async function editJsonFile(file: string, edit: (settings: Record<string, unknown>) => void, restartHint: string): Promise<ConnectResult> {
  let settings: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    } catch {
      const example: Record<string, unknown> = {};
      edit(example);
      return {
        configured: false,
        file,
        snippet: JSON.stringify(example, null, 2),
        message: `${file} isn't plain JSON (it may contain comments), so Crosschat didn't change it. Add this entry yourself.`,
      };
    }
    await copyFile(file, `${file}.bak`);
  }
  edit(settings);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { configured: true, file, message: `Added the relay to ${file}${existsSync(`${file}.bak`) ? ' (backup saved as .bak)' : ''}. ${restartHint}` };
}

export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Replace a [table] (and its [table.sub] tables) in TOML text, or append it. */
export function replaceTomlTable(text: string, table: string, replacement: string): string {
  const lines = text.split(/\r?\n/);
  const isHeader = (line: string) => /^\s*\[/.test(line);
  const belongs = (line: string) => {
    const name = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line)?.[1];
    return name === table || Boolean(name?.startsWith(`${table}.`));
  };
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (isHeader(line)) skipping = belongs(line);
    if (!skipping) kept.push(line);
  }
  const body = kept.join('\n').replace(/\s*$/, '');
  return `${body ? `${body}\n\n` : ''}${replacement}`;
}
