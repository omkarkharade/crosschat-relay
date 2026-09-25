// The Crosschat icon, drawn in code so the tray can recolour its status dot and
// the same drawing produces the app icon for installers.

const ACCENT = [79, 70, 229];
const WHITE = [255, 255, 255];

/** Status dot colours. */
export const STATUS_COLORS = {
  running: [34, 197, 94],
  warning: [245, 158, 11],
  stopped: [156, 163, 175],
  error: [239, 68, 68],
};

/**
 * Draw the icon as RGBA pixels. The shape is a rounded indigo square with two
 * white arrows passing each other (a relay); `status` adds a coloured dot.
 * @param {number} size Width and height in pixels.
 * @param {keyof typeof STATUS_COLORS | undefined} status
 * @returns {Buffer} RGBA, row by row.
 */
export function drawIcon(size, status) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4; // Supersampling per axis, for smooth edges.

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          const color = shade(u, v, status);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 1;
        }
      }
      const offset = (y * size + x) * 4;
      const coverage = a / (samples * samples);
      if (a > 0) {
        pixels[offset] = Math.round(r / a);
        pixels[offset + 1] = Math.round(g / a);
        pixels[offset + 2] = Math.round(b / a);
      }
      pixels[offset + 3] = Math.round(coverage * 255);
    }
  }
  return pixels;
}

/** The colour at a point in the unit square, or undefined for transparent. */
function shade(u, v, status) {
  if (status) {
    const dx = u - 0.78;
    const dy = v - 0.78;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.17) return STATUS_COLORS[status];
    // A transparent ring keeps the dot readable on any tray background.
    if (distance < 0.25) return undefined;
  }
  if (!insideRoundedSquare(u, v, 0.04, 0.22)) return undefined;
  if (onArrow(u, v, 0.37, 1) || onArrow(u, v, 0.63, -1)) return WHITE;
  return ACCENT;
}

function insideRoundedSquare(u, v, inset, radius) {
  const min = inset;
  const max = 1 - inset;
  if (u < min || u > max || v < min || v > max) return false;
  const cx = Math.min(Math.max(u, min + radius), max - radius);
  const cy = Math.min(Math.max(v, min + radius), max - radius);
  return Math.hypot(u - cx, v - cy) <= radius;
}

/** A horizontal arrow at height `row`, pointing right (1) or left (-1). */
function onArrow(u, v, row, direction) {
  const thickness = 0.065;
  const start = 0.24;
  const end = 0.76;
  const head = 0.13;
  const tip = direction === 1 ? end : start;
  const along = direction === 1 ? tip - u : u - tip;
  if (along >= 0 && along <= end - start && Math.abs(v - row) <= thickness / 2 && along >= 0.02) return true;
  // Arrowhead: two short strokes back from the tip.
  if (along >= 0 && along <= head) {
    const spread = along;
    if (Math.abs(Math.abs(v - row) - spread) <= thickness * 0.55) return true;
  }
  return false;
}

/** Encode RGBA pixels as a PNG file. */
export async function encodePng(size, rgba) {
  const { deflateSync } = await import('node:zlib');
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0;
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // Bit depth.
  header[9] = 6; // Colour type: RGBA.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

let crcTable;
function crc32(buffer) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
