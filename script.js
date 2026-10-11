/* Kotabna Cover Preflight — client-side only. Nothing is uploaded. */
(function (root) {
'use strict';

/* ================= 1) CONFIG ================= */
const CONFIG = {
  SIZES: { A5: { w: 14, h: 20, label: 'A5 — 14 × 20 cm' }, B5: { w: 17, h: 24, label: 'B5 — 17 × 24 cm' } },
  MIN_PPI: 300,
  BLEED_CM: 0,               // المواصفات الحالية بلا سماحية قص (bleed). غيّرها إن لزم.
  CLASSIFY_TOL_CM: 1.5,      // نافذة التعرّف على A5/B5 من الارتفاع الفعلي
  HEIGHT_TOL_MM: 1,          // فرق الارتفاع المقبول
  MIN_SPINE_CM: 0.3,         // أقل من هذا = كعب غير واقعي (خطأ)
  MAX_SPINE_CM: 6,           // أكبر من هذا = تنبيه
  // الغلاف الكامل (ظهر + كعب + أمامي) أفقي دائمًا. غيّرها إلى 'portrait' إن أردت عكس ذلك.
  EXPECTED_ORIENTATION: 'landscape',
  MAX_FILE_MB: 500,
  MAX_PREVIEW_MP: 250
};

/* ================= 2) JPEG PARSER ================= */
const ascii = (b, s, n) => String.fromCharCode.apply(null, b.subarray(s, s + n));

function parseJpeg(b) {
  if (b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) throw new Error('NOT_JPEG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const m = { w: 0, h: 0, comps: 0, bits: 0, progressive: false, adobe: null, orient: 1, res: [], icc: [] };
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xFF) { p++; continue; }
    const k = b[p + 1];
    if (k === 0xFF) { p++; continue; }
    if (k === 0 || k === 1 || (k >= 0xD0 && k <= 0xD8)) { p += 2; continue; }
    if (k === 0xD9 || k === 0xDA) break;
    const len = dv.getUint16(p + 2), s = p + 4, e = p + 2 + len;
    if (len < 2 || e > b.length) { if (m.w) break; throw new Error('CORRUPT'); }
    try {
      if (k === 0xE0 && ascii(b, s, 5) === 'JFIF\0') {
        const u = b[s + 7], x = dv.getUint16(s + 8), y = dv.getUint16(s + 10);
        if ((u === 1 || u === 2) && x && y) { const f = u === 2 ? 2.54 : 1; m.res.push({ src: 'JFIF', x: x * f, y: y * f }); }
      } else if (k === 0xE1 && ascii(b, s, 6) === 'Exif\0\0') readExif(b, dv, s + 6, m);
      else if (k === 0xE2 && ascii(b, s, 12) === 'ICC_PROFILE\0') m.icc[b[s + 12]] = b.subarray(s + 14, e);
      else if (k === 0xED && ascii(b, s, 14) === 'Photoshop 3.0\0') readPhotoshop(b, dv, s + 14, e, m);
      else if (k === 0xEE && ascii(b, s, 5) === 'Adobe') m.adobe = { transform: b[s + 11] };
    } catch (_) { /* metadata segment damaged: ignore it */ }
    if (k >= 0xC0 && k <= 0xCF && k !== 0xC4 && k !== 0xC8 && k !== 0xCC) {
      m.bits = b[s]; m.h = dv.getUint16(s + 1); m.w = dv.getUint16(s + 3); m.comps = b[s + 5];
      m.progressive = k === 0xC2 || k === 0xC6 || k === 0xCA || k === 0xCE;
    }
    p = e;
  }
  if (!m.w || !m.h || !m.comps) throw new Error('CORRUPT');
  m.iccInfo = readIcc(m.icc);
  return m;
}

function readExif(b, dv, t, m) {
  const le = b[t] === 0x49, u16 = o => dv.getUint16(o, le), u32 = o => dv.getUint32(o, le);
  const ifd = t + u32(t + 4), n = u16(ifd), v = {};
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12, tag = u16(o), type = u16(o + 2);
    if (tag === 0x011A || tag === 0x011B) { const r = t + u32(o + 8); const d = u32(r + 4); if (type === 5 && d) v[tag] = u32(r) / d; }
    else if (tag === 0x0128 || tag === 0x0112) v[tag] = u16(o + 8);
  }
  if (v[0x0112]) m.orient = v[0x0112];
  const unit = v[0x0128] || 2;
  if (v[0x011A] && v[0x011B] && unit !== 1) { const f = unit === 3 ? 2.54 : 1; m.res.push({ src: 'EXIF', x: v[0x011A] * f, y: v[0x011B] * f }); }
}

