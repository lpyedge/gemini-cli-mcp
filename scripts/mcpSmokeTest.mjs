import process from 'node:process';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  const workspaceRoot = process.cwd();
  const geminiConfig = resolveGeminiCommand();

  console.log(`Using GEMINI_CLI=${geminiConfig.executable} ${geminiConfig.preArgs.join(' ')}`.trim());

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server/dist/index.js'],
    env: {
      GEMINI_CLI: geminiConfig.executable,
      GEMINI_MAX_WORKERS: '2',
      GEMINI_TASK_CWD: workspaceRoot,
      GEMINI_MAX_QUEUE: '20',
      PATH: process.env.PATH ?? process.env.Path ?? '',
      Path: process.env.PATH ?? process.env.Path ?? ''
    },
    stderr: 'pipe',
    stdout: 'pipe'
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on('data', (chunk) => {
      process.stderr.write(`[server stderr] ${chunk}`);
    });
  }
  const stdoutStream = transport.stdout;
  if (stdoutStream) {
    stdoutStream.on('data', (chunk) => {
      process.stdout.write(`[server stdout] ${chunk}`);
    });
  }

  const client = new Client(
    { name: 'gemini-mcp-smoke-test', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  await client.connect(transport);

  const toolList = await client.listTools({});
  console.log('Tools registered:', toolList.tools.map((tool) => tool.name).join(', '));

  const results = [];

  results.push({
    name: 'manifest.toolsPresent',
    ok: toolList.tools.length > 0,
    payload: toolList.tools.map((tool) => tool.name)
  });

  const snippet = 'function add(a, b) { return a + b; }';
  const explainRes = await callTool(client, 'dev.explainSnippet', {
    content: snippet,
    language: 'javascript'
  });
  const explainOk = explainRes && typeof explainRes === 'object' && !('error' in explainRes);
  results.push({
    name: 'dev.explainSnippet',
    ok: !!explainOk,
    payload: explainRes
  });

  const translateRes = await callTool(client, 'dev.translateCode', {
    content: snippet,
    targetLanguage: 'python',
    notes: false
  });
  const translateOk = translateRes && typeof translateRes === 'object' && !('error' in translateRes);
  results.push({
    name: 'dev.translateCode',
    ok: !!translateOk,
    payload: translateRes
  });

  const commentsRes = await callTool(client, 'dev.generateComments', {
    content: snippet,
    language: 'javascript',
    style: 'brief'
  });
  const commentsOk = commentsRes && typeof commentsRes === 'object' && !('error' in commentsRes);
  results.push({
    name: 'dev.generateComments',
    ok: !!commentsOk,
    payload: commentsRes
  });

  await client.close();

  console.log('\nSmoke summary:');
  for (const entry of results) {
    console.log(
      `- ${entry.name}: ${entry.ok ? 'OK' : 'FAIL'}${entry.taskId ? ` (task ${entry.taskId})` : ''}`
    );
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error('Failures:', failed);
    process.exit(1);
  }
}

async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return safeParseContent(res);
}

function safeParseContent(result) {
  const first = result.content?.find((entry) => entry.type === 'text');
  if (!first || !first.text) {
    return undefined;
  }
  try {
    return JSON.parse(first.text);
  } catch (error) {
    // Return raw text when the tool response is not valid JSON
    return first.text;
  }
}

function resolveGeminiCommand() {
  if (process.env.GEMINI_CLI && process.env.GEMINI_CLI.length > 0) {
    return { executable: process.env.GEMINI_CLI, preArgs: [] };
  }
  if (process.platform === 'win32') {
    const whereResult = spawnSync('where.exe', ['gemini'], { encoding: 'utf8' });
    if (whereResult.status === 0) {
      const candidates = whereResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (candidates.length > 0) {
        const cmd = candidates.find((c) => c.toLowerCase().endsWith('.cmd') && existsSync(c));
        if (cmd) return { executable: cmd, preArgs: [] };
        const exe = candidates.find((c) => c.toLowerCase().endsWith('.exe') && existsSync(c));
        if (exe) return { executable: exe, preArgs: [] };
        const first = candidates.find((c) => existsSync(c));
        if (first) return { executable: first, preArgs: [] };
      }
    }
  } else {
    const whichResult = spawnSync('which', ['gemini'], { encoding: 'utf8' });
    if (whichResult.status === 0) {
      const candidate = whichResult.stdout.trim();
      if (candidate) {
        return { executable: candidate, preArgs: [] };
      }
    }
  }
  return { executable: 'node', preArgs: [] };
}

main().catch((error) => {
  console.error('Smoke test failed:', error);
  process.exit(1);
});
