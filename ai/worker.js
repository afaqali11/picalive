/* PicAlive AI worker: keeps the heavy AI work off the screen thread. */
importScripts('ort.wasm.min.js', 'pai-core.js');
const base = self.location.href.replace(/[^/]*$/, '');
self.onmessage = async e => {
  const m = e.data || {}, id = m.id;
  const prog = p => self.postMessage({ id, progress: p });
  try {
    if (m.cmd === 'init') { await PAICore.init(base, prog); self.postMessage({ id, ok: true, result: { ver: PAICore.VER } }); }
    else if (m.cmd === 'analyze') {
      await PAICore.init(base, prog);
      const r = await PAICore.analyze(new Uint8Array(m.rgba), m.w, m.h, prog, m.opt);
      self.postMessage({ id, ok: true, result: r }, [r.depth.buffer, r.fill.buffer, r.m1.buffer, r.m2.buffer]);
    } else self.postMessage({ id, error: 'unknown command' });
  } catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
};
self.postMessage({ hello: true });
