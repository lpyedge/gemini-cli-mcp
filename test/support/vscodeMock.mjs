import path from 'node:path';

export class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  event(listener) {
    this._listeners.push(listener);
    return { dispose: () => {} };
  }
  fire(arg) {
    for (const l of this._listeners.slice()) {
      try { l(arg); } catch (e) { /* swallow */ }
    }
  }
  dispose() {}
}

export class McpStdioServerDefinition {
  constructor(id, command, args, env, version) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.env = env;
    this.version = version;
    this.cwd = null;
  }
}

export class TreeItem {
  constructor(label, options = {}) {
    this.label = label;
    this.description = options.description;
    this.tooltip = options.tooltip;
    this.collapsibleState = options.collapsibleState;
    this.contextValue = options.contextValue;
  }
}

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
};

export const window = {
  createOutputChannel: (name) => ({
    appendLine: (s) => { /* keep quiet in tests */ },
    show: () => {},
    clear: () => {}
  }),
  createStatusBarItem: () => ({ name: '', text: '', tooltip: '', show: () => {}, dispose: () => {} }),
  registerTreeDataProvider: () => ({ dispose: () => {} })
};

export const workspace = {
  workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
  fs: {
    readFile: async () => { throw new Error('workspace.fs.readFile not implemented in vscode mock'); }
  },
  onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
  getConfiguration: () => ({ get: () => undefined })
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => {}
};

export const Uri = {
  file: (fsPath) => ({ fsPath }),
  joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts) }),
  parse: (s) => ({ fsPath: s })
};

export const lm = {
  registerMcpServerDefinitionProvider: (id, provider) => ({ dispose: () => {} })
};

export default {
  EventEmitter,
  McpStdioServerDefinition,
  TreeItem,
  TreeItemCollapsibleState,
  window,
  workspace,
  commands,
  Uri,
  lm,
};
