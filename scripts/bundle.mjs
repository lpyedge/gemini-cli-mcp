import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

const targets = [
  {
    name: 'extension',
    entry: path.join(projectRoot, 'src', 'extension.ts'),
    outfile: path.join(projectRoot, 'dist', 'extension.js'),
    external: ['vscode']
  },
  {
    name: 'server',
    entry: path.join(projectRoot, 'server', 'src', 'server', 'index.ts'),
    outfile: path.join(projectRoot, 'server', 'dist', 'index.js'),
    external: []
  }
  ,
  {
    name: 'spawnHelpers',
    entry: path.join(projectRoot, 'server', 'src', 'gemini', 'spawnHelpers.ts'),
    outfile: path.join(projectRoot, 'server', 'dist', 'spawnHelpers.js'),
    external: []
  }
];

mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
mkdirSync(path.join(projectRoot, 'server', 'dist'), { recursive: true });

async function buildTarget(target) {
  const options = {
    entryPoints: [target.entry],
    outfile: target.outfile,
    platform: 'node',
    bundle: true,
    external: target.external,
    sourcemap: false,
    // Build server as ESM to match server/package.json { "type": "module" }.
    // Keep the extension target as CJS for VS Code compatibility.
    format: target.name === 'server' || target.name === 'spawnHelpers' ? 'esm' : 'cjs',
    target: 'node18',
    logLevel: 'info',
    minify: true
  };

  if (watch) {
    const ctx = await build({
      ...options,
      watch: {
        onRebuild(error) {
          if (error) {
            console.error(`[${target.name}] rebuild failed`, error);
          } else {
            console.log(`[${target.name}] rebuilt`);
          }
        }
      }
    });
    console.log(`[${target.name}] watching...`);
    return ctx;
  }

  await build(options);
  console.log(`[${target.name}] bundle written to ${path.relative(projectRoot, target.outfile)}`);
}

try {
  await Promise.all(targets.map((target) => buildTarget(target)));
} catch (error) {
  console.error('Failed to bundle Gemini CLI MCP extension:', error);
  process.exitCode = 1;
}
