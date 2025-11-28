import { build } from 'esbuild';
import { mkdirSync, existsSync } from 'node:fs';
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
  // After all targets built, verify critical outputs exist so packaging can fail early
  const serverTarget = targets.find((t) => t.name === 'server');
  if (serverTarget) {
    if (!existsSync(serverTarget.outfile)) {
      console.error(`Bundling error: expected server bundle not found at ${serverTarget.outfile}`);
      console.error('Ensure the server target compiled successfully and that bundling did not place output in a different location.');
      console.error('Check `scripts/bundle.mjs` targets and `package.json` files configuration.');
      process.exitCode = 1;
      throw new Error('server bundle missing after bundling');
    }
  }
} catch (error) {
  console.error('Failed to bundle Gemini CLI MCP extension:', error);
  process.exitCode = 1;
}
