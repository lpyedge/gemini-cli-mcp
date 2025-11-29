import * as vscode from 'vscode';
import { getMcpClient, callTool, closeMcpClient } from './mcpClient';

type Submission = { label: string; tool: string; args?: any };

export async function runOrchestrator(cfg: any, output: vscode.OutputChannel) {
  const submissions: Submission[] = [
    { label: 'analyze-cliHealth', tool: 'code.analyze', args: { paths: ['src/extension/cliHealth.ts'], prompt: 'Review CLI health check' } },
    { label: 'analyze-server', tool: 'code.analyze', args: { paths: ['server/src/server/index.ts'], prompt: 'Review server lifecycle and persistence' } },
    { label: 'analyze-extension', tool: 'code.analyze', args: { paths: ['src/extension.ts'], prompt: 'Review activation and provider wiring' } },
    { label: 'run-tests', tool: 'tests.run', args: { command: 'npm', args: ['test'] } },
    { label: 'suggest-tasks', tool: 'gemini.task.suggest', args: { limit: 5 } },
    { label: 'list-tasks', tool: 'gemini.task.list', args: { limit: 10 } }
  ];

  output.appendLine(`Orchestrator: submitting ${submissions.length} tasks concurrently`);

  const { client } = await getMcpClient(cfg, output);

  const submitPromises = submissions.map(async (s) => {
    try {
      const res = await callTool(client, s.tool, s.args ?? {});
      return { label: s.label, ok: true, res };
    } catch (err) {
      return { label: s.label, ok: false, error: String(err) };
    }
  });

  const settled = await Promise.all(submitPromises);

  const tasks: Array<{ label: string; taskId?: string; immediate?: any; error?: string }> = [];
  for (const s of settled) {
    if (!s.ok) {
      tasks.push({ label: s.label, error: s.error });
      continue;
    }
        let first: any = undefined;
        if (Array.isArray(s.res?.result?.content)) {
          first = s.res.result.content.find((c: any) => c.type === 'text');
        }
    if (!first || !first.text) {
      tasks.push({ label: s.label, immediate: s.res });
      continue;
    }
    try {
      const parsed = JSON.parse(first.text);
      if (parsed?.taskId) {
        tasks.push({ label: s.label, taskId: parsed.taskId });
        output.appendLine(`Orchestrator: ${s.label} -> task ${parsed.taskId}`);
      } else {
        tasks.push({ label: s.label, immediate: parsed });
      }
    } catch (e) {
      tasks.push({ label: s.label, immediate: first.text });
    }
  }

  const waiters = tasks.filter((t) => t.taskId).map(async (t) => {
    try {
      let offset = 0;
      while (true) {
        const tail = await client.callTool({ name: 'gemini.task.tail', arguments: { taskId: t.taskId, offset } });
        const first = tail.content?.find((c: any) => c.type === 'text');
        const parsed = first && first.text ? (() => { try { return JSON.parse(first.text); } catch { return first.text; } })() : undefined;
        if (parsed && parsed.chunk) output.appendLine(parsed.chunk);
        offset = parsed?.nextOffset ?? offset;
        if (parsed?.done) return { label: t.label, final: parsed };
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (err) {
      return { label: t.label, error: String(err) };
    }
  });

  const results = await Promise.all(waiters);

  output.appendLine('\nOrchestrator report:');
  for (const r of results) {
    if ((r as any).error) {
      output.appendLine(`- ${(r as any).label}: FAIL - ${(r as any).error}`);
    } else {
      output.appendLine(`- ${(r as any).label}: ${(r as any).final?.status ?? 'unknown'}`);
    }
  }

  for (const t of tasks.filter((x) => x.immediate)) {
    output.appendLine(`- ${t.label}: immediate payload -> ${JSON.stringify(t.immediate).slice(0, 1000)}`);
  }

  await closeMcpClient();
}
