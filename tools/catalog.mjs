// Builds catalog/: realistic free 3D furniture and decor as small GLB files + thumbnails + catalog.json.
// Sources: Poly Haven (CC0, photo-scanned, real-world scale) and a few Khronos glTF sample models (CC BY 4.0).
// Runs in GitHub Actions (see .github/workflows/catalog.yml).
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
const OUT = 'catalog', TMP = '/tmp/cat'; fs.mkdirSync(OUT + '/m', { recursive: true }); fs.mkdirSync(OUT + '/t', { recursive: true });
const UA = { 'User-Agent': 'PicAliveRoom-catalog/1.0 (github.com/afaqali11/picalive)' };
const get = async (u, t = 'json') => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + u); return t === 'json' ? r.json() : Buffer.from(await r.arrayBuffer()); } catch (e) { if (i === 3) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const gt = (...a) => execFileSync('npx', ['--yes', '@gltf-transform/cli@4.1.1', ...a], { stdio: ['ignore', 'ignore', 'inherit'] });
const keep = c => c.includes('furniture') || c.includes('potted plants') || c.includes('vases') || c.includes('wall decoration') || (c.includes('lighting') && c.includes('decorative'));
const skip = c => c.includes('rigged') || c.includes('weapons') || c.includes('food');
const MAXMB = 7, out = []; let total = 0;
async function build(id, files, src, meta) {
  const dir = path.join(TMP, id); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const [rel, url] of files) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, await get(url, 'buf')); }
  const main = path.join(dir, files[0][0]), glb = path.join(OUT, 'm', id + '.glb');
  gt('optimize', main, glb, '--compress', 'meshopt', '--texture-compress', 'false', '--texture-size', '1024', '--simplify-error', '0.0005');
  const mb = fs.statSync(glb).size / 1e6; if (mb > MAXMB) { console.log('too big', id, mb); fs.rmSync(glb); return; }
  total += mb; out.push({ id, ...meta, src, mb: +mb.toFixed(2) }); console.log('ok', id, mb.toFixed(2), 'MB');
}
const ph = await get('https://api.polyhaven.com/assets?t=models');
const cats = {}; for (const a of Object.values(ph)) for (const c of a.categories || []) cats[c] = (cats[c] || 0) + 1;
console.log('categories', JSON.stringify(cats));
for (const [id, a] of Object.entries(ph)) {
  const c = a.categories || []; if (!keep(c) || skip(c) || total > 320) continue;
  try {
    const f = await get('https://api.polyhaven.com/files/' + id), g = f.gltf && f.gltf['1k'] && f.gltf['1k'].gltf; if (!g) continue;
    const files = [[path.basename(new URL(g.url).pathname), g.url], ...Object.entries(g.include || {}).map(([rel, v]) => [rel, v.url])];
    await build(id, files, 'Poly Haven (CC0)', { name: a.name, cats: a.categories || [], tags: a.tags || [] });
    fs.writeFileSync(path.join(OUT, 't', id + '.png'), await get('https://cdn.polyhaven.com/asset_img/thumbs/' + id + '.png?width=256&height=256', 'buf'));
  } catch (e) { console.log('fail', id, e.message); }
}
const KH = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';
for (const [id, name, cats] of [['GlamVelvetSofa', 'Glam Velvet Sofa', ['furniture', 'seating']], ['SheenChair', 'Fabric Chair', ['furniture', 'seating']], ['SheenWoodLeatherSofa', 'Wood and Leather Sofa', ['furniture', 'seating']],
  ['ChairDamaskPurplegold', 'Damask Chair', ['furniture', 'seating']], ['SpecularSilkPouf', 'Silk Pouf', ['furniture', 'seating']], ['AnisotropyBarnLamp', 'Barn Lamp', ['decor', 'lighting']],
  ['GlassVaseFlowers', 'Vase with Flowers', ['decor', 'plants']], ['DiffuseTransmissionPlant', 'House Plant', ['decor', 'plants']]]) {
  try { await build(id, [[id + '.glb', KH + id + '/glTF-Binary/' + id + '.glb']], 'Khronos glTF samples (CC BY 4.0)', { name, cats, tags: [] });
    const sc = await get(KH + id + '/screenshot/screenshot.jpg', 'buf').catch(() => get(KH + id + '/screenshot/screenshot.png', 'buf')); fs.writeFileSync(path.join(OUT, 't', id + '.png'), sc);
  } catch (e) { console.log('fail', id, e.message); }
}
fs.writeFileSync(OUT + '/catalog.json', JSON.stringify({ made: new Date().toISOString(), items: out }));
console.log('total', out.length, out.reduce((s, x) => s + x.mb, 0).toFixed(1), 'MB');
