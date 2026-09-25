// Bundles the relay, with its dependencies inlined, for the desktop app. The
// packaged app then needs no node_modules folder, which installers tend to drop.
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root,
  logLevel: 'warn',
  build: {
    ssr: true,
    target: 'node22',
    outDir: fileURLToPath(new URL('build/relay/dist', import.meta.url)),
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      // cli.js is the command line, index.js the relay, service.js is what the tray imports.
      input: { cli: 'src/cli.ts', index: 'src/index.ts', service: 'src/service.ts' },
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        // Keep chunks next to the entries: modules resolve ../package.json and ./public/ relative to themselves.
        chunkFileNames: '[name]-[hash].js',
      },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
