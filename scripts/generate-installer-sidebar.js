/**
 * Generate NSIS wizard sidebar (164x314, 24-bit BMP) matching Pure Dark UI.
 * Run from prebuild:win so electron-builder picks up build/installerSidebar.bmp
 */
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

function writeBmp24(filePath, width, height, rgbaPixels /* Uint8ClampedArray length w*h*4 */) {
  const rowSize = Math.floor((width * 3 + 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;
  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(0, 6);
  buf.writeUInt32LE(54, 10);

  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30);
  buf.writeUInt32LE(pixelDataSize, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  buf.writeUInt32LE(0, 46);
  buf.writeUInt32LE(0, 50);

  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    let dest = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const i = (srcY * width + x) * 4;
      const r = rgbaPixels[i];
      const g = rgbaPixels[i + 1];
      const b = rgbaPixels[i + 2];
      buf[dest++] = b;
      buf[dest++] = g;
      buf[dest++] = r;
    }
  }

  fs.writeFileSync(filePath, buf);
}

async function main() {
  const root = path.join(__dirname, '..');
  const outDir = path.join(root, 'build');
  const outBmp = path.join(outDir, 'installerSidebar.bmp');
  const logoPath = path.join(root, 'logo.png');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const W = 164;
  const H = 314;
  const pixels = new Uint8ClampedArray(W * H * 4);

  // Pure Dark gradient canvas (#0b0b10 → slightly lighter)
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);
    const r = Math.round(11 + t * 10);
    const g = Math.round(11 + t * 12);
    const b = Math.round(16 + t * 28);
    for (let x = 0; x < W; x++) {
      const soft = Math.sin((x / W) * Math.PI) * 8;
      const i = (y * W + x) * 4;
      pixels[i] = Math.min(255, r + soft);
      pixels[i + 1] = Math.min(255, g + soft * 0.6);
      pixels[i + 2] = Math.min(255, b + soft * 1.2);
      pixels[i + 3] = 255;
    }
  }

  // Soft accent glow behind logo
  const cx = W / 2;
  const cy = H * 0.38;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - cx) / 55;
      const dy = (y - cy) / 70;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      const a = (1 - d) * 0.22;
      const i = (y * W + x) * 4;
      pixels[i] = Math.min(255, pixels[i] + 90 * a);
      pixels[i + 1] = Math.min(255, pixels[i + 1] + 106 * a);
      pixels[i + 2] = Math.min(255, pixels[i + 2] + 255 * a);
    }
  }

  if (fs.existsSync(logoPath)) {
    const logo = await Jimp.read(logoPath);
    const size = 72;
    logo.resize({ w: size, h: size });
    const lx = Math.round((W - size) / 2);
    const ly = Math.round(H * 0.38 - size / 2);
    const logoBitmap = logo.bitmap;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const li = (y * size + x) * 4;
        const a = logoBitmap.data[li + 3] / 255;
        if (a < 0.05) continue;
        const dx = lx + x;
        const dy = ly + y;
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
        const i = (dy * W + dx) * 4;
        pixels[i] = Math.round(logoBitmap.data[li] * a + pixels[i] * (1 - a));
        pixels[i + 1] = Math.round(logoBitmap.data[li + 1] * a + pixels[i + 1] * (1 - a));
        pixels[i + 2] = Math.round(logoBitmap.data[li + 2] * a + pixels[i + 2] * (1 - a));
      }
    }
  }

  writeBmp24(outBmp, W, H, pixels);
  // Same art for uninstall welcome page
  fs.copyFileSync(outBmp, path.join(outDir, 'uninstallerSidebar.bmp'));
  console.log('Generated', outBmp);
}

main().catch((err) => {
  console.error('Failed to generate installer sidebar:', err && (err.message || err));
  process.exit(1);
});
