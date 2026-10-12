import fs from 'node:fs';
import path from 'node:path';

const apiBaseUrl = (process.env.BATALLA_API_URL || 'https://batalla-psicologica-api.onrender.com').replace(/\/+$/, '');
const publicUrl = (process.env.BATALLA_PUBLIC_URL || 'https://mvisions.github.io/batalla-psicologica/').replace(/\/+$/, '');
const publicPath = `${new URL(publicUrl).pathname.replace(/\/+$/, '')}/`;
const assetVersion = (process.env.GITHUB_SHA || 'local').slice(0, 12);

for (const [name, value] of [['BATALLA_API_URL', apiBaseUrl], ['BATALLA_PUBLIC_URL', publicUrl]]) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error(`${name} debe usar HTTPS`);
}

fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('public', 'dist', { recursive: true });
const indexPath = path.join('dist', 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');
const versionedIndex = indexHtml.replace("./scene3d.js'", `./scene3d.js?v=${assetVersion}'`);
if (versionedIndex === indexHtml) throw new Error('No se encontró la importación de scene3d.js');
fs.writeFileSync(indexPath, versionedIndex);
fs.writeFileSync(path.join('dist', 'app-config.js'), `window.BATALLA_CONFIG = Object.freeze(${JSON.stringify({ apiBaseUrl, publicUrl })});\n`);
const manifestPath = path.join('dist', 'manifest.webmanifest');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.start_url = publicPath;
manifest.scope = publicPath;
manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: `${publicPath}${icon.src.replace(/^\/+/, '')}` }));
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join('dist', '.nojekyll'), '');
console.log(`GitHub Pages: ${publicUrl}`);
console.log(`API Render: ${apiBaseUrl}`);
