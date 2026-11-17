/* PicAlive AI core: understands a picture on the device.
   - depth.onnx : Depth Anything V2 Small (Apache-2.0), gives a depth map
   - seg.onnx   : DeepLabV3 MobileNetV2 trained on ADE20K (150 kinds of things), tells sky, water, plants, people, lights...
   From those it builds a small "scene" (depth layers, filled background, element masks) that the renderer animates.
   Runs inside a Web Worker (ai/worker.js) or on the main thread as a fallback. Needs `ort` (onnxruntime-web wasm) loaded first. */
(function (G) {
'use strict';
const VER = '1';
const SIZES = { seg: 4.7e6, depth: 28.6e6, cut: 2.35e6 };
const GROUPS = {            // ADE20K class numbers (0 = other)
  sky: [[3, 1]],
  water: [[22, 1], [27, 1], [129, 1], [110, 1], [61, 1]],
  fall: [[114, 1], [105, 1]],
  foliage: [[5, 1], [18, 1], [73, 1], [67, 1], [10, 0.5], [30, 0.4]],
  glow: [[37, 1], [83, 1], [86, 1], [88, 1], [135, 1], [137, 1], [90, 0.6], [131, 0.6], [142, 0.6], [144, 0.6]],
  fireplace: [[50, 1]],
  cloth: [[19, 1], [150, 1], [93, 1]],
  alive: [[13, 1], [127, 1]]
};
const NAMES = 'other,wall,building,sky,floor,tree,ceiling,road,bed,windowpane,grass,cabinet,sidewalk,person,earth,door,table,mountain,plant,curtain,chair,car,water,painting,sofa,shelf,house,sea,mirror,rug,field,armchair,seat,fence,desk,rock,wardrobe,lamp,bathtub,railing,cushion,base,box,column,signboard,chest of drawers,counter,sand,sink,skyscraper,fireplace,refrigerator,grandstand,path,stairs,runway,case,pool table,pillow,screen door,stairway,river,bridge,bookcase,blind,coffee table,toilet,flower,book,hill,bench,countertop,stove,palm,kitchen island,computer,swivel chair,boat,bar,arcade machine,hovel,bus,towel,light,truck,tower,chandelier,awning,streetlight,booth,television,airplane,dirt track,apparel,pole,land,bannister,escalator,ottoman,bottle,buffet,poster,stage,van,ship,fountain,conveyer belt,canopy,washer,plaything,swimming pool,stool,barrel,basket,waterfall,tent,bag,minibike,cradle,oven,ball,food,step,tank,trade name,microwave,pot,animal,bicycle,lake,dishwasher,screen,blanket,sculpture,hood,sconce,vase,traffic light,tray,ashcan,fan,pier,crt screen,plate,monitor,bulletin board,shower,radiator,glass,clock,flag'.split(',');

let sessions = {};
const now = () => (G.performance ? performance.now() : Date.now());

async function fetchCached(url, onp) {
  let cache = null;
  try {
    cache = await caches.open('picalive-ai-' + VER);
    const hit = await cache.match(url);
    if (hit) { const b = await hit.arrayBuffer(); if (b.byteLength > 100000) return b; }
  } catch (e) { cache = null; }
  const res = await fetch(url);
  if (!res.ok) throw new Error('Download failed (' + res.status + ')');
  let buf;
  if (res.body && res.body.getReader) {
    const rd = res.body.getReader(), chunks = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); n += value.length; if (onp) onp(n); }
    const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
    buf = all.buffer;
  } else buf = await res.arrayBuffer();
  if (buf.byteLength < 100000) throw new Error('Download was cut short');
  if (cache) { try { await cache.put(url, new Response(buf.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) {} }
  return buf;
}

/* models load on first use and stay cached on the phone */
const loading = {};
function ensure(base, names, onp) {
  ort.env.wasm.wasmPaths = base; ort.env.wasm.numThreads = 1; ort.env.logLevel = 'error';
  const need = names.filter(n => !sessions[n]);
  if (!need.length) return Promise.resolve();
  const key = need.join('+');
  if (loading[key]) return loading[key];
  const p = loading[key] = (async () => {
    const tot = need.reduce((a, n) => a + SIZES[n], 0), got = {};
    const rep = () => onp && onp({ stage: 'download', frac: Math.min(1, need.reduce((a, n) => a + (got[n] || 0), 0) / tot) });
    const bufs = {};
    for (const n of need) { bufs[n] = await fetchCached(base + n + '.onnx', b => { got[n] = Math.min(b, SIZES[n]); rep(); }); got[n] = SIZES[n]; rep(); }
    onp && onp({ stage: 'load', frac: 0 });
    const opt = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    for (const n of need) if (!sessions[n]) sessions[n] = await ort.InferenceSession.create(bufs[n], opt);
    onp && onp({ stage: 'load', frac: 1 });
  })();
  p.then(() => { delete loading[key]; }, () => { delete loading[key]; });
  return p;
}
function init(base, onp) { return ensure(base, ['seg', 'depth'], onp); }

/* ---------- small image helpers (single channel Float32 unless said) ---------- */
function resizeF(src, sw, sh, dw, dh) {
  const dst = new Float32Array(dw * dh), fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let v = (y + 0.5) * fy - 0.5; if (v < 0) v = 0; if (v > sh - 1) v = sh - 1;
    const y0 = v | 0, y1 = y0 + 1 < sh ? y0 + 1 : y0, wy = v - y0;
    for (let x = 0; x < dw; x++) {
      let u = (x + 0.5) * fx - 0.5; if (u < 0) u = 0; if (u > sw - 1) u = sw - 1;
      const x0 = u | 0, x1 = x0 + 1 < sw ? x0 + 1 : x0, wx = u - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      dst[y * dw + x] = (a + (b - a) * wx) * (1 - wy) + (c + (d - c) * wx) * wy;
    }
  }
  return dst;
}
/* RGBA bytes -> 3 float planes [r,g,b] in 0..1 at a new size (area-ish: 2 bilinear taps blend is enough here) */
function rgbPlanes(rgba, sw, sh, dw, dh) {
  const n = sw * sh, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) { r[i] = rgba[j] / 255; g[i] = rgba[j + 1] / 255; b[i] = rgba[j + 2] / 255; }
  if (sw === dw && sh === dh) return [r, g, b];
  let cw = sw, ch = sh, pl = [r, g, b];
  while (cw >= dw * 2 && ch >= dh * 2) {            // halve first so big shrink does not alias
    const nw = cw >> 1, nh = ch >> 1;
    pl = pl.map(p => { const o = new Float32Array(nw * nh); for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) { const i = (y * 2) * cw + x * 2; o[y * nw + x] = (p[i] + p[i + 1] + p[i + cw] + p[i + cw + 1]) * 0.25; } return o; });
    cw = nw; ch = nh;
  }
  return pl.map(p => resizeF(p, cw, ch, dw, dh));
}
function box(src, w, h, r) {
  const tmp = new Float32Array(w * h), dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0, c = 0; const o = y * w;
    for (let x = 0; x <= r && x < w; x++) { s += src[o + x]; c++; }
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / c;
      const add = x + r + 1, rem = x - r;
      if (add < w) { s += src[o + add]; c++; }
      if (rem >= 0) { s -= src[o + rem]; c--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let y = 0; y <= r && y < h; y++) { s += tmp[y * w + x]; c++; }
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = s / c;
      const add = y + r + 1, rem = y - r;
      if (add < h) { s += tmp[add * w + x]; c++; }
      if (rem >= 0) { s -= tmp[rem * w + x]; c--; }
    }
  }
  return dst;
}
function minmax(src, w, h, r, isMax) {             // square window
  const tmp = new Float32Array(w * h), dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = src[y * w + x]; const a = x - r < 0 ? 0 : x - r, b = x + r >= w ? w - 1 : x + r;
    for (let k = a; k <= b; k++) { const v = src[y * w + k]; if (isMax ? v > m : v < m) m = v; }
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) { const a = y - r < 0 ? 0 : y - r, b = y + r >= h ? h - 1 : y + r;
    for (let x = 0; x < w; x++) { let m = tmp[y * w + x]; for (let k = a; k <= b; k++) { const v = tmp[k * w + x]; if (isMax ? v > m : v < m) m = v; } dst[y * w + x] = m; } }
  return dst;
}
/* guided filter: makes a soft mask follow the picture's own edges */
function makeGuide(I, w, h, r) { const mI = box(I, w, h, r), II = new Float32Array(w * h); for (let i = 0; i < II.length; i++) II[i] = I[i] * I[i]; return { I, mI, mII: box(II, w, h, r), w, h, r }; }
function guided(gd, p, eps) {
  const { I, mI, mII, w, h, r } = gd, n = w * h, Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) Ip[i] = I[i] * p[i];
  const mp = box(p, w, h, r), mIp = box(Ip, w, h, r), a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const va = mII[i] - mI[i] * mI[i]; a[i] = (mIp[i] - mI[i] * mp[i]) / (va + eps); b[i] = mp[i] - a[i] * mI[i]; }
  const ma = box(a, w, h, r), mb = box(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) { const v = ma[i] * I[i] + mb[i]; q[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return q;
}
const sstep = (a, b, x) => { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); };
/* fill holes of 3 colour planes from the valid pixels around them (push-pull pyramid) */
function pushPull(pl, wgt, w, h) {
  if (w <= 1 && h <= 1) return;
  const nw = Math.max(1, (w + 1) >> 1), nh = Math.max(1, (h + 1) >> 1), nwgt = new Float32Array(nw * nh), npl = pl.map(() => new Float32Array(nw * nh));
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let s = 0, c0 = 0, c1 = 0, c2 = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const xx = x * 2 + dx, yy = y * 2 + dy; if (xx >= w || yy >= h) continue; const i = yy * w + xx, k = wgt[i]; s += k; c0 += pl[0][i] * k; c1 += pl[1][i] * k; c2 += pl[2][i] * k; }
    const j = y * nw + x; if (s > 0) { npl[0][j] = c0 / s; npl[1][j] = c1 / s; npl[2][j] = c2 / s; } nwgt[j] = s > 1 ? 1 : s;
  }
  pushPull(npl, nwgt, nw, nh);
  const up = npl.map(p => resizeF(p, nw, nh, w, h));
  for (let i = 0; i < w * h; i++) { const k = wgt[i]; if (k < 1) { pl[0][i] = pl[0][i] * k + up[0][i] * (1 - k); pl[1][i] = pl[1][i] * k + up[1][i] * (1 - k); pl[2][i] = pl[2][i] * k + up[2][i] * (1 - k); } }
}

