#!/usr/bin/env node
/**
 * Builds the Windows application icon, tray glyph, favicon and release banner
 * artwork from the master Liquid Glass cloud sources in build/.
 *
 * The two master PNGs (blue and white) are the canonical 1.2.0 artwork. Every
 * generated size is trimmed to its visible pixels first, so the cloud keeps its
 * intended weight in the taskbar, installer, tray and documentation.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const output = path.join(root, 'build');
const blueSource = path.join(output, 'updated_v1_2_0_icon_blue.png');
const whiteSource = path.join(output, 'updated_v1_2_0_icon_white.png');
const bannerSource = path.join(root, 'public', 'nimbus-banner.svg');
const faviconOutput = path.join(root, 'public', 'nimbus-icon.png');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const masterIconSizes = [256, 512, 1024];
const banners = [
  { name: 'banner-1280x640.png', width: 1280, height: 640 },
  { name: 'banner-2560x1280.png', width: 2560, height: 1280 },
];

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

async function trimMaster(source) {
  return sharp(source).trim({ threshold: 1 }).png({ compressionLevel: 9 }).toBuffer();
}

/**
 * Render the visible cloud into an exact square with optional breathing room.
 * `padding` is a fraction of the final size (0.04 = 4% on every edge).
 */
async function renderIcon(trimmed, size, padding = 0.04) {
  const inner = Math.max(1, Math.round(size * (1 - padding * 2)));
  const resized = await sharp(trimmed)
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .png({ compressionLevel: 9 })
    .toBuffer();
  if (inner === size) return resized;
  const offset = Math.round((size - inner) / 2);
  return sharp(resized)
    .extend({
      top: offset,
      bottom: size - inner - offset,
      left: offset,
      right: size - inner - offset,
      background: TRANSPARENT,
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

await mkdir(output, { recursive: true });
await mkdir(path.dirname(faviconOutput), { recursive: true });

const blue = await trimMaster(blueSource);
const white = await trimMaster(whiteSource);

// Multi-size Windows icon. Very small sizes get a little extra padding so the
// glass rim does not touch the taskbar edge.
const images = [];
for (const size of sizes) {
  const png = await renderIcon(blue, size, size <= 32 ? 0.02 : 0.05);
  images.push({ size, png });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // Reserved
header.writeUInt16LE(1, 2); // Icon
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(images.length * 16);
let offset = header.length + directory.length;
for (let index = 0; index < images.length; index += 1) {
  const { size, png } = images[index];
  const entry = directory.subarray(index * 16, (index + 1) * 16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // Palette size
  entry.writeUInt8(0, 3); // Reserved
  entry.writeUInt16LE(1, 4); // Colour planes
  entry.writeUInt16LE(32, 6); // Bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
}

await writeFile(
  path.join(output, 'icon.ico'),
  Buffer.concat([header, directory, ...images.map((image) => image.png)]),
);

// Standard square sizes used by stores, shortcuts, notifications and docs.
for (const size of masterIconSizes) {
  await writeFile(path.join(output, `icon-${size}.png`), await renderIcon(blue, size, 0.05));
}
await writeFile(path.join(output, 'icon.png'), await renderIcon(blue, 512, 0.05));

// Windows tray glyph. Electron downsizes this to the taskbar scale; keeping a
// crisp 32 px master avoids the muddy edge you get from resizing the full icon.
await writeFile(path.join(output, 'tray.png'), await renderIcon(blue, 32, 0.01));

// A white variant is useful on dark installers and store listings.
await writeFile(path.join(output, 'icon-white-256.png'), await renderIcon(white, 256, 0.05));

// Browser tab icon, generated from the same master so web and desktop match.
await writeFile(faviconOutput, await renderIcon(blue, 256, 0.04));

// Banner: render the vector layout, then place the real glass mark over the
// brand tiles so the release artwork uses the same icon as the installer.
const bannerSvg = await readFile(bannerSource);
for (const banner of banners) {
  const scale = banner.width / 1280;
  const base = await sharp(bannerSvg, { density: 192 })
    .resize(banner.width, banner.height, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const brand = await renderIcon(blue, Math.round(92 * scale), 0);
  const rail = await renderIcon(blue, Math.round(38 * scale), 0);
  const png = await sharp(base)
    .composite([
      { input: brand, left: Math.round(80 * scale), top: Math.round(52 * scale) },
      { input: rail, left: Math.round(722 * scale), top: Math.round(176 * scale) },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(output, banner.name), png);
}

console.log(
  `Wrote build/icon.ico (${sizes.join(', ')} px), icon-${masterIconSizes.join('.png, icon-')}.png, ` +
    `icon-white-256.png, tray.png, public/nimbus-icon.png, and ` +
    `${banners.map((banner) => banner.name).join(', ')}.`,
);
