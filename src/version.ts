import { readFileSync } from 'node:fs';

// package.json sits one level above both src/ (dev) and dist/ (built).
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export const VERSION = packageJson.version;