function readPhotoshop(b, dv, p, e, m) {
  while (p + 12 <= e && ascii(b, p, 4) === '8BIM') {
    const id = dv.getUint16(p + 4), nl = 1 + b[p + 6], pl = nl % 2 ? nl + 1 : nl;
    const size = dv.getUint32(p + 6 + pl), d = p + 10 + pl;
    if (id === 0x03ED) {
      const fx = dv.getUint16(d + 4) === 2 ? 2.54 : 1, fy = dv.getUint16(d + 12) === 2 ? 2.54 : 1;
      const x = dv.getUint32(d) / 65536 * fx, y = dv.getUint32(d + 8) / 65536 * fy;
      if (x && y) m.res.push({ src: 'Photoshop', x, y });
    }
    p = d + size + (size % 2);
  }
}

function readIcc(chunks) {
  try {
    const parts = chunks.filter(Boolean); if (!parts.length) return null;
    const icc = new Uint8Array(parts.reduce((a, c) => a + c.length, 0)); let o = 0;
    parts.forEach(c => { icc.set(c, o); o += c.length; });
    const dv = new DataView(icc.buffer), info = { space: ascii(icc, 16, 4).trim(), name: '' };
    for (let i = 0, n = dv.getUint32(128); i < n; i++) {
      const r = 132 + i * 12; if (ascii(icc, r, 4) !== 'desc') continue;
      const off = dv.getUint32(r + 4), type = ascii(icc, off, 4);
      if (type === 'desc') info.name = ascii(icc, off + 12, Math.max(0, dv.getUint32(off + 8) - 1));
      else if (type === 'mluc') { const len = dv.getUint32(off + 20), so = off + dv.getUint32(off + 24); for (let j = 0; j < len; j += 2) info.name += String.fromCharCode(dv.getUint16(so + j)); }
    }
    return info;
  } catch (_) { return null; }
}

/* ================= 3) ANALYSIS ================= */
const f2 = n => n.toFixed(2);
const fPpi = p => Math.abs(p - Math.round(p)) < 0.05 ? String(Math.round(p)) : p.toFixed(1);
const sgn = n => (n > 0.005 ? '+' : n < -0.005 ? '−' : '');
const classify = hcm => Object.keys(CONFIG.SIZES).find(k => Math.abs(hcm - (CONFIG.SIZES[k].h + 2 * CONFIG.BLEED_CM)) <= CONFIG.CLASSIFY_TOL_CM) || null;

function colorMode(m) {
  if (m.mode) return { mode: m.mode, note: m.note };
  const adobe = m.adobe ? m.adobe.transform : null;
  if (m.comps === 1) return { mode: 'Grayscale', note: 'قناة واحدة' };
  if (m.comps === 3) return { mode: 'RGB', note: '3 قنوات' };
  if (m.comps === 4) return { mode: 'CMYK', note: adobe === 2 ? '4 قنوات (YCCK)' : '4 قنوات' + (m.adobe ? '' : ' — بلا علامة Adobe') };
  return { mode: 'Unknown', note: m.comps + ' قنوات — غير معروف' };
}

function analyze(m, truncated) {
  let { w, h } = m, sw = false;
  if (m.orient >= 5 && m.orient <= 8) { [w, h] = [h, w]; sw = true; }
  const all = m.res.map(r => sw ? { ...r, x: r.y, y: r.x } : r);
  const pick = ['Photoshop', 'EXIF', 'JFIF'].map(s => all.find(r => r.src === s)).find(Boolean) || null;
  const conflict = pick ? all.filter(r => Math.abs(r.x - pick.x) > 0.5 || Math.abs(r.y - pick.y) > 0.5) : [];
  const R = { kind: m.kind || 'jpeg', pdf: m.kind === 'pdf', file: m, w, h, color: colorMode(m), res: pick, resAll: all, conflict, truncated, orientSwap: sw };
  // بدون بيانات دقة: نعرض تقديرًا على أساس 300 PPI مع تسميته بوضوح كتقدير
  if (R.pdf) {                       // PDF: المقاس الفعلي معروف من حجم الصفحة (نقطة = 1/72 بوصة)
    R.est = false; R.wcm = w / 72 * 2.54; R.hcm = h / 72 * 2.54;
    R.ppi = m.imgPpi; R.vector = !m.imgPpi; R.res = m.imgPpi ? { src: 'PDF', x: m.imgPpi, y: m.imgPpi } : null;
  } else {
    R.est = !pick;
    R.ppi = pick ? Math.min(pick.x, pick.y) : CONFIG.MIN_PPI;
    R.wcm = w / (pick ? pick.x : CONFIG.MIN_PPI) * 2.54; R.hcm = h / (pick ? pick.y : CONFIG.MIN_PPI) * 2.54;
  }
  R.size = classify(R.hcm);                       // مطابق للمعتمد (أو null)
  R.near = Object.keys(CONFIG.SIZES).sort((a, b) => Math.abs(R.hcm - CONFIG.SIZES[a].h) - Math.abs(R.hcm - CONFIG.SIZES[b].h))[0];
  R.ref = R.size || R.near;                       // المرجع المستخدم للمقارنة وحساب الكعب
  R.hintSize = R.pdf ? null : classify(h / CONFIG.MIN_PPI * 2.54); // تلميح فقط
  const S = CONFIG.SIZES[R.ref];
  R.expH = S.h + 2 * CONFIG.BLEED_CM;
  R.spine = R.wcm - 2 * S.w - 2 * CONFIG.BLEED_CM;
  R.checks = runChecks(R);
  R.count = { pass: 0, warn: 0, error: 0, skip: 0 };
  R.checks.forEach(c => R.count[c.status]++);
  R.verdict = R.count.error ? 'error' : (R.count.warn || R.count.skip) ? 'warn' : 'pass';
  return R;
}

