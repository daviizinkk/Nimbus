import sharp from 'sharp';

const cloud = `
  <path d="M20 40.5h24a7.5 7.5 0 0 0 .9-14.95A11.5 11.5 0 0 0 22.6 24.6 7.5 7.5 0 0 0 20 40.5Z" fill="#fff" opacity=".96"/>
  <path d="M25 45.5h14" stroke="#fff" stroke-width="3.5" stroke-linecap="round" opacity=".7"/>
`;

function iconSvg(size, { rounded = true, maskable = false } = {}) {
  const radius = rounded ? Math.round(size * 0.266) : 0;
  const transform = maskable
    ? `translate(${size / 2 - 32 * 9} ${size / 2 - 33 * 9}) scale(9)`
    : `translate(${size / 2 - 32 * 8} ${size / 2 - 33 * 8}) scale(8)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#6366f1"/>
        <stop offset="1" stop-color="#06b6d4"/>
      </linearGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${radius}" fill="url(#brand)"/>
    <g transform="${transform}">${cloud}</g>
  </svg>`;
}

async function png(svg, size, file) {
  await sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toFile(file);
}

await Promise.all([
  png(iconSvg(512), 512, 'public/icon-512.png'),
  png(iconSvg(512), 192, 'public/icon-192.png'),
  png(iconSvg(512, { rounded: false, maskable: true }), 512, 'public/icon-maskable-512.png'),
  png(iconSvg(512), 180, 'public/apple-touch-icon.png'),
]);

await sharp('public/nimbus-banner.svg', { density: 192 })
  .resize(1200, 630, { fit: 'cover', position: 'centre' })
  .png({ compressionLevel: 9 })
  .toFile('public/nimbus-og.png');

console.log('PWA icons and social preview generated.');
