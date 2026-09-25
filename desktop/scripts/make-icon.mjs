// Writes build/icon.png (512 px), which electron-builder turns into .ico and .icns.
import { mkdirSync, writeFileSync } from 'node:fs';

import { drawIcon, encodePng } from '../icon.js';

mkdirSync(new URL('../build/', import.meta.url), { recursive: true });
writeFileSync(new URL('../build/icon.png', import.meta.url), await encodePng(512, drawIcon(512)));
console.log('Wrote build/icon.png');
