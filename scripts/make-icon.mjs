#!/usr/bin/env node
/**
 * Builds the Windows application icon and the release banner artwork from the
 * same vector sources as the web app. Keeping artwork in one place means the
 * installer, taskbar, favicon and release page always match.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const iconSource = path.join(root, 'public', 'favicon.svg');
const bannerSource = path.join(root, 'public', 'nimbus-banner.svg');
const output = path.join(root, 'build');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const masterIconSizes = [256, 512, 1024];
const banners = [
  { name: 'banner-1280x640.png', width: 1280, height: 640 },
  { name: 'banner-2560x1280.png', width: 2560, height: 1280 },
];

await mkdir(output, { recursive: true });
const svg = await readFile(iconSource);

const images = [];
for (const size of sizes) {
  const density = Math.max(96, Math.round((size / 64) * 384));
  const png = await sharp(svg, { density })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
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

await writeFile(path.join(output, 'icon.ico'), Buffer.concat([header, directory, ...images.map((image) => image.png)]));

// Store the standard square icon sizes used by stores, shortcuts and docs.
const large = await sharp(svg, { density: 512 })
  .resize(512, 512, { fit: 'contain' })
  .png({ compressionLevel: 9 })
  .toBuffer();
for (const size of masterIconSizes) {
  const png = await sharp(svg, { density: 1152 })
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(output, `icon-${size}.png`), png);
}
await writeFile(path.join(output, 'icon.png'), large);

const bannerSvg = await readFile(bannerSource);
for (const banner of banners) {
  const png = await sharp(bannerSvg, { density: 192 })
    .resize(banner.width, banner.height, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(output, banner.name), png);
}

console.log(
  `Wrote build/icon.ico (${sizes.join(', ')} px), icon-${masterIconSizes.join('.png, icon-')}.png, ` +
    `and ${banners.map((banner) => banner.name).join(', ')}.`,
);
