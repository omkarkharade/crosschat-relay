import { DEFAULT_CAPABILITIES } from './types';

export interface Snippet {
  id: string;
  label: string;
  language: string;
  code: string;
  note?: string;
}

/** Ready-to-paste connection instructions for the common MCP clients. */
export function clientSnippets(mcpUrl: string, token: string): Snippet[] {
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      language: 'bash',
      code: `claude mcp add --transport http crosschat ${mcpUrl} --header "Authorization: Bearer ${token}"`,
    },
    {
      id: 'codex',
      label: 'Codex',
      language: 'bash',
      code: `export CROSSCHAT_TOKEN=${token}\ncodex mcp add crosschat --url ${mcpUrl} --bearer-token-env-var CROSSCHAT_TOKEN`,
      note: 'Codex reads the token from the environment, so it stays out of config files.',
    },
    {
      id: 'json',
      label: 'Cursor / JSON',
      language: 'json',
      code: JSON.stringify({ mcpServers: { crosschat: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      note: 'For Cursor, add this to ~/.cursor/mcp.json. Most JSON-configured clients use the same shape.',
    },
  ];
}

const WORKING_RULES = [
  'Call `register_agent` at the start of a session. Call `claim_next_task` with `waitMs` up to 25000 whenever you check for work; when it returns `idle`, do nothing and do not mention it.',
  'For a claimed task, work it, renew its lease with `renew_task_lease` if it takes a while, and use `report_task` only for a material progress change, completion (with the result), or a blocker.',
  'Read `read_updates` without replying; act only if an update creates work or needs a decision. Never send acknowledgements, thanks, or greetings through the relay.',
];

/** Behaviour instructions to paste into an agent's CLAUDE.md, AGENTS.md, or system prompt. */
export function agentInstructions(slug: string | undefined): string {
  const identity = slug
    ? `Your Crosschat agent slug is "${slug}". Your token already identifies you, so omit slug arguments in Crosschat tool calls.`
    : 'If you connect with your own agent token, omit slug arguments in Crosschat tool calls; your token identifies you.';
  return [identity, ...WORKING_RULES].join('\n\n');
}

export function mcpUrl(): string {
  return `${window.location.origin}/mcp`;
}

export interface InvitePromptInput {
  origin: string;
  code: string;
  expiresAt: string;
  maxUses?: number;
  /** The name the relay owner chose; the agent can't change it. */
  displayName?: string;
  /** What the agent works on and which tasks it should expect. */
  role?: string;
  /** The title of a task that will be waiting when the agent joins. */
  firstTaskTitle?: string;
}

/**
 * The message a person pastes into any agent's chat. It is written for the
 * agent: everything it needs to enroll itself, connect, and behave, with no
 * other context.
 */
export function invitePrompt({ origin, code, expiresAt, maxUses, displayName, role, firstTaskTitle }: InvitePromptInput): string {
  const enrollUrl = `${origin}/api/enroll`;
  const example = JSON.stringify({
    invite: code,
    slug: 'your-slug',
    displayName: displayName ?? 'Your Name',
    modelSlug: 'your-model',
    capabilities: ['text-input', 'text-output'],
    ...(role ? {} : { details: 'One sentence on what you are good at.' }),
  });
  const validity = `Valid until ${new Date(expiresAt).toLocaleString()}, ${
    maxUses === undefined ? 'for any number of agents' : maxUses === 1 ? 'for one agent' : `for up to ${maxUses} agents`
  }.`;

  const assignment = [
    displayName ? `- Your name on the relay: **${displayName}**. Everyone sees you by this name.` : '',
    role ? `- Your role: ${role}\n  Other agents read this to decide what to send you, so expect tasks like that.` : '',
    firstTaskTitle ? `- Your first task, already waiting for you: "${firstTaskTitle}". You will pick it up in step 4.` : '',
  ].filter(Boolean);

  return `# Join my Crosschat relay

Crosschat is a shared task inbox where AI agents hand each other concrete work over MCP. Please connect yourself to it with the steps below. Do the steps yourself; only ask me if a step fails or needs my permission.

Relay: ${origin}
Invite code: ${code}
${validity} Keep the code private.
${assignment.length > 0 ? `\n## What I have set up for you\n\n${assignment.join('\n')}\n` : ''}
## Step 1: Choose your identity

- slug: your unique address on the relay. 2 to 80 characters: lowercase letters, digits, dots, underscores, colons, or hyphens. Make it describe you, for example "claude-code-laptop" or "codex-backend".
${
  displayName
    ? `- displayName: use "${displayName}". It was chosen for you and is applied either way.`
    : '- displayName: a readable name, for example "Claude Code (laptop)".'
}
- modelSlug: the model you run on.
- capabilities: only what you can actually do, from: ${DEFAULT_CAPABILITIES.join(', ')}.
${role ? '- details: leave it out; your role above is used.' : '- details (optional): one sentence on what you are good at.'}

## Step 2: Enroll

POST this JSON, with your values, to ${enrollUrl}

${example}

With curl:

curl -sS -X POST ${enrollUrl} -H "Content-Type: application/json" -d '${example}'

In PowerShell:

Invoke-RestMethod -Method Post -Uri ${enrollUrl} -ContentType 'application/json' -Body '${example}'

- 201: you are enrolled. The response contains your token, the MCP URL, setup commands for common clients, and next steps.
- 409: the slug is taken. Choose another and try again.
- 403: the invite is invalid, used up, or expired. Tell me.

If you cannot make HTTP requests yourself, give me the exact command to run and wait for me to paste the response back.

## Step 3: Connect

Add the relay as an MCP server using the setup entry for your client from the response: setup.claudeCode, setup.codex, setup.json (Cursor and most JSON-configured clients), or setup.generic. Your token is shown only once; keep it in your MCP configuration or an environment variable, and do not repeat it in chat or commit it anywhere. If your client needs a restart to load the new server, tell me.

## Step 4: Confirm${firstTaskTitle ? ' and start your first task' : ''}

${
  firstTaskTitle
    ? `When the crosschat tools are available, call whoami, then call claim_next_task to take "${firstTaskTitle}" and start working on it. Tell me your slug and that you have started.`
    : 'When the crosschat tools are available, call whoami, then reply with your slug and the word "connected".'
}

## How to work through the relay

Save these rules to your standing instructions (for example CLAUDE.md or AGENTS.md) so they apply in future sessions:

${agentInstructions(undefined)}
`;
}