/* ================= 4) PREFLIGHT CHECKS ================= */
function runChecks(R) {
  const C = [], add = (id, title, en, status, text, kv) => C.push({ id, title, en, status, text, kv: kv || [] });
  const noRes = !R.res;
  const est = R.est, soft = st => est && st === 'pass' ? 'warn' : st;
  const estNote = est ? ' (تقدير على افتراض 300 PPI لأن الملف لا يحتوي بيانات دقة)' : '';
  const hint = !noRes && R.hintSize && R.size !== R.hintSize
    ? ` ملاحظة: أبعاد البكسل تطابق ${R.hintSize} عند 300 PPI، فقد تكون بيانات الدقة داخل الملف غير صحيحة — أعد الحفظ بالدقة الصحيحة.` : '';
  const ref = CONFIG.SIZES[R.ref];

  // Book size
  if (R.size) add('size', 'مقاس الكتاب', 'Book Size', soft('pass'), 'تم التعرّف على المقاس من الارتفاع الفعلي للغلاف.' + estNote, [['المقاس', ref.label]]);
  else add('size', 'مقاس الكتاب', 'Book Size', 'error', 'مقاس غير معتمد — ليس A5 ولا B5. المقاسات المعتمدة: A5 — 14 × 20 cm و B5 — 17 × 24 cm.' + estNote + hint,
    [['المقاس الفعلي', f2(R.wcm) + ' × ' + f2(R.hcm) + ' cm'], ['أقرب مقاس معتمد', ref.label]]);

  // Height
  {
    const d = R.hcm - R.expH, ok = Math.abs(d * 10) <= CONFIG.HEIGHT_TOL_MM;
    add('height', 'ارتفاع الغلاف', 'Height', ok ? soft('pass') : 'error',
      (ok ? 'الارتفاع مطابق للمقاس.' : 'ارتفاع الغلاف خاطئ' + (R.size ? '.' : ' مقارنةً بأقرب مقاس معتمد (' + R.ref + ').')) + estNote,
      [['المقاس', f2(R.hcm) + ' cm'], ['المطلوب', f2(R.expH) + ' cm'], ['الفرق', sgn(d) + f2(Math.abs(d)) + ' cm / ' + sgn(d) + Math.abs(d * 10).toFixed(1) + ' mm']]);
  }

  // Resolution
  if (R.vector) add('res', 'الدقة', 'Resolution', 'pass', 'ملف PDF لا يحتوي صورًا نقطية كبيرة (متجهي)، فلا تنطبق قيود PPI.');
  else if (noRes) add('res', 'الدقة', 'Resolution', 'warn', 'معلومات الدقة غير متوفرة في الملف، لذلك الأبعاد الفعلية الظاهرة تقديرية (على افتراض 300 PPI) ويجب التأكد منها. لا يمكن تحديد الحجم الحقيقي من البكسلات وحدها.');
  else {
    const ok = Math.round(R.ppi) >= CONFIG.MIN_PPI;
    let t = (R.pdf ? 'أقل دقة فعلية للصور النقطية داخل الملف. ' : '') + (ok ? 'الدقة مطابقة للحد الأدنى.' : 'الدقة منخفضة جدًا.'), st = ok ? 'pass' : 'error';
    if (R.conflict.length) { t += ' تنبيه: مصادر البيانات تتعارض (' + R.resAll.map(r => r.src + ' ' + fPpi(r.x)).join('، ') + ') والمعتمد: ' + R.res.src + '.'; if (ok) st = 'warn'; }
    if (Math.abs(R.res.x - R.res.y) > 1) { t += ' الدقة الأفقية والرأسية مختلفتان؛ اعتُمدت الأقل.'; if (ok) st = 'warn'; }
    add('res', 'الدقة', 'Resolution', st, t, [['المقاسة', fPpi(R.ppi) + ' PPI'], ['المطلوبة', CONFIG.MIN_PPI + ' PPI']]);
  }

  // Color mode
  const cm = R.color.mode;
  if (cm === 'CMYK') add('color', 'نمط اللون', 'Color Mode', 'pass', 'CMYK — صحيح.', [['المقاس', 'CMYK'], ['المتوقع', 'CMYK']]);
  else if (cm === 'Mixed') add('color', 'نمط اللون', 'Color Mode', 'warn', 'يحتوي الملف على عناصر CMYK وRGB معًا؛ يُفضّل تحويل الكل إلى CMYK. (كشف تقريبي)', [['المقاس', 'CMYK + RGB'], ['المتوقع', 'CMYK']]);
  else if (cm === 'RGB') add('color', 'نمط اللون', 'Color Mode', 'warn', 'يُفضّل تحويل الملف إلى CMYK قبل التسليم للطباعة.' + (R.kind === 'png' ? ' (PNG لا يدعم CMYK؛ سلّم JPG أو PDF بنمط CMYK.)' : ''), [['المقاس', 'RGB'], ['المتوقع', 'CMYK']]);
  else add('color', 'نمط اللون', 'Color Mode', 'warn', cm === 'Grayscale' ? 'الملف بتدرجات الرمادي، والمعيار المعتمد هو CMYK. راجعه يدويًا.' : 'تعذّر تحديد نمط اللون من الملف.', [['المقاس', cm], ['المتوقع', 'CMYK']]);

  // Spine
  {
    const S = R.spine, kv = [['العرض الكامل', f2(R.wcm) + ' cm'], ['الكعب', f2(S) + ' cm / ' + (S * 10).toFixed(2) + ' mm']];
    const basis = (R.size ? '' : 'محسوب على أساس أقرب مقاس معتمد (' + R.ref + '). ') + (est ? 'تقدير على افتراض 300 PPI. ' : '');
    let st, t;
    if (S <= 0) [st, t] = ['error', 'الكعب المحسوب سالب أو صفر — قد يكون الملف غلافًا أماميًا فقط أو أن عرضه أقل من اللازم.'];
    else if (S < CONFIG.MIN_SPINE_CM) [st, t] = ['error', 'الكعب صغير جدًا وغير واقعي.'];
    else if (S > CONFIG.MAX_SPINE_CM) [st, t] = ['warn', 'الكعب كبير بشكل غير معتاد، راجع عرض الملف.'];
    else [st, t] = ['pass', 'الكعب موجب ومعقول.'];
    if (st === 'pass' && (!R.size || est)) st = 'warn';
    add('spine', 'عرض الكعب', 'Spine', st, basis + t, kv);
  }

  // Orientation
  const land = R.w > R.h, want = CONFIG.EXPECTED_ORIENTATION === 'landscape', ar = o => o === 'landscape' ? 'أفقي' : 'عمودي';
  const cur = R.w === R.h ? 'square' : land ? 'landscape' : 'portrait';
  const okO = cur === CONFIG.EXPECTED_ORIENTATION;
  add('orient', 'اتجاه الصورة', 'Orientation', okO ? 'pass' : 'warn',
    okO ? 'الاتجاه مناسب للغلاف الكامل (ظهر + كعب + أمامي).' : 'الغلاف الكامل (ظهر + كعب + أمامي) يكون ' + ar(CONFIG.EXPECTED_ORIENTATION) + ' عادةً؛ قد يكون الملف صفحة واحدة أو مدوّرًا.',
    [['الحالي', cur === 'square' ? 'مربع' : ar(cur)], ['المتوقع', ar(CONFIG.EXPECTED_ORIENTATION)]]);

  if (R.file.pages > 1) add('pages', 'عدد الصفحات', 'Pages', 'warn', 'يحتوي الملف على ' + R.file.pages + ' صفحات؛ تم فحص الصفحة الأولى فقط.');
  if (R.truncated) add('integrity', 'سلامة الملف', 'File Integrity', 'warn', 'نهاية الملف (EOI) غير موجودة؛ قد يكون الملف مقطوعًا أو غير مكتمل التصدير.');
  return C;
}

