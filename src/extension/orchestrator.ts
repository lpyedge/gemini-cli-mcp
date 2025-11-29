import * as vscode from 'vscode';
import { getMcpClient, callTool, closeMcpClient } from './mcpClient';
import { getToolNames, getToolSampleArgs } from './mcpManifest';

type Submission = { label: string; tool: string; args?: any };

export async function runOrchestrator(cfg: any, output: vscode.OutputChannel) {
  // Create example submissions — prefer generating from `mcp.json` so the manifest
  // is the single source of truth. Fall back to an inline list if manifest is missing.
  const manifestToolNames = getToolNames();
  if (!manifestToolNames || manifestToolNames.length === 0) {
    output.appendLine('Orchestrator: no tools found in mcp.json; aborting orchestrator run.');
    // Close client if it was opened by getMcpClient earlier; ensure we still call closeMcpClient.
    await closeMcpClient();
    return;
  }
  const submissions: Submission[] = manifestToolNames.map((tool) => {
    const sample = getToolSampleArgs(tool) ?? {};
    const label = tool.replace(/\./g, '-');
    return { label, tool, args: sample };
  });

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
    // Normalize various possible result shapes from tools.
    const raw = s.res?.result ?? s.res;
    // 1) If the tool returned an MCP-style content array (long-running task metadata)
    if (Array.isArray(raw?.content)) {
      const firstText = raw.content.find((c: any) => c && c.type === 'text' && c.text)?.text;
      if (firstText) {
        try {
          const parsed = JSON.parse(firstText);
          if (parsed?.taskId) {
            tasks.push({ label: s.label, taskId: parsed.taskId });
            output.appendLine(`Orchestrator: ${s.label} -> task ${parsed.taskId}`);
            continue;
          }
          tasks.push({ label: s.label, immediate: parsed });
          continue;
        } catch {
          tasks.push({ label: s.label, immediate: firstText });
          continue;
        }
      }
    }
    // 2) If result contains a direct taskId
    if (raw && typeof raw === 'object' && raw.taskId) {
      tasks.push({ label: s.label, taskId: String(raw.taskId) });
      output.appendLine(`Orchestrator: ${s.label} -> task ${raw.taskId}`);
      continue;
    }
    // 3) Common direct returns for dev/web helpers
    if (raw && (raw.summary || raw.explanation || raw.commentedCode || raw.refactored || raw.tests || raw.translated)) {
      tasks.push({ label: s.label, immediate: raw });
      continue;
    }
    // 4) Fallback: include the whole response
    tasks.push({ label: s.label, immediate: s.res });
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
