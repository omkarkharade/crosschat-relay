import { describe, expect, it } from 'vitest';

import { ActivityRecorder, createParser, unwrapShell, type NewActivity } from '../src/activity.js';

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event));

describe('Codex event stream', () => {
  it('turns commands, messages, and file changes into steps and keeps the last message as the answer', () => {
    const parser = createParser('codex-json');
    const command = { id: 'item_1', type: 'command_execution', command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-ChildItem .'` };
    const steps = lines(
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll check the folder.' } },
      { type: 'item.started', item: { ...command, aggregated_output: '', exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { ...command, aggregated_output: 'note.txt\r\n', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'a.png', kind: 'add' }], status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done: a.png' } },
      { type: 'turn.completed', usage: {} },
    ).flatMap((line) => parser.line(line));

    expect(steps.map((step) => [step.kind, step.status])).toEqual([
      ['message', undefined],
      ['command', 'running'],
      ['command', 'ok'],
      ['file', 'ok'],
      ['message', undefined],
    ]);
    expect(steps[1]).toMatchObject({ text: 'Get-ChildItem .', ref: 'item_1' });
    expect(steps[2]!.detail).toBe('note.txt');
    expect(steps[3]!.text).toBe('Added a.png');
    expect(parser.answer()).toBe('Done: a.png');
  });

  it('marks failed commands and reports a failed turn', () => {
    const parser = createParser('codex-json');
    const [failed] = parser.line(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } }));
    expect(failed!.status).toBe('failed');
    expect(parser.line(JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } }))).toEqual([{ kind: 'error', text: 'rate limited' }]);
  });
});

describe('Claude Code event stream', () => {
  it('pairs tool calls with their results and reads the answer from the result event', () => {
    const parser = createParser('claude-stream');
    const steps = lines(
      { type: 'system', subtype: 'init', cwd: '/work' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the note.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/work/note.txt' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '1\thello\n' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__crosschat-run__post_task', input: { title: 'Draw a map' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: [{ type: 'text', text: 'not allowed' }] }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'hello', permission_denials: [{ tool_name: 'Bash' }] },
    ).flatMap((line) => parser.line(line));

    expect(steps.map((step) => [step.kind, step.text, step.status])).toEqual([
      ['message', 'Reading the note.', undefined],
      ['tool', 'Read: /work/note.txt', 'running'],
      ['tool', 'Read: /work/note.txt', 'ok'],
      ['tool', 'crosschat-run › post_task: Draw a map', 'running'],
      ['tool', 'crosschat-run › post_task: Draw a map', 'failed'],
      ['error', "1 tool call was refused: this run isn't allowed to use that tool.", undefined],
    ]);
    expect(steps[2]!.detail).toBe('1\thello');
    expect(steps[4]!.detail).toBe('not allowed');
    expect(parser.answer()).toBe('hello');
  });
});

describe('plain output', () => {
  it('shows every non-empty line and has no answer of its own', () => {
    const parser = createParser(undefined);
    expect(parser.line('compiling...')).toEqual([{ kind: 'output', text: 'compiling...' }]);
    expect(parser.line('  ')).toEqual([]);
    expect(parser.answer()).toBeUndefined();
  });

  it('shows the command inside a shell wrapper', () => {
    expect(unwrapShell(`/bin/bash -lc 'ls -la'`)).toBe('ls -la');
    expect(unwrapShell('npm test')).toBe('npm test');
  });
});

describe('ActivityRecorder', () => {
  async function record(steps: Parameters<ActivityRecorder['add']>[0][], secrets: string[] = []): Promise<NewActivity[]> {
    const written: NewActivity[] = [];
    const recorder = new ActivityRecorder(async (entries) => void written.push(...entries), secrets);
    for (const step of steps) recorder.add(step);
    await recorder.close({ kind: 'end', text: 'Finished.', status: 'ok' });
    return written;
  }

  it('hides secrets, joins output lines, and replaces a step with its update before writing', async () => {
    const written = await record(
      [
        { kind: 'output', text: 'token is ccr_secret' },
        { kind: 'output', text: 'second line' },
        { kind: 'command', text: 'npm test', status: 'running', ref: 'item_1' },
        { kind: 'command', text: 'npm test', status: 'ok', ref: 'item_1', detail: 'passed' },
      ],
      ['ccr_secret'],
    );
    expect(written.map((entry) => entry.kind)).toEqual(['output', 'command', 'end']);
    expect(written[0]!.text).toBe('token is [hidden]\nsecond line');
    expect(written[1]).toMatchObject({ status: 'ok', detail: 'passed' });
    // Refs are made unique per run, since harnesses restart their numbering.
    expect(written[1]!.ref).toMatch(/^[0-9a-f]{8}:item_1$/);
  });

  it('stops keeping steps at the limit but still records the end of the run', async () => {
    const steps = Array.from({ length: 2000 }, (_, index) => ({ kind: 'message' as const, text: `step ${index}` }));
    const written = await record(steps);
    expect(written.length).toBe(1501);
    expect(written.at(-2)!.text).toContain('limit');
    expect(written.at(-1)!.kind).toBe('end');
  });
});