/* ---------- the two networks ---------- */
async function runSeg(rgba, w, h) {
  const S = 513, sc = S / Math.max(w, h), W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc));
  const pl = rgbPlanes(rgba, w, h, W, H), inp = new Float32Array(S * S * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x, o = (y * S + x) * 3; inp[o] = pl[0][i] * 2 - 1; inp[o + 1] = pl[1][i] * 2 - 1; inp[o + 2] = pl[2][i] * 2 - 1; }
  const s = sessions.seg, out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', inp, [1, S, S, 3]) });
  const t = out[s.outputNames[0]], L = t.data, oh = t.dims[1], ow = t.dims[2], C = t.dims[3];
  const vw = Math.max(1, Math.min(ow, Math.round(W / S * ow))), vh = Math.max(1, Math.min(oh, Math.round(H / S * oh)));
  const lut = {}; for (const g in GROUPS) { lut[g] = new Float32Array(C); for (const [c, wt] of GROUPS[g]) lut[g][c] = wt; }
  const masks = {}; for (const g in GROUPS) masks[g] = new Float32Array(vw * vh);
  const hist = new Float32Array(C), pr = new Float32Array(C), keys = Object.keys(GROUPS);
  for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
    const o = (y * ow + x) * C; let mx = -1e9, am = 0;
    for (let c = 0; c < C; c++) { const v = L[o + c]; if (v > mx) { mx = v; am = c; } }
    let sum = 0; for (let c = 0; c < C; c++) { const e = Math.exp(L[o + c] - mx); pr[c] = e; sum += e; }
    hist[am]++;
    const i = y * vw + x;
    for (const g of keys) { const lt = lut[g]; let m = 0; for (const [c] of GROUPS[g]) m += pr[c] * lt[c]; masks[g][i] = m / sum; }
  }
  const top = []; for (let c = 0; c < C; c++) if (hist[c] / (vw * vh) > 0.01) top.push([NAMES[c] || ('c' + c), +(hist[c] / (vw * vh)).toFixed(3)]);
  top.sort((a, b) => b[1] - a[1]);
  return { masks, vw, vh, top, hist, n: vw * vh };
}
async function runDepth(rgba, w, h, L) {
  const sc = L / Math.max(w, h), W = Math.max(14, Math.round(w * sc / 14) * 14), H = Math.max(14, Math.round(h * sc / 14) * 14);
  const pl = rgbPlanes(rgba, w, h, W, H), n = W * H, inp = new Float32Array(3 * n), mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) { const p = pl[c], o = c * n; for (let i = 0; i < n; i++) inp[o + i] = (p[i] - mean[c]) / std[c]; }
  const s = sessions.depth, out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, H, W]) });
  const t = out[s.outputNames[0]], d = t.data, dh = t.dims[t.dims.length - 2], dw = t.dims[t.dims.length - 1];
  // robust 0..1 (1 = near)
  let mn = Infinity, mx = -Infinity; for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const B = 512, hg = new Uint32Array(B), rg = (mx - mn) || 1; for (let i = 0; i < d.length; i++) hg[Math.min(B - 1, ((d[i] - mn) / rg * B) | 0)]++;
  let lo = 0, hi = B - 1, acc = 0; const cut = d.length * 0.004;
  for (acc = 0; lo < B; lo++) { acc += hg[lo]; if (acc > cut) break; }
  for (acc = 0; hi > 0; hi--) { acc += hg[hi]; if (acc > cut) break; }
  const a = mn + lo / B * rg, b = mn + (hi + 1) / B * rg, o = new Float32Array(d.length), k = 1 / ((b - a) || 1);
  for (let i = 0; i < d.length; i++) { const v = (d[i] - a) * k; o[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  return { d: o, w: dw, h: dh, spread: (b - a) / (Math.abs(b) + Math.abs(a) + 1e-6) };
}

/* ---------- main entry: picture pixels -> scene ---------- */
async function analyze(rgba, w, h, onp, opt) {
  opt = opt || {};
  const T = { t0: now() }, P = (stage, frac) => onp && onp({ stage, frac });
  const long = Math.max(w, h), ms = Math.min(1, 512 / long), mw = Math.max(16, Math.round(w * ms)), mh = Math.max(16, Math.round(h * ms)), N = mw * mh;
  P('seg', 0);
  const sg = await runSeg(rgba, w, h); T.seg = now() - T.t0;
  // slow phone -> smaller depth picture so the wait stays short
  const L = opt.depthSize || (T.seg > 3200 ? 322 : T.seg > 1500 ? 392 : 518);
  P('depth', 0);
  const t1 = now(), dp = await runDepth(rgba, w, h, L); T.depth = now() - t1;
  P('build', 0);
  const t2 = now();
  const col = rgbPlanes(rgba, w, h, mw, mh), lum = new Float32Array(N);
  let meanLum = 0; for (let i = 0; i < N; i++) { lum[i] = 0.299 * col[0][i] + 0.587 * col[1][i] + 0.114 * col[2][i]; meanLum += lum[i]; } meanLum /= N;
  const d0 = resizeF(dp.d, dp.w, dp.h, mw, mh);

  /* masks: upsample then snap to picture edges */
  const gd = makeGuide(lum, mw, mh, Math.max(4, Math.round(Math.max(mw, mh) / 48)));
  const M = {};
  for (const g in sg.masks) { const up = resizeF(sg.masks[g], sg.vw, sg.vh, mw, mh); const q = guided(gd, up, 0.004); for (let i = 0; i < N; i++) q[i] = sstep(0.35, 0.8, q[i]); M[g] = q; }
  // sky is always far: remove "sky" that the depth says is close (signs, white walls)
  for (let i = 0; i < N; i++) M.sky[i] *= 1 - sstep(0.25, 0.5, d0[i]);
  // fire: hot bright colours, only inside a fireplace or in a dark scene
  const fire = new Float32Array(N), fpl = box(M.fireplace, mw, mh, Math.round(Math.max(mw, mh) / 40));
  const dark = meanLum < 0.3 ? 1 : 0;
  for (let i = 0; i < N; i++) {
    const r = col[0][i], g = col[1][i], b = col[2][i];
    const hot = sstep(0.62, 0.9, r) * sstep(0.2, 0.55, r - b) * (r >= g ? 1 : 0) * (g >= b ? 1 : 0.3);
    const gate = Math.max(sstep(0.05, 0.25, fpl[i]), dark * (1 - M.sky[i]) * (1 - M.alive[i]) * (1 - M.glow[i]));
    fire[i] = hot * gate;
  }
  M.fire = box(fire, mw, mh, 1); delete M.fireplace;
  for (let i = 0; i < N; i++) { const f = M.fire[i]; M.glow[i] = Math.max(M.glow[i] * (1 - f), 0); M.foliage[i] *= 1 - M.alive[i]; }

  /* layers */
  const dFG = minmax(d0, mw, mh, 2, true);                 // grow near things a little so their rim stays with them
  const far4 = minmax(d0, mw, mh, 4, true), keep = new Float32Array(N);
  for (let i = 0; i < N; i++) keep[i] = 1 - sstep(0.035, 0.09, far4[i] - d0[i]);   // far pixels next to a near thing: front layer lets go of them
  // cliffs and what is behind them
  const mn1 = minmax(d0, mw, mh, 1, false), mx1 = minmax(d0, mw, mh, 1, true), BIG = 9, farAt = new Float32Array(N);
  for (let i = 0; i < N; i++) farAt[i] = (mx1[i] - mn1[i] > 0.07) ? mn1[i] : BIG;
  const R = Math.max(5, Math.round(Math.max(mw, mh) * 0.055));   // how far the front layer can uncover the back (the most the view shifts)
  const behind = minmax(farAt, mw, mh, R, false), hole = new Float32Array(N), dBG = new Float32Array(N);
  let holeN = 0;
  for (let i = 0; i < N; i++) { const hl = behind[i] < BIG && d0[i] - behind[i] > 0.06; hole[i] = hl ? 1 : 0; dBG[i] = hl ? behind[i] : d0[i]; if (hl) holeN++; }
  const dBGs = box(dBG, mw, mh, 2); for (let i = 0; i < N; i++) if (hole[i]) dBG[i] = Math.min(dBGs[i], d0[i]);
  // fill colours: only take from pixels that are safely background
  const holeD = minmax(hole, mw, mh, 2, true), wgt = new Float32Array(N); for (let i = 0; i < N; i++) wgt[i] = holeD[i] > 0 ? 0 : 1;
  const fill = [col[0].slice(), col[1].slice(), col[2].slice()];
  if (holeN > 0 && holeN < N) {
    // grow the background into the hidden area: each hidden pixel copies the nearest pixel that is really background
    // (about as far away as the hidden area), so it keeps the texture of grass, water or wall instead of a grey blur
    const src = new Int32Array(N).fill(-1), q = new Int32Array(N); let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) if (!wgt[i]) continue; else { const x = i % mw, y = (i / mw) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < mw - 1 ? i + 1 : -1, y > 0 ? i - mw : -1, y < mh - 1 ? i + mw : -1]) if (j >= 0 && !wgt[j] && d0[i] < dBG[j] + 0.1) { src[i] = i; q[qt++] = i; break; } }
    while (qh < qt) { const i = q[qh++], x = i % mw, y = (i / mw) | 0, s0 = src[i];
      for (const j of [x > 0 ? i - 1 : -1, x < mw - 1 ? i + 1 : -1, y > 0 ? i - mw : -1, y < mh - 1 ? i + mw : -1]) if (j >= 0 && !wgt[j] && src[j] < 0) { src[j] = s0; q[qt++] = j; } }
    const wg2 = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (wgt[i]) { wg2[i] = 1; continue; } const s0 = src[i]; if (s0 < 0) continue;
      // mirror the background across the edge, so its texture continues instead of one colour being smeared
      const px = i % mw, py = (i / mw) | 0, sx = s0 % mw, sy = (s0 / mw) | 0, mx = 2 * sx - px, my = 2 * sy - py;
      let k = s0; if (mx >= 0 && my >= 0 && mx < mw && my < mh) { const m = my * mw + mx; if (wgt[m] && d0[m] < d0[s0] + 0.08) k = m; }
      fill[0][i] = col[0][k]; fill[1][i] = col[1][k]; fill[2][i] = col[2][k]; wg2[i] = 1;
    }
    // soften the copied streaks a little, only inside the hidden area
    const sm = fill.map(p => box(p, mw, mh, 2));
    for (let i = 0; i < N; i++) if (!wgt[i]) { fill[0][i] = fill[0][i] * .4 + sm[0][i] * .6; fill[1][i] = fill[1][i] * .4 + sm[1][i] * .6; fill[2][i] = fill[2][i] * .4 + sm[2][i] * .6; }
    pushPull(fill, wg2, mw, mh);   // anything still empty
  }
  const holeS = box(hole, mw, mh, 1);

  /* pack textures (RGBA bytes, top row first) */
  const u8 = v => { v = Math.round(v * 255); return v < 0 ? 0 : v > 255 ? 255 : v; };
  const depthTex = new Uint8Array(N * 4), fillTex = new Uint8Array(N * 4), m1 = new Uint8Array(N * 4), m2 = new Uint8Array(N * 4);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    depthTex[j] = u8(dFG[i]); depthTex[j + 1] = u8(dBG[i]); depthTex[j + 2] = u8(keep[i]); depthTex[j + 3] = u8(d0[i]);
    fillTex[j] = u8(fill[0][i]); fillTex[j + 1] = u8(fill[1][i]); fillTex[j + 2] = u8(fill[2][i]); fillTex[j + 3] = u8(holeS[i]);
    m1[j] = u8(M.sky[i]); m1[j + 1] = u8(M.water[i]); m1[j + 2] = u8(M.fall[i]); m1[j + 3] = u8(M.foliage[i]);
    m2[j] = u8(M.glow[i]); m2[j + 1] = u8(M.fire[i]); m2[j + 2] = u8(M.cloth[i]); m2[j + 3] = u8(M.alive[i]);
  }
  /* what did we find */
  const area = {}; for (const g in M) { let s = 0; const a = M[g]; for (let i = 0; i < N; i++) s += a[i]; area[g] = s / N; }
  const minA = { sky: 0.03, water: 0.02, fall: 0.008, foliage: 0.03, glow: 0.002, fire: 0.0015, cloth: 0.02, alive: 0.06 };
  const elements = []; for (const g of ['sky', 'water', 'fall', 'foliage', 'fire', 'glow', 'cloth', 'alive']) if (area[g] >= minA[g]) elements.push({ k: g, a: +area[g].toFixed(4) });
  let cx = 0, cy = 0, cs = 0; for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { const v = M.alive[y * mw + x]; cx += v * x; cy += v * y; cs += v; }
  const aliveC = cs > 0 ? [cx / cs / mw, cy / cs / mh] : [0.5, 0.5];
  const animals = (sg.hist[127] || 0) > (sg.hist[13] || 0);
  // how much real depth is there (flat graphics give little)
  let dm = 0; for (let i = 0; i < N; i++) dm += d0[i]; dm /= N; let dv = 0; for (let i = 0; i < N; i++) dv += (d0[i] - dm) * (d0[i] - dm); dv = Math.sqrt(dv / N);
  T.build = now() - t2; T.total = now() - T.t0;
  P('build', 1);
  return { v: 1, w: mw, h: mh, depth: depthTex, fill: fillTex, m1, m2, elements, aliveC, animals, top: sg.top.slice(0, 8), depthStd: +dv.toFixed(3), depthMean: +dm.toFixed(3), holes: +(holeN / N).toFixed(3), depthSize: L, ms: { seg: Math.round(T.seg), depth: Math.round(T.depth), build: Math.round(T.build), total: Math.round(T.total) } };
}