/* ================= 5) REPORT TEXT ================= */
function reportText(R, name) {
  const L = ['Kotabna Cover Preflight', 'File: ' + name, (R.pdf ? 'Page: ' + Math.round(R.w) + ' × ' + Math.round(R.h) + ' pt' : 'Pixels: ' + R.w + ' × ' + R.h),
    'Resolution: ' + (R.res ? fPpi(R.ppi) + ' PPI (' + R.res.src + ')' : 'unavailable'),
    'Physical: ' + f2(R.wcm) + ' × ' + f2(R.hcm) + ' cm' + (R.est ? ' (estimate @300 PPI)' : ''),
    'Color: ' + R.color.mode, 'Book size: ' + (R.size ? CONFIG.SIZES[R.size].label : 'NOT STANDARD (nearest ' + R.ref + ')'),
    'Spine: ' + f2(R.spine) + ' cm' + (R.size ? '' : ' (based on ' + R.ref + ')'), ''];
  R.checks.forEach(c => L.push('[' + c.status.toUpperCase() + '] ' + c.en + ' — ' + c.text));
  L.push('', 'Result: ' + { pass: 'READY FOR PRINT', warn: 'REVIEW REQUIRED', error: 'NOT READY' }[R.verdict]);
  return L.join('\n');
}


