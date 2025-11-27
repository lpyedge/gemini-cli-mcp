import process from 'node:process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
    stderr: 'pipe'
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on('data', (chunk) => {
      process.stderr.write(`[server stderr] ${chunk}`);
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

  // 1) Basic version check
  results.push(await runCommandTask(client, geminiConfig, ['--version']));

  // 2) 快速帮助输出（避免长时间联网）
  results.push(await runCommandTask(client, geminiConfig, ['--help'], 10_000));

  // 3) 文件写读验证
  const tmpFile = path.join('scripts', '.mcp-smoke.tmp');
  await fs.writeFile(tmpFile, 'hello-mcp', 'utf8');
  const writeRes = await callTool(client, 'fs.write', { file: tmpFile, contents: 'hello-mcp-updated' });
  results.push({ name: 'fs.write', ok: !!writeRes?.ok, payload: writeRes });
  const readRes = await callTool(client, 'fs.read', { file: tmpFile });
  results.push({ name: 'fs.read', ok: typeof readRes === 'string' && readRes.includes('hello-mcp-updated'), payload: readRes });
  await fs.unlink(tmpFile).catch(() => {});

  // 4) Task listing and suggestion check
  const listRes = await callTool(client, 'gemini.task.list', { limit: 5 });
  results.push({ name: 'gemini.task.list', ok: !!listRes?.tasks, payload: listRes });
  const suggestRes = await callTool(client, 'gemini.task.suggest', { limit: 3 });
  results.push({ name: 'gemini.task.suggest', ok: !!suggestRes?.suggestions, payload: suggestRes });

  // 5) Tail 已完成任务日志，确保资源可读
  const lastTaskId = results.find((r) => r.name === 'command(--version)')?.taskId;
  if (lastTaskId) {
    const tailRes = await callTool(client, 'gemini.task.tail', { taskId: lastTaskId, offset: 0 });
    results.push({
      name: 'gemini.task.tail',
      ok: !!tailRes && tailRes.status !== 'failed',
      payload: tailRes
    });
  }

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

async function runCommandTask(client, geminiConfig, args, timeoutMs = 30_000) {
  const submitResult = await client.callTool({
    name: 'gemini.task.submit',
    arguments: {
      command: [...geminiConfig.preArgs, ...args],
      timeoutMs
    }
  });
  const submitPayload = safeParseContent(submitResult);
  if (!submitPayload?.taskId) {
    throw new Error(`gemini.task.submit did not return a taskId: ${JSON.stringify(submitPayload)}`);
  }

  const taskId = submitPayload.taskId;
  const final = await waitForTaskCompletion(client, taskId, submitPayload.nextOffset ?? 0);
  return { name: `command(${args.join(' ')})`, ok: final.status === 'succeeded', taskId, payload: final };
}

async function waitForTaskCompletion(client, taskId, startOffset = 0) {
  let offset = startOffset;
  let status = 'unknown';
  let lastChunk = '';
  while (true) {
    const tailResult = await client.callTool({
      name: 'gemini.task.tail',
      arguments: { taskId, offset }
    });
    const tailPayload = safeParseContent(tailResult);
    if (!tailPayload) {
      throw new Error('gemini.task.tail returned invalid payload');
    }

    if (tailPayload.chunk) {
      lastChunk = tailPayload.chunk;
      process.stdout.write(tailPayload.chunk);
    }

    offset = tailPayload.nextOffset ?? offset;
    status = tailPayload.status ?? status;

    if (tailPayload.done) {
      return { ...tailPayload, status, lastChunk };
    }
    await delay(250);
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
    // 对纯文本工具（如 fs.read）直接返回原始字符串
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
