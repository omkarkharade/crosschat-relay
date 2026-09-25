// Builds the relay into build/relay as bundled files with no node_modules. The
// packaged app ships it as resources/relay and runs it with Electron's own Node.js.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const target = fileURLToPath(new URL('../build/relay/', import.meta.url));

if (!existsSync(`${root}dist/public/index.html`)) {
  console.error('Build the relay first: run "npm run build" in the Crosschat folder.');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
execSync('npx vite build --config desktop/relay.vite.config.mjs', { cwd: root, stdio: 'inherit' });
cpSync(`${root}dist/public`, `${target}dist/public`, { recursive: true });
// package.json marks the files as ES modules and carries the version number.
cpSync(`${root}package.json`, `${target}package.json`);
cpSync(`${root}LICENSE`, `${target}LICENSE`);
console.log(`Prepared the relay in ${target}`);
