import * as fs from 'node:fs';
import * as path from 'node:path';
// Lazily require 'vscode' at runtime to avoid module load cycles in tests and
// when the extension is loaded in different module systems.
declare const require: any;

type McpTool = {
  name: string;
  title?: string;
  description?: string;
  arguments?: any;
  returns?: any;
  metadata?: any;
};

let _cached: { tools?: McpTool[] } | null = null;

function getWorkspaceRoot(): string | undefined {
  try {
    // require at runtime so tests can mock 'vscode' via loader
    const vscode = require('vscode') as typeof import('vscode');
    return vscode.workspace?.workspaceFolders?.[0]?.uri.fsPath;
  } catch {
    return undefined;
  }
}

function findManifestPath(): string | undefined {
  const wsRoot = getWorkspaceRoot() ?? process.cwd();
  if (wsRoot) {
    const p = path.join(wsRoot, 'mcp.json');
    if (fs.existsSync(p)) return p;
  }
  // fallback to path relative to this file (useful for tests / packaged extension layouts)
  const alt = path.join(__dirname, '../../mcp.json');
  if (fs.existsSync(alt)) return alt;
  return undefined;
}

export function loadManifest(): { tools?: McpTool[] } | undefined {
  if (_cached) return _cached;
  const p = findManifestPath();
  if (!p) return undefined;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    _cached = { tools: Array.isArray(parsed.tools) ? parsed.tools : [] };
    return _cached;
  } catch (err) {
    return undefined;
  }
}

export function getToolNames(): string[] | undefined {
  const m = loadManifest();
  if (!m || !m.tools) return undefined;
  return m.tools.map((t) => t.name);
}

function sampleForProperty(propSchema: any): any {
  if (!propSchema) return null;
  const t = propSchema.type;
  if (propSchema.default !== undefined) return propSchema.default;
  if (Array.isArray(t)) {
    // pick first
    return sampleForProperty({ type: t[0] });
  }
  switch (t) {
    case 'string':
      return propSchema.enum?.[0] ?? 'example';
    case 'integer':
    case 'number':
      return propSchema.default ?? 1;
    case 'boolean':
      return propSchema.default ?? true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

export function getToolSampleArgs(toolName: string): any {
  const m = loadManifest();
  const tool = m?.tools?.find((t) => t.name === toolName);
  if (!tool) return undefined;
  const argsSchema = tool.arguments;
  if (!argsSchema || argsSchema.type !== 'object') return {};
  const props = argsSchema.properties ?? {};
  const required: string[] = Array.isArray(argsSchema.required) ? argsSchema.required : [];
  const out: any = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = sampleForProperty(v);
  }
  // Ensure required keys exist with at least a sensible value
  for (const k of required) {
    if (out[k] === undefined || out[k] === null) out[k] = 'example';
  }
  return out;
}

export function getToolByName(toolName: string): McpTool | undefined {
  const m = loadManifest();
  return m?.tools?.find((t) => t.name === toolName);
}
