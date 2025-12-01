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

  const immediate: Array<{ label: string; payload: unknown }> = [];
  const failures: Array<{ label: string; error: string }> = [];

  for (const s of settled) {
    if (!s.ok) {
      failures.push({ label: s.label, error: s.error ?? 'unknown error' });
      continue;
    }

    const raw = s.res?.result ?? s.res;
    if (Array.isArray(raw?.content)) {
      const firstText = raw.content.find((c: any) => c && c.type === 'text' && c.text)?.text;
      if (firstText) {
        try {
          immediate.push({ label: s.label, payload: JSON.parse(firstText) });
          continue;
        } catch {
          immediate.push({ label: s.label, payload: firstText });
          continue;
        }
      }
    }

    immediate.push({ label: s.label, payload: raw ?? s.res });
  }

  output.appendLine('\nOrchestrator report:');
  for (const fail of failures) {
    output.appendLine(`- ${fail.label}: FAIL - ${fail.error}`);
  }
  for (const success of immediate) {
    output.appendLine(`- ${success.label}: ${JSON.stringify(success.payload).slice(0, 1000)}`);
  }

  await closeMcpClient();
}
