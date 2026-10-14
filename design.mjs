// A brief in, a finished design out: the Claude Agent SDK runs Claude with your Anthropic API key, the engine runs in one local executor.
import { mkdir, writeFile } from 'node:fs/promises';

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  googleFonts,
  prepareCoDesign,
  remoteExecutors
} from '@imgly/codesign-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const brief = process.argv[2];
const missing = [
  ...(brief ? [] : ['a brief (the first argument)']),
  ...['IMGLY_CESDK_LICENSE', 'EXECUTOR_TOKEN'].filter((n) => !process.env[n])
];
if (missing.length > 0) {
  console.error(
    `Missing ${missing.join(', ')}.\nUsage: npm start -- "<brief>", with the variables of .env.template set in .env` +
      (process.env.IMGLY_CESDK_LICENSE
        ? ''
        : '\nContact sales (https://img.ly/forms/contact-sales/) to get a CoDesign license key.')
  );
  process.exit(1);
}

const codesign = prepareCoDesign({
  // Your id for this job. Every design of a conversation opens on one executor
  // that serves no other conversation. Every run here is yours, so all share one.
  conversation: 'quickstart',
  executors: remoteExecutors({
    // The executor for a conversation. Here there is one; a product starts a
    // new one for each conversation.
    acquire: () => ({
      url: process.env.EXECUTOR_URL || 'http://localhost:8080'
    }),
    token: process.env.EXECUTOR_TOKEN
  }),
  // The CE.SDK plugins the engine applies: everything the agent can search and
  // place. Google Fonts is the smallest useful list; your own plugins go here.
  plugins: [googleFonts()],
  design: `quickstart-${Date.now()}`, // any id; with no `designs` store, the design lives in memory
  gateway: false // no image generation
});

// The SDK's tools as an MCP server inside this process. Their JSON Schemas and
// results already have MCP's shape, so they pass through unchanged, renders
// included: Claude sees images in a tool result.
const server = new McpServer(
  { name: 'codesign', version: '1.0.0' },
  { capabilities: { tools: {} } }
);
server.server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: codesign.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }))
}));
server.server.setRequestHandler(
  CallToolRequestSchema,
  async ({ params }, { signal }) => {
    const tool = codesign.tools.find((t) => t.name === params.name);
    if (!tool) throw new Error(`No tool named ${params.name}`);
    const result = await tool
      .call(params.arguments ?? {}, { signal })
      .catch((err) => {
        console.log(`✗ ${tool.name} (${err.kind ?? err.name})`); // rejected: the executor or your store failed
        throw err;
      });
    console.log(`${result.isError ? '✗' : '✓'} ${tool.name}`);
    return result; // a result with isError reads to the model as a failed call
  }
);

/** A failure in one line: the SDK error's kind and the first line of its message, not a stack or a request body. */
const cause = (err) =>
  `${err?.kind ? `${err.kind}: ` : ''}${String(err instanceof Error ? err.message : err).split('\n')[0]}`;

// The free .imgly first: when the billed PNG export fails, or the run ends early, the design the model made is kept.
async function save(withPNG) {
  let file = 'out/design.imgly';
  try {
    await mkdir('out', { recursive: true });
    await writeFile(file, await codesign.export('imgly'));
    if (!withPNG) return console.error(`Wrote ${file}, the design so far.`);
    file = 'out/design.png';
    await writeFile(file, await codesign.export('png'));
    console.log('Wrote out/design.png and out/design.imgly');
  } catch (err) {
    console.error(`Could not write ${file}: ${cause(err)}`);
    process.exitCode = 1;
  }
}

const started = Date.now();
const run = query({
  prompt: brief,
  options: {
    model: process.env.MODEL || 'claude-opus-5',
    systemPrompt: `You design marketing visuals. When you are done, say in one sentence what you made.\n\n${codesign.instructions}`,
    mcpServers: {
      codesign: { type: 'sdk', name: 'codesign', instance: server }
    },
    tools: [], // none of Claude Code's own tools: no shell, no files, no web
    allowedTools: ['mcp__codesign'], // the design tools run without asking
    permissionMode: 'dontAsk', // anything else is refused, never asked about
    settingSources: [], // no settings, hooks, plugins, or CLAUDE.md from this machine
    strictMcpConfig: true, // no MCP servers but the one above
    persistSession: false, // no transcript written to ~/.claude
    maxTurns: 60 // without it, the run has no step limit
  }
});

/** @type {import('@anthropic-ai/claude-agent-sdk').SDKResultMessage | undefined} */
let result;
let authFailed = false;
try {
  for await (const message of run) {
    if (
      message.type === 'assistant' &&
      message.error === 'authentication_failed'
    )
      authFailed = true;
    if (message.type === 'result') result = message;
  }
} catch (err) {
  if (!result) console.error(`The run failed: ${cause(err)}`); // after a failed result the SDK throws too; that result says why
}

if (result?.subtype === 'success' && !result.is_error) {
  console.log(`\n${result.result}`);
  const u = result.usage;
  const input =
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  console.log(
    `${result.num_turns} steps, ${Math.round((Date.now() - started) / 1000)} s, ` +
      `${input} input / ${u.output_tokens} output tokens`
  );
  await save(true);
} else {
  const why = result?.subtype === 'success' ? result.result : result?.subtype;
  console.error(`The model stopped early (${why}).`);
  if (authFailed)
    console.error('Set ANTHROPIC_API_KEY in .env to your Anthropic API key.');
  process.exitCode = 1;
  await save(false);
}
await codesign.release(); // ends the design's session now; the engine closes about 30 s later