/* ---------- 3D scan: cut the product out and measure its depth ---------- */
async function runCut(rgba, w, h) {
  const S = 320, pl = rgbPlanes(rgba, w, h, S, S), n = S * S, inp = new Float32Array(3 * n), mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let c = 0; c < 3; c++) { const p = pl[c], o = c * n; for (let i = 0; i < n; i++) inp[o + i] = (p[i] - mean[c]) / std[c]; }
  const s = sessions.cut, out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, S, S]) });
  const d = out[s.outputNames[0]].data; let mn = Infinity, mx = -Infinity; for (let i = 0; i < n; i++) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
  const o = new Float32Array(n), k = 1 / ((mx - mn) || 1); for (let i = 0; i < n; i++) o[i] = (d[i] - mn) * k;
  return o;
}
async function object3d(rgba, w, h, onp) {
  const P = (stage, frac) => onp && onp({ stage, frac }), t0 = now();
  const ms = Math.min(1, 512 / Math.max(w, h)), mw = Math.max(16, Math.round(w * ms)), mh = Math.max(16, Math.round(h * ms)), N = mw * mh;
  P('cut', 0);
  const cut = await runCut(rgba, w, h);
  P('depth', 0);
  const dp = await runDepth(rgba, w, h, 518);
  P('build', 0);
  const col = rgbPlanes(rgba, w, h, mw, mh), lum = new Float32Array(N);
  for (let i = 0; i < N; i++) lum[i] = 0.299 * col[0][i] + 0.587 * col[1][i] + 0.114 * col[2][i];
  const gd = makeGuide(lum, mw, mh, Math.max(3, Math.round(Math.max(mw, mh) / 80)));
  let m = guided(gd, resizeF(cut, 320, 320, mw, mh), 0.002);
  for (let i = 0; i < N; i++) m[i] = sstep(0.3, 0.7, m[i]);
  // keep only the biggest connected piece (the product), drop specks
  const lab = new Int32Array(N).fill(-1), q = new Int32Array(N); let best = -1, bestN = 0, nl = 0;
  for (let i = 0; i < N; i++) if (m[i] > 0.5 && lab[i] < 0) {
    let qh = 0, qt = 0; q[qt++] = i; lab[i] = nl;
    while (qh < qt) { const j = q[qh++], x = j % mw, y = (j / mw) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < mw - 1 ? j + 1 : -1, y > 0 ? j - mw : -1, y < mh - 1 ? j + mw : -1]) if (k >= 0 && lab[k] < 0 && m[k] > 0.5) { lab[k] = nl; q[qt++] = k; } }
    if (qt > bestN) { bestN = qt; best = nl; } nl++;
  }
  if (bestN < N * 0.02) throw new Error('No product found in this photo. Put the product on a plain background, fill most of the photo with it, and try again.');
  // fill small holes inside the product
  const out = new Uint8Array(N); const bg = new Uint8Array(N); { let qh = 0, qt = 0;
    for (let x = 0; x < mw; x++) for (const y of [0, mh - 1]) { const i = y * mw + x; if (lab[i] !== best && !bg[i]) { bg[i] = 1; q[qt++] = i; } }
    for (let y = 0; y < mh; y++) for (const x of [0, mw - 1]) { const i = y * mw + x; if (lab[i] !== best && !bg[i]) { bg[i] = 1; q[qt++] = i; } }
    while (qh < qt) { const j = q[qh++], x = j % mw, y = (j / mw) | 0;
      for (const k of [x > 0 ? j - 1 : -1, x < mw - 1 ? j + 1 : -1, y > 0 ? j - mw : -1, y < mh - 1 ? j + mw : -1]) if (k >= 0 && !bg[k] && lab[k] !== best) { bg[k] = 1; q[qt++] = k; } } }
  let x0 = mw, y0 = mh, x1 = 0, y1 = 0;
  for (let i = 0; i < N; i++) { const inside = !bg[i]; const v = inside ? (lab[i] === best ? m[i] : 1) : (m[i] * 0); out[i] = Math.round(Math.max(0, Math.min(1, inside ? Math.max(v, .51) : 0)) * 255);
    if (inside) { const x = i % mw, y = (i / mw) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  // soft edge from the guided mask, only on the outline
  for (let i = 0; i < N; i++) if (out[i] && lab[i] === best) out[i] = Math.round(Math.max(0.5, m[i]) * 255);
  // depth inside the product, stretched to 0..1
  const d0 = resizeF(dp.d, dp.w, dp.h, mw, mh); let dl = 1, dh = 0; const vals = [];
  for (let i = 0; i < N; i += 2) if (out[i] > 127) vals.push(d0[i]);
  vals.sort((a, b) => a - b); if (vals.length) { dl = vals[Math.floor(vals.length * .03)]; dh = vals[Math.floor(vals.length * .97)]; }
  const dep = new Uint8Array(N), kk = 1 / ((dh - dl) || 1); for (let i = 0; i < N; i++) { const v = (d0[i] - dl) * kk; dep[i] = Math.round(Math.max(0, Math.min(1, v)) * 255); }
  const rgbaS = new Uint8Array(N * 4); for (let i = 0, j = 0; i < N; i++, j += 4) { rgbaS[j] = Math.round(col[0][i] * 255); rgbaS[j + 1] = Math.round(col[1][i] * 255); rgbaS[j + 2] = Math.round(col[2][i] * 255); rgbaS[j + 3] = out[i]; }
  P('build', 1);
  return { v: 1, w: mw, h: mh, rgba: rgbaS, depth: dep, box: [x0, y0, x1, y1], frac: +(bestN / N).toFixed(3), ms: Math.round(now() - t0) };
}

G.PAICore = { init, ensure, analyze, object3d, VER };
})(typeof self !== 'undefined' ? self : window);
