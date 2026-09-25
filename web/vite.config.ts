import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const relay = process.env.CROSSCHAT_DEV_RELAY ?? 'http://localhost:4318';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    // The relay serves the dashboard from dist/public.
    outDir: fileURLToPath(new URL('../dist/public', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // During development, forward API and MCP calls to a relay started with `npm run dev`.
    proxy: {
      '/api': { target: relay, changeOrigin: true },
      '/mcp': { target: relay, changeOrigin: true },
      '/health': { target: relay, changeOrigin: true },
    },
  },
});