/* ---- PNG ---- */
function parsePng(b) {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) throw new Error('NOT_IMG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const m = { kind: 'png', w: 0, h: 0, comps: 0, orient: 1, res: [], iccInfo: null, adobe: null };
  let p = 8, ct = 0, bits = 0;
  while (p + 8 <= b.length) {
    const len = dv.getUint32(p), t = ascii(b, p + 4, 4), d = p + 8;
    if (t === 'IHDR') { m.w = dv.getUint32(d); m.h = dv.getUint32(d + 4); bits = b[d + 8]; ct = b[d + 9]; }
    else if (t === 'pHYs' && b[d + 8] === 1) { const x = dv.getUint32(d) * 0.0254, y = dv.getUint32(d + 4) * 0.0254; if (x && y) m.res.push({ src: 'PNG pHYs', x, y }); }
    else if (t === 'iCCP') { let e = d; while (b[e] && e < d + 80) e++; m.iccInfo = { name: ascii(b, d, e - d), space: '' }; }
    else if (t === 'IDAT' || t === 'IEND') break;
    p = d + len + 4;
  }
  if (!m.w || !m.h) throw new Error('CORRUPT');
  const gray = ct === 0 || ct === 4;
  m.comps = gray ? 1 : 3; m.mode = gray ? 'Grayscale' : 'RGB';
  m.note = (gray ? 'تدرجات رمادي' : 'RGB') + ' · ' + bits + '-bit · PNG لا يدعم CMYK';
  return m;
}

/* ---- PDF: color scan (raw bytes + inflated streams) ---- */
async function inflate(u8) {
  const ds = new DecompressionStream('deflate'), w = ds.writable.getWriter();
  w.write(u8).catch(() => {}); w.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}
async function scanPdf(u8) {
  const f = { cmyk: false, rgb: false, gray: false };
  const dec = new TextDecoder('latin1'), t = dec.decode(u8);
  const RGBN = /(?<!\/CS\s{0,3})\/DeviceRGB/;
  const opC = /(?:^|\s)-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+[kK](?=\s|$)/, opR = /(?:^|\s)-?[\d.]+\s+-?[\d.]+\s+-?[\d.]+\s+(?:rg|RG)(?=\s|$)/;
  const names = x => { if (x.includes('/DeviceCMYK')) f.cmyk = true; if (RGBN.test(x)) f.rgb = true; if (x.includes('/DeviceGray')) f.gray = true; };
  names(t);
  let pos = 0, n = 0;
  while ((pos = t.indexOf('stream', pos)) >= 0 && n < 20000) {
    const kw = pos; pos += 6;
    if (kw >= 3 && t.startsWith('end', kw - 3)) continue;
    let s = kw + 6; if (t[s] === '\r') s++; if (t[s] === '\n') s++; else continue;
    let e = t.indexOf('endstream', s); if (e < 0) break;
    const next = e; while (e > s && (t[e - 1] === '\n' || t[e - 1] === '\r')) e--;
    const dict = t.slice(Math.max(t.lastIndexOf('obj', kw), kw - 2500), kw); n++;
    pos = next;
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    const nm = dict.match(/\/N\s+(\d)\b/);
    if (nm && !/\/First|ObjStm/.test(dict)) { if (nm[1] === '4') f.cmyk = true; else if (nm[1] === '3') f.rgb = true; else if (nm[1] === '1') f.gray = true; continue; }
    let x = null;
    if (/\/FlateDecode/.test(dict)) {
      if (!/\/Length[12]|\/Type\s*\/(XRef|Metadata)|\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)/.test(dict) && e - s < 6e6) {
        try { const o = await inflate(u8.subarray(s, e)); x = dec.decode(o.length > 2e7 ? o.subarray(0, 2e7) : o); } catch (_) {}
      }
    } else if (!/\/Filter/.test(dict) && e - s < 2e6) x = t.slice(s, e);
    if (x) { names(x); if (!f.cmyk && opC.test(x)) f.cmyk = true; if (!f.rgb && opR.test(x)) f.rgb = true; }
  }
  return f;
}
const pdfMode = f => f.cmyk && f.rgb ? 'Mixed' : f.cmyk ? 'CMYK' : f.rgb ? 'RGB' : f.gray ? 'Grayscale' : 'Unknown';

