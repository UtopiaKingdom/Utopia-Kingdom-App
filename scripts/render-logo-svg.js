const fs = require('fs');
const path = require('path');

async function main() {
  let resvg;
  try {
    resvg = require('@resvg/resvg-js');
  } catch (_) {
    console.error('Missing @resvg/resvg-js. Run: npm install --no-save @resvg/resvg-js');
    process.exit(1);
  }

  const dir = path.join(__dirname, '..', 'brand', 'logo-concepts');
  const svgs = fs.readdirSync(dir).filter((f) => f.endsWith('.svg') && /^(v2|v3)-/.test(f));

  for (const file of svgs) {
    const svgPath = path.join(dir, file);
    const pngPath = path.join(dir, file.replace(/\.svg$/, '.png'));
    const svg = fs.readFileSync(svgPath, 'utf8');
    const r = new resvg.Resvg(svg, { fitTo: { mode: 'width', value: 512 } });
    fs.writeFileSync(pngPath, r.render().asPng());
    console.log('Rendered', pngPath);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
