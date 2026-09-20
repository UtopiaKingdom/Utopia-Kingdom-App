const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');
const toIco = require('to-ico');

async function buildIco() {
  const projectRoot = path.join(__dirname, '..');
  const src = path.join(projectRoot, 'logo.png');
  const outDir = path.join(projectRoot, 'build');
  const outIco = path.join(outDir, 'icon.ico');

  if (!fs.existsSync(src)) throw new Error('logo.png not found at ' + src);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Include Windows-recommended DPI sizes so taskbar icons stay sharp.
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngBuffers = [];

  for (const size of sizes) {
    const img = await Jimp.read(src);
    img.resize({ w: size, h: size });
    pngBuffers.push(await img.getBuffer('image/png'));
  }

  const ico = await toIco(pngBuffers);
  fs.writeFileSync(outIco, ico);
  console.log('Generated', outIco);
}

buildIco().catch((err) => {
  console.error('Failed to generate icon.ico:', err && (err.message || err));
  process.exit(1);
});