/* ---- PDF: page size + effective image PPI (lib = pdf.js) ---- */
async function readPdf(lib, u8, flags) {
  const doc = await lib.getDocument({ data: u8.slice() }).promise;
  const page = await doc.getPage(1), v = page.view, uu = page.userUnit || 1;
  let w = (v[2] - v[0]) * uu, h = (v[3] - v[1]) * uu;
  if (page.rotate % 180) [w, h] = [h, w];
  const ops = await page.getOperatorList(), O = lib.OPS;
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  let ctm = [1, 0, 0, 1, 0, 0], st = [], min = null, cnt = 0;
  ops.fnArray.forEach((f, i) => {
    const a = ops.argsArray[i];
    if (f === O.save) st.push(ctm);
    else if (f === O.restore) ctm = st.pop() || ctm;
    else if (f === O.transform) ctm = mul(a, ctm);
    else if (f === O.paintFormXObjectBegin) { st.push(ctm); if (a && a[0]) ctm = mul(a[0], ctm); }
    else if (f === O.paintFormXObjectEnd) ctm = st.pop() || ctm;
    else if (f === O.paintImageXObject || f === O.paintInlineImageXObject) {
      const iw = f === O.paintImageXObject ? a[1] : a[0].width, ih = f === O.paintImageXObject ? a[2] : a[0].height;
      const wp = Math.hypot(ctm[0], ctm[1]), hp = Math.hypot(ctm[2], ctm[3]);
      if (iw && ih && wp > 1 && hp > 1 && wp * hp >= 0.02 * w * h) { const p = Math.min(iw / (wp / 72), ih / (hp / 72)); cnt++; min = min === null ? p : Math.min(min, p); }
    }
  });
  const mode = pdfMode(flags);
  return { kind: 'pdf', w, h, comps: 0, orient: 1, res: [], iccInfo: null, adobe: null, pages: doc.numPages, imgPpi: min, imgCount: cnt, mode,
    note: mode === 'Mixed' ? 'يحتوي على عناصر CMYK وRGB معًا · كشف تقريبي' : 'كشف تقريبي من محتوى PDF', _page: page };
}

const api = { CONFIG, parseJpeg, parsePng, scanPdf, readPdf, analyze, reportText };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof document === 'undefined') return;
root.Preflight = api;

/* ================= 6) UI ================= */
const $ = id => document.getElementById(id);
const num = t => '<span class="num">' + t + '</span>';
const LBL = { pass: 'PASS', warn: 'WARNING', error: 'ERROR', skip: 'غير متاح' };
let current = null, url = null;

function showErr(msg) { const e = $('err'); e.textContent = msg; e.hidden = !msg; }

let pdfjsP = null;
function loadPdfJs() {
  if (pdfjsP) return pdfjsP;
  const V = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  pdfjsP = new Promise((res, rej) => {
    const sc = document.createElement('script'); sc.src = V + 'pdf.min.js';
    sc.onload = async () => { try { const t = await (await fetch(V + 'pdf.worker.min.js')).text(); pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([t], { type: 'text/javascript' })); res(pdfjsLib); } catch (e) { rej(new Error('PDFJS_LOAD')); } };
    sc.onerror = () => rej(new Error('PDFJS_LOAD'));
    document.head.appendChild(sc);
  });
  pdfjsP.catch(() => { pdfjsP = null; });
  return pdfjsP;
}

