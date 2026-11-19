// Builds catalog/: free 3D furniture and decor as small GLB files + thumbnails + catalog.json.
// Sources: Poly Haven (CC0, photo-scanned, real-world scale), Kenney Furniture Kit (CC0, simple style, covers
// kitchen and bathroom) and a few Khronos glTF sample models (CC BY 4.0). Runs in GitHub Actions.
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
import { NodeIO } from '@gltf-transform/core'; import { ALL_EXTENSIONS } from '@gltf-transform/extensions'; import { getBounds } from '@gltf-transform/core';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const OUT = 'catalog', TMP = '/tmp/cat'; fs.mkdirSync(OUT + '/m', { recursive: true }); fs.mkdirSync(OUT + '/t', { recursive: true });
const UA = { 'User-Agent': 'PicAliveRoom-catalog/1.0 (github.com/afaqali11/picalive)' };
const get = async (u, t = 'json') => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + u); return t === 'json' ? r.json() : t === 'text' ? r.text() : Buffer.from(await r.arrayBuffer()); } catch (e) { if (i === 3) throw e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); } } };
const gt = (...a) => execFileSync('npx', ['--yes', '@gltf-transform/cli@4.1.1', ...a], { stdio: ['ignore', 'ignore', 'inherit'] });
const old = fs.existsSync(OUT + '/catalog.json') ? Object.fromEntries(JSON.parse(fs.readFileSync(OUT + '/catalog.json')).items.map(i => [i.id, i])) : {};
const MAXMB = 7, out = []; let total = 0;
async function size(file) { const doc = await io.read(file), b = getBounds(doc.getRoot().listScenes()[0]); return b.max.map((v, i) => +(v - b.min[i]).toFixed(3)); }
async function build(id, files, src, meta) {
  const glb = path.join(OUT, 'm', id + '.glb');
  if (fs.existsSync(glb) && old[id] && old[id].size) { const mb = fs.statSync(glb).size / 1e6; total += mb; out.push({ ...old[id], ...meta, id, src, mb: +mb.toFixed(2) }); return; }
  const dir = path.join(TMP, id); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const [rel, from] of files) { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof from === 'string' ? await get(from, 'buf') : from); }
  const main = path.join(dir, files[0][0]);
  gt('optimize', main, glb, '--compress', 'meshopt', '--texture-compress', 'false', '--texture-size', '1024', '--simplify-error', '0.0005');
  const mb = fs.statSync(glb).size / 1e6; if (mb > MAXMB) { console.log('too big', id, mb); fs.rmSync(glb); return; }
  const sz = await size(glb); total += mb; out.push({ id, ...meta, src, size: sz, mb: +mb.toFixed(2) }); console.log('ok', id, mb.toFixed(2), 'MB', sz.join('x'));
}
// 1) Poly Haven: everything that belongs inside a home
const ph = await get('https://api.polyhaven.com/assets?t=models');
const IN = ['furniture', 'seating', 'table', 'bed', 'shelves', 'lighting', 'decorative', 'potted plants', 'vases', 'flowers', 'wall decoration', 'books', 'dishes', 'electronics', 'appliances', 'office', 'instrument', 'containers', 'succulent'];
const OUTC = ['rigged', 'weapons', 'firearms', 'food', 'tools', 'rocks', 'trees', 'ground cover', 'grass', 'buildings', 'structures', 'ships', 'creature', 'collection: moon'];
const OUTN = /barrel|crate|pallet|jerrycan|gas can|fuel|drum|bucket|hose|lifebuoy|fire alarm|extinguisher|traffic|cone|scaffold|tyre|tire|garbage|dumpster|trash|bin bag|cinder|brick|wheel|engine|generator|compressor|toolbox|spray paint|oil can|propane|security light|fuse|meter|street|signal|anchor|buoy|rope|chain/i;
for (const [id, a] of Object.entries(ph)) {
  const c = a.categories || []; if (!c.some(x => IN.includes(x)) || c.some(x => OUTC.includes(x)) || OUTN.test(a.name)) continue;
  if (c.includes('industrial') && !c.some(x => ['furniture', 'lighting', 'seating', 'table', 'shelves'].includes(x))) continue;
  try {
    const f = await get('https://api.polyhaven.com/files/' + id), g = f.gltf && f.gltf['1k'] && f.gltf['1k'].gltf; if (!g) continue;
    const files = [[path.basename(new URL(g.url).pathname), g.url], ...Object.entries(g.include || {}).map(([rel, v]) => [rel, v.url])];
    await build(id, files, 'Poly Haven (CC0)', { name: a.name, cats: c, tags: a.tags || [], style: 'real' });
    const th = path.join(OUT, 't', id + '.png'); if (!fs.existsSync(th)) fs.writeFileSync(th, await get('https://cdn.polyhaven.com/asset_img/thumbs/' + id + '.png?width=256&height=256', 'buf'));
  } catch (e) { console.log('fail', id, e.message.slice(0, 200)); }
}
// 2) Kenney Furniture Kit (CC0): kitchens, bathrooms, beds, doors, windows in a clean simple style
try {
  const page = await get('https://kenney.nl/assets/furniture-kit', 'text'), m = page.match(/https:\/\/kenney\.nl\/media\/pages\/assets\/furniture-kit\/[^"']+\.zip/);
  if (!m) throw new Error('zip link not found');
  const zf = '/tmp/kenney.zip', kd = '/tmp/kenney'; fs.writeFileSync(zf, await get(m[0], 'buf')); fs.rmSync(kd, { recursive: true, force: true }); execFileSync('unzip', ['-q', zf, '-d', kd]);
  const all = execFileSync('find', [kd, '-type', 'f']).toString().trim().split('\n');
  const glbs = all.filter(f => /\.glb$/i.test(f)), pngs = all.filter(f => /\.png$/i.test(f));
  console.log('kenney glbs', glbs.length, 'pngs', pngs.length, 'sample', pngs.slice(0, 5).join(' | '));
  const bed = glbs.find(f => /bedDouble\.glb$/i.test(f)); let k = 1; if (bed) { const s = await size(bed); k = 2.05 / Math.max(s[0], s[2]); } console.log('kenney scale', k);
  const nice = n => n.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  for (const f of glbs) {
    const base = path.basename(f, '.glb'), id = 'k_' + base;
    try {
      const sc = path.join('/tmp', id + '.glb'), d = await io.read(f);
      for (const n of d.getRoot().listScenes()[0].listChildren()) { const s = n.getScale(), t = n.getTranslation(); n.setScale([s[0] * k, s[1] * k, s[2] * k]); n.setTranslation([t[0] * k, t[1] * k, t[2] * k]); }
      await io.write(sc, d);
      await build(id, [[id + '.glb', fs.readFileSync(sc)]], 'Kenney Furniture Kit (CC0)', { name: nice(base), cats: ['kenney'], tags: [base], style: 'simple' });
      const p = pngs.find(x => path.basename(x, '.png').toLowerCase() === base.toLowerCase()) || pngs.find(x => path.basename(x).toLowerCase().startsWith(base.toLowerCase() + '_'));
      if (p) fs.copyFileSync(p, path.join(OUT, 't', id + '.png'));
    } catch (e) { console.log('fail', id, e.message.slice(0, 200)); }
  }
} catch (e) { console.log('kenney fail', e.message); }
// 3) Khronos samples (CC BY 4.0)
const KH = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';
for (const [id, name, cats] of [['GlamVelvetSofa', 'Glam Velvet Sofa', ['furniture', 'seating']], ['SheenChair', 'Fabric Chair', ['furniture', 'seating']], ['SheenWoodLeatherSofa', 'Wood and Leather Sofa', ['furniture', 'seating']],
  ['ChairDamaskPurplegold', 'Damask Chair', ['furniture', 'seating']], ['SpecularSilkPouf', 'Silk Pouf', ['furniture', 'seating']], ['GlassVaseFlowers', 'Vase with Flowers', ['decorative', 'vases']],
  ['DiffuseTransmissionPlant', 'House Plant', ['potted plants']], ['CommercialRefrigerator', 'Glass Door Fridge', ['appliances']], ['Lantern', 'Lantern', ['lighting']], ['GlassHurricaneCandleHolder', 'Hurricane Candle Holder', ['decorative']], ['IridescentDishWithOlives', 'Dish with Olives', ['dishes']]]) {
  try { await build(id, [[id + '.glb', KH + id + '/glTF-Binary/' + id + '.glb']], 'Khronos glTF samples (CC BY 4.0)', { name, cats, tags: [], style: 'real' });
    const th = path.join(OUT, 't', id + '.png'); if (!fs.existsSync(th)) fs.writeFileSync(th, await get(KH + id + '/screenshot/screenshot.jpg', 'buf').catch(() => get(KH + id + '/screenshot/screenshot.png', 'buf')));
  } catch (e) { console.log('fail', id, e.message.slice(0, 200)); }
}
fs.writeFileSync(OUT + '/catalog.json', JSON.stringify({ made: new Date().toISOString(), items: out }));
console.log('total', out.length, total.toFixed(1), 'MB');