async function handleFile(file) {
  showErr('');
  if (!file) return;
  reset(); showErr('');
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!/\.(jpe?g|png|pdf)$/i.test(file.name) && !/^(image\/(jpeg|png)|application\/pdf)$/.test(file.type)) return showErr('نوع الملف غير مدعوم. يُقبل JPG أو PNG أو PDF فقط (لا PSD ولا TIFF).');
  const max = isPdf ? 200 : CONFIG.MAX_FILE_MB;
  if (file.size > max * 1048576) return showErr('الملف كبير جدًا (أكثر من ' + max + ' MB).');
  $('busy').hidden = false;
  try {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 8 << 20)).arrayBuffer());
    const tail = new Uint8Array(await file.slice(Math.max(0, file.size - 1024)).arrayBuffer());
    const tailTxt = String.fromCharCode.apply(null, tail);
    const kind = head[0] === 0xFF && head[1] === 0xD8 ? 'jpeg' : head[0] === 0x89 && head[1] === 0x50 ? 'png'
      : String.fromCharCode.apply(null, head.subarray(0, 1024)).includes('%PDF-') ? 'pdf' : null;
    if (!kind) throw new Error('NOT_IMG');
    let m, truncated;
    if (kind === 'jpeg') { m = parseJpeg(head); const t64 = tail.subarray(Math.max(0, tail.length - 64)); truncated = !t64.some((v, i) => v === 0xFF && t64[i + 1] === 0xD9); }
    else if (kind === 'png') { m = parsePng(head); truncated = !tailTxt.includes('IEND'); }
    else {
      const lib = await loadPdfJs(), u8 = new Uint8Array(await file.arrayBuffer());
      m = await readPdf(lib, u8, await scanPdf(u8)); truncated = !tailTxt.includes('%%EOF');
      try {
        const vp0 = m._page.getViewport({ scale: 1 }), vp = m._page.getViewport({ scale: Math.min(2, 900 / Math.max(vp0.width, vp0.height)) });
        const cv = document.createElement('canvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
        const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        await m._page.render({ canvasContext: cx, viewport: vp }).promise; m.preview = cv.toDataURL('image/jpeg', 0.85);
      } catch (_) { m.preview = null; }
    }
    const R = analyze(m, truncated);
    await new Promise(r => setTimeout(r, 450));
    show(file, R);
  } catch (e) {
    showErr(e.message === 'NOT_IMG' ? 'محتوى الملف ليس JPG أو PNG أو PDF صالحًا.'
      : e.message === 'PDFJS_LOAD' ? 'تعذّر تحميل مكتبة قراءة PDF. تحتاج إلى اتصال بالإنترنت عند أول فتح لملف PDF.'
      : e.name === 'PasswordException' ? 'ملف PDF محمي بكلمة مرور. أزل الحماية ثم أعد الرفع.'
      : 'تعذّرت قراءة الملف؛ يبدو تالفًا أو غير مكتمل. جرّب تصديره مرة أخرى.');
    console.error(e);
  } finally { $('busy').hidden = true; }
}

function show(file, R) {
  current = { file, R };
  if (url) URL.revokeObjectURL(url);
  const pv = $('pv'); pv.hidden = false; $('pvnone').hidden = true;
  if (R.pdf) { if (R.file.preview) pv.src = R.file.preview; else { pv.hidden = true; $('pvnone').hidden = false; } }
  else if (R.w * R.h > CONFIG.MAX_PREVIEW_MP * 1e6) { pv.hidden = true; $('pvnone').hidden = false; }
  else { url = URL.createObjectURL(file); pv.onerror = () => { pv.hidden = true; $('pvnone').hidden = false; }; pv.src = url; }
  $('fname').textContent = file.name;
  $('fmeta').textContent = (file.size / 1048576).toFixed(2) + ' MB · ' + (R.pdf ? 'PDF · ' + Math.round(R.w) + ' × ' + Math.round(R.h) + ' pt' : R.kind.toUpperCase() + ' · ' + R.w + ' × ' + R.h + ' px');

  const unav = '<span style="color:var(--warn)">غير متوفرة</span>';
  const cls = id => { const c = R.checks.find(x => x.id === id); return c && c.status === 'error' ? ' bad' : c && c.status === 'warn' ? ' warn' : ''; };
  const M = (t, v, s, c) => '<div class="m' + (c || '') + '"><h3>' + t + '</h3><div class="v">' + v + '</div><div class="s">' + s + '</div></div>';
  const icc = R.file.iccInfo;
  $('metrics').innerHTML =
    (R.pdf ? M('حجم الصفحة (PDF)', num(Math.round(R.w) + ' × ' + Math.round(R.h) + ' pt'), 'عدد الصفحات ' + num(R.file.pages) + ' · فُحصت الأولى')
      : M('أبعاد الصورة', num(R.w + ' × ' + R.h + ' px'), 'العرض ' + num(R.w + ' px') + ' · الارتفاع ' + num(R.h + ' px'))) +
    M('الدقة (PPI)', R.vector ? 'متجه (Vector)' : R.res ? num(fPpi(R.ppi) + ' PPI') : unav, R.vector ? 'لا توجد صور نقطية كبيرة' : R.res ? (R.pdf ? 'أقل صورة نقطية في الملف' : 'المصدر: ' + R.res.src) : 'لا يوجد قيمة موثوقة داخل الملف', cls('res')) +
    M('الغلاف الكامل (ظهر + كعب + أمامي)', num(f2(R.wcm) + ' × ' + f2(R.hcm) + ' cm'), num(f2(R.wcm * 10) + ' × ' + f2(R.hcm * 10) + ' mm') + (R.est ? ' · تقدير على 300 PPI' : '')) +
    M('نمط اللون', num(R.color.mode), R.color.note + (icc && icc.name ? ' · ' + num(icc.name) : ''), cls('color')) +
    M('مقاس الكتاب', R.size ? num(CONFIG.SIZES[R.size].label) : 'مقاس غير معتمد', R.size ? 'مُستنتج من الارتفاع الفعلي' : 'ليس A5 ولا B5 · الأقرب: ' + num(R.ref), cls('size')) +
    M('عرض الكعب', num(f2(R.spine) + ' cm'), num((R.spine * 10).toFixed(2) + ' mm') + (R.size ? '' : ' · على أساس ' + num(R.ref)), cls('spine'));

  const sp = $('spine');
  if (R.spine > 0) {
    const t = CONFIG.SIZES[R.ref].w;
    sp.innerHTML = '<div class="sec-h"><h2>مخطط الكعب</h2><span class="note">حسابي وليس مكتشفًا من الصورة</span></div>' +
      '<div class="bar"><div class="bk" style="flex:' + t + '">' + num(t + ' cm') + '</div><div class="sp" style="flex:' + Math.max(R.spine, 0.9) + '">' + num(f2(R.spine)) + '</div><div class="fr" style="flex:' + t + '">' + num(t + ' cm') + '</div></div>' +
      '<p class="note">الكعب = ' + num(f2(R.wcm)) + ' − ' + num('2 × ' + t) + ' = ' + num(f2(R.spine) + ' cm') + (R.size ? '' : ' (على أساس ' + R.ref + ' لأن المقاس غير معتمد)') + '. ترتيب الغلاف الأمامي والخلفي لا يؤثر على الحساب.</p>';
  } else sp.innerHTML = '<div class="sec-h"><h2>مخطط الكعب</h2></div><p class="note">الكعب المحسوب ' + num(f2(R.spine) + ' cm') + ' غير صالح (على أساس ' + R.ref + ').</p>';

  const k = R.count, pl = (n, a, b, c, cl) => n ? '<span class="pill ' + cl + '">' + (cl === 'pass' ? '✓ ' : cl === 'warn' ? '⚠ ' : cl === 'error' ? '✕ ' : '') + n + ' ' + (n === 1 ? a : n === 2 ? b : c) + '</span>' : '';
  $('sum').innerHTML = pl(k.pass, 'فحص ناجح', 'فحصان ناجحان', 'فحوصات ناجحة', 'pass') + pl(k.warn, 'تنبيه', 'تنبيهان', 'تنبيهات', 'warn') + pl(k.error, 'خطأ', 'خطآن', 'أخطاء', 'error') + pl(k.skip, 'فحص غير متاح', 'فحصان غير متاحين', 'فحوصات غير متاحة', 'skip');
  $('checks').innerHTML = R.checks.map(c => '<li class="' + c.status + '"><span class="st pill ' + c.status + '">' + LBL[c.status] + '</span><h4>' + c.title + '<small dir="ltr">' + c.en + '</small></h4><div><p>' + c.text + '</p>' +
    (c.kv.length ? '<div class="kv">' + c.kv.map(x => '<span>' + x[0] + ': <b>' + num(x[1]) + '</b></span>').join('') + '</div>' : '') + '</div></li>').join('');

  const F = { pass: ['✅ READY FOR PRINT', 'الملف مطابق للمواصفات الأساسية للطباعة.'], warn: ['⚠️ REVIEW REQUIRED', 'الملف قابل للمراجعة، لكن توجد بعض الملاحظات.'], error: ['❌ NOT READY', 'يوجد عدد من المشاكل التي تحتاج إلى مراجعة قبل التسليم.'] }[R.verdict];
  $('final').className = 'final ' + R.verdict;
  $('final').innerHTML = '<h2>' + F[0] + '</h2><p>' + F[1] + '</p>';
  $('app').classList.add('has-file'); $('dash').hidden = false;
  scrollTo({ top: 0, behavior: 'smooth' });
}

function reset() {
  current = null; if (url) URL.revokeObjectURL(url); url = null;
  $('pv').removeAttribute('src'); $('file').value = ''; $('dash').hidden = true; ['metrics','spine','sum','checks','final'].forEach(i => $(i).innerHTML = ''); $('fname').textContent = $('fmeta').textContent = ''; showErr('');
  $('app').classList.remove('has-file');
}

const drop = $('drop'), input = $('file');
drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
input.addEventListener('change', () => handleFile(input.files[0]));
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));
['dragover', 'drop'].forEach(t => window.addEventListener(t, e => e.preventDefault()));
$('again').addEventListener('click', reset);
$('copy').addEventListener('click', async e => {
  if (!current) return;
  const b = e.currentTarget, txt = reportText(current.R, current.file.name);
  try { await navigator.clipboard.writeText(txt); b.textContent = 'تم النسخ ✓'; } catch (_) { b.textContent = 'تعذّر النسخ'; }
  setTimeout(() => b.textContent = 'نسخ التقرير', 1800);
});

})(typeof window !== 'undefined' ? window : globalThis);
