/**
 * strategies-charts.js
 * Precise SVG tape schematics — indicators track the candles, entry on the exact bar.
 */
(function () {
  'use strict';

  const W = 720;
  const H = 300;
  const PAD = { t: 30, r: 52, b: 40, l: 14 };
  let seq = 0;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid() {
    seq += 1;
    return `st${seq}`;
  }

  function bar(o, c, wickUp, wickDn, v) {
    const hi = Math.max(o, c) + (wickUp == null ? 0.18 : wickUp);
    const lo = Math.min(o, c) - (wickDn == null ? 0.16 : wickDn);
    return { o, h: hi, l: lo, c, v: v == null ? 6 : v };
  }

  function emaArr(closes, period) {
    const k = 2 / (period + 1);
    const out = [closes[0]];
    for (let i = 1; i < closes.length; i++) out.push(closes[i] * k + out[i - 1] * (1 - k));
    return out;
  }

  function bbArr(closes, period, k) {
    const mid = [];
    const up = [];
    const dn = [];
    const p = Math.max(3, period || 8);
    const mult = k == null ? 2 : k;
    for (let i = 0; i < closes.length; i++) {
      const a = Math.max(0, i - p + 1);
      const slice = closes.slice(a, i + 1);
      const m = slice.reduce((s, x) => s + x, 0) / slice.length;
      const varn = slice.reduce((s, x) => s + (x - m) * (x - m), 0) / slice.length;
      const sd = Math.sqrt(varn) * mult;
      mid.push(m);
      up.push(m + sd);
      dn.push(m - sd);
    }
    return { mid, up, dn };
  }

  function scaleY(bars, top, bot) {
    let lo = Infinity;
    let hi = -Infinity;
    bars.forEach((b) => {
      lo = Math.min(lo, b.l);
      hi = Math.max(hi, b.h);
    });
    const pad = (hi - lo) * 0.16 || 1;
    lo -= pad;
    hi += pad;
    return {
      y: function (p) {
        return top + ((hi - p) / (hi - lo)) * (bot - top);
      },
      lo,
      hi,
    };
  }

  function layoutX(n) {
    const span = W - PAD.l - PAD.r;
    const step = span / n;
    const cw = Math.min(12, Math.max(5.2, step * 0.58));
    return {
      step,
      cw,
      x: function (i) {
        return PAD.l + i * step + (step - cw) / 2;
      },
      cx: function (i) {
        return PAD.l + i * step + step / 2;
      },
    };
  }

  function smoothPath(pts) {
    if (!pts || pts.length < 2) return '';
    let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const mx = (p0[0] + p1[0]) / 2;
      d += ` C${mx.toFixed(2)} ${p0[1].toFixed(2)} ${mx.toFixed(2)} ${p1[1].toFixed(2)} ${p1[0].toFixed(2)} ${p1[1].toFixed(2)}`;
    }
    return d;
  }

  function pathFrom(xs, values, y) {
    return values.map((p, i) => [xs.cx(i), y(p)]);
  }

  function defs(id) {
    return `
      <defs>
        <linearGradient id="${id}-up" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6ee7a8"/>
          <stop offset="100%" stop-color="#22c55e"/>
        </linearGradient>
        <linearGradient id="${id}-dn" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#fda4af"/>
          <stop offset="100%" stop-color="#f43f5e"/>
        </linearGradient>
        <linearGradient id="${id}-bb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(148,163,184,0.16)"/>
          <stop offset="100%" stop-color="rgba(148,163,184,0.04)"/>
        </linearGradient>
        <linearGradient id="${id}-volup" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="rgba(34,197,94,0.08)"/>
          <stop offset="100%" stop-color="rgba(34,197,94,0.42)"/>
        </linearGradient>
        <linearGradient id="${id}-voldn" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stop-color="rgba(244,63,94,0.08)"/>
          <stop offset="100%" stop-color="rgba(244,63,94,0.38)"/>
        </linearGradient>
      </defs>`;
  }

  function candle(id, x, y, b, w, lit) {
    const ox = x;
    const oy = y(b.o);
    const cy = y(b.c);
    const hy = y(b.h);
    const ly = y(b.l);
    const up = b.c >= b.o;
    const fill = up ? `url(#${id}-up)` : `url(#${id}-dn)`;
    const stroke = up ? '#4ade80' : '#fb7185';
    const bodyTop = Math.min(oy, cy);
    const bodyH = Math.max(1.6, Math.abs(cy - oy));
    const cx = ox + w / 2;
    const dim = lit ? '1' : '0.55';
    return `
      <g opacity="${dim}">
        <line x1="${cx.toFixed(2)}" y1="${hy.toFixed(2)}" x2="${cx.toFixed(2)}" y2="${ly.toFixed(2)}" stroke="${stroke}" stroke-width="1.15" stroke-linecap="round"/>
        <rect x="${ox.toFixed(2)}" y="${bodyTop.toFixed(2)}" width="${w.toFixed(2)}" height="${bodyH.toFixed(2)}" rx="1.1" fill="${fill}" stroke="${stroke}" stroke-width="0.7"/>
      </g>`;
  }

  function volumeStrip(id, bars, xs, plotBot) {
    const volTop = plotBot + 8;
    const volBot = H - 10;
    const maxV = Math.max.apply(null, bars.map((b) => b.v).concat([1]));
    const hMax = volBot - volTop;
    return bars.map((b, i) => {
      const h = Math.max(1.2, (b.v / maxV) * hMax);
      const up = b.c >= b.o;
      const x = xs.x(i);
      return `<rect x="${x.toFixed(2)}" y="${(volBot - h).toFixed(2)}" width="${xs.cw.toFixed(2)}" height="${h.toFixed(2)}" rx="0.8" fill="url(#${id}-${up ? 'volup' : 'voldn'})"/>`;
    }).join('');
  }

  function axis(y, lo, hi, plotTop, plotBot) {
    const ticks = 4;
    let out = '';
    for (let i = 0; i <= ticks; i++) {
      const p = hi - ((hi - lo) * i) / ticks;
      const yy = y(p);
      out += `<line x1="${PAD.l}" y1="${yy.toFixed(2)}" x2="${W - PAD.r}" y2="${yy.toFixed(2)}" stroke="rgba(255,255,255,0.04)" stroke-width="1"/>`;
      out += `<text x="${W - PAD.r + 8}" y="${(yy + 3.5).toFixed(2)}" fill="rgba(255,255,255,0.28)" font-size="9" font-variant="tabular-nums">${p.toFixed(2)}</text>`;
    }
    out += `<line x1="${(W - PAD.r).toFixed(2)}" y1="${plotTop}" x2="${(W - PAD.r).toFixed(2)}" y2="${plotBot}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    return out;
  }

  function levelLine(yPrice, y, label, color) {
    const yy = y(yPrice);
    return `
      <line x1="${PAD.l}" y1="${yy.toFixed(2)}" x2="${W - PAD.r}" y2="${yy.toFixed(2)}" stroke="${color}" stroke-width="1.15" stroke-dasharray="3.5 3"/>
      <text x="${PAD.l + 2}" y="${(yy - 5).toFixed(2)}" fill="${color}" fill-opacity="0.85" font-size="9" letter-spacing="0.08em">${esc(label)}</text>`;
  }

  function overlayPath(pts, color, width) {
    const d = smoothPath(pts);
    if (!d) return '';
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width || 1.35}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  function bbFill(id, upPts, dnPts) {
    if (!upPts.length || !dnPts.length) return '';
    let d = `M${upPts[0][0].toFixed(2)} ${upPts[0][1].toFixed(2)}`;
    for (let i = 1; i < upPts.length; i++) d += ` L${upPts[i][0].toFixed(2)} ${upPts[i][1].toFixed(2)}`;
    for (let i = dnPts.length - 1; i >= 0; i--) d += ` L${dnPts[i][0].toFixed(2)} ${dnPts[i][1].toFixed(2)}`;
    d += ' Z';
    return `<path d="${d}" fill="url(#${id}-bb)" stroke="none"/>`;
  }

  function entryMark(xs, y, bars, index, side) {
    const b = bars[index];
    if (!b) return '';
    const cx = xs.cx(index);
    const cy = y(b.c);
    const buy = String(side || 'BUY').toUpperCase() === 'BUY';
    const label = buy ? 'BUY' : 'SELL';
    const color = buy ? '#4ade80' : '#fb7185';
    const tagW = 36;
    const left = cx + 10 + tagW > W - PAD.r - 4;
    const tagX = left ? cx - tagW - 12 : cx + 12;
    const x1 = xs.x(index);
    return `
      <rect x="${x1.toFixed(2)}" y="${PAD.t}" width="${xs.cw.toFixed(2)}" height="${(H - PAD.b - PAD.t).toFixed(2)}" fill="${color}" fill-opacity="0.08"/>
      <circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="7.5" fill="${color}" fill-opacity="0.16"/>
      <circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="3.4" fill="#fff" stroke="${color}" stroke-width="1.6"/>
      <rect x="${tagX.toFixed(2)}" y="${(cy - 9).toFixed(2)}" width="${tagW}" height="18" rx="4" fill="rgba(12,12,16,0.92)" stroke="${color}" stroke-width="1"/>
      <text x="${(tagX + tagW / 2).toFixed(2)}" y="${(cy + 4).toFixed(2)}" text-anchor="middle" fill="${color}" font-size="9" font-weight="700" letter-spacing="0.1em">${label}</text>`;
  }

  function legend(items) {
    const widths = (items || []).map((it) => it.label.length * 5.6 + 30);
    let x = W - PAD.r - widths.reduce((a, b) => a + b, 0);
    return items.map((it, idx) => {
      const node = `
        <g transform="translate(${x.toFixed(1)}, 10)">
          <line x1="0" y1="4" x2="12" y2="4" stroke="${it.color}" stroke-width="1.6" stroke-linecap="round"/>
          <text x="16" y="7" fill="rgba(255,255,255,0.38)" font-size="9">${esc(it.label)}</text>
        </g>`;
      x += widths[idx];
      return node;
    }).join('');
  }

  function title(text) {
    return `<text x="${PAD.l}" y="18" fill="rgba(255,255,255,0.34)" font-size="9.5" letter-spacing="0.12em">${esc(text)}</text>`;
  }

  function draw(spec) {
    const id = uid();
    const bars = spec.bars || [];
    const n = bars.length;
    const plotTop = PAD.t + 8;
    const plotBot = H - PAD.b;
    const xs = layoutX(n);
    const sy = scaleY(bars, plotTop, plotBot);
    const y = sy.y;
    const closes = bars.map((b) => b.c);
    const entry = spec.entryIndex;
    let body = defs(id);
    body += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="8" fill="rgba(255,255,255,0.015)" stroke="rgba(255,255,255,0.05)"/>`;
    body += axis(y, sy.lo, sy.hi, plotTop, plotBot);

    if (spec.bb) {
      const bb = bbArr(closes, spec.bb.period || 8, spec.bb.k);
      body += bbFill(id, pathFrom(xs, bb.up, y), pathFrom(xs, bb.dn, y));
      body += overlayPath(pathFrom(xs, bb.up, y), 'rgba(148,163,184,0.55)', 1.1);
      body += overlayPath(pathFrom(xs, bb.dn, y), 'rgba(148,163,184,0.55)', 1.1);
      body += overlayPath(pathFrom(xs, bb.mid, y), 'rgba(99,102,241,0.8)', 1.35);
    }

    (spec.emas || []).forEach((e) => {
      body += overlayPath(pathFrom(xs, emaArr(closes, e.period), y), e.color, e.width || 1.4);
    });

    (spec.levels || []).forEach((lv) => {
      body += levelLine(lv.price, y, lv.label, lv.color);
    });

    bars.forEach((b, i) => {
      body += candle(id, xs.x(i), y, b, xs.cw, entry == null || i <= entry + 2);
    });

    body += volumeStrip(id, bars, xs, plotBot);

    if (entry != null) {
      body += entryMark(xs, y, bars, entry, spec.side);
    }

    if (spec.legend && spec.legend.length) body += legend(spec.legend);
    if (spec.title) body += title(spec.title);

    return `<svg class="utk-strat-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" shape-rendering="geometricPrecision">${body}</svg>`;
  }

  /* ---------- setups: synthetic tape that matches the rules ---------- */

  function chartMeanReversion() {
    const bars = [
      bar(100.4, 100.6, 0.18, 0.12, 5),
      bar(100.6, 100.3, 0.14, 0.2, 5),
      bar(100.3, 100.1, 0.12, 0.16, 6),
      bar(100.1, 99.7, 0.1, 0.22, 6),
      bar(99.7, 99.25, 0.1, 0.2, 7),
      bar(99.25, 98.7, 0.12, 0.28, 8),
      bar(98.7, 97.85, 0.1, 0.35, 10),
      bar(97.85, 97.15, 0.12, 0.85, 14),
      bar(97.2, 98.05, 0.22, 0.18, 11),
      bar(98.05, 98.55, 0.16, 0.12, 8),
      bar(98.55, 98.95, 0.14, 0.1, 7),
      bar(98.95, 99.2, 0.12, 0.1, 6),
      bar(99.2, 99.45, 0.14, 0.1, 6),
      bar(99.45, 99.35, 0.1, 0.16, 5),
      bar(99.35, 99.7, 0.14, 0.1, 6),
      bar(99.7, 99.9, 0.12, 0.08, 5),
      bar(99.9, 100.05, 0.12, 0.1, 5),
      bar(100.05, 99.95, 0.08, 0.14, 5),
    ];
    return draw({
      bars,
      bb: { period: 8, k: 2 },
      entryIndex: 8,
      side: 'BUY',
      title: 'LOWER BAND  ·  CLOSE BACK INSIDE',
      legend: [
        { color: 'rgba(99,102,241,0.8)', label: 'Mid' },
        { color: 'rgba(148,163,184,0.7)', label: 'BB 2σ' },
      ],
    });
  }

  function chartBreakout() {
    const r = 100.4;
    const bars = [
      bar(99.2, 99.55, 0.18, 0.14, 5),
      bar(99.55, 99.15, 0.12, 0.2, 5),
      bar(99.2, 99.7, 0.2, 0.12, 6),
      bar(99.7, 99.35, 0.1, 0.18, 5),
      bar(99.4, 99.85, 0.18, 0.12, 6),
      bar(99.85, 99.5, 0.08, 0.16, 5),
      bar(99.55, 100.05, 0.22, 0.1, 7),
      bar(100.0, 99.65, 0.1, 0.2, 6),
      bar(99.7, 100.15, 0.18, 0.12, 8),
      bar(100.1, 101.35, 0.28, 0.08, 16),
      bar(101.3, 101.85, 0.22, 0.12, 12),
      bar(101.8, 101.45, 0.1, 0.22, 8),
      bar(101.5, 102.1, 0.2, 0.1, 10),
      bar(102.05, 102.55, 0.18, 0.1, 9),
      bar(102.5, 102.2, 0.1, 0.2, 7),
      bar(102.25, 102.85, 0.2, 0.1, 8),
      bar(102.8, 102.5, 0.1, 0.18, 6),
      bar(102.55, 103.05, 0.18, 0.1, 7),
    ];
    return draw({
      bars,
      emas: [
        { period: 5, color: 'rgba(99,102,241,0.9)', width: 1.5 },
        { period: 12, color: 'rgba(251,191,36,0.8)', width: 1.35 },
      ],
      levels: [{ price: r, label: 'RESISTANCE', color: 'rgba(251,191,36,0.7)' }],
      entryIndex: 9,
      side: 'BUY',
      title: 'CLOSE THROUGH LEVEL  ·  VOLUME EXPANDS',
      legend: [
        { color: 'rgba(99,102,241,0.9)', label: 'EMA 20' },
        { color: 'rgba(251,191,36,0.8)', label: 'EMA 50' },
      ],
    });
  }

  function chartPullback() {
    const bars = [
      bar(96.4, 96.95, 0.2, 0.12, 6),
      bar(96.9, 97.5, 0.22, 0.1, 7),
      bar(97.45, 97.2, 0.1, 0.18, 5),
      bar(97.25, 98.05, 0.24, 0.1, 8),
      bar(98.0, 98.55, 0.18, 0.1, 7),
      bar(98.5, 98.15, 0.1, 0.2, 5),
      bar(98.2, 99.0, 0.22, 0.1, 8),
      bar(98.95, 99.45, 0.16, 0.1, 7),
      bar(99.4, 98.7, 0.08, 0.22, 6),
      bar(98.75, 98.35, 0.1, 0.2, 5),
      bar(98.4, 99.15, 0.22, 0.12, 9),
      bar(99.1, 99.7, 0.2, 0.1, 8),
      bar(99.65, 100.15, 0.18, 0.1, 8),
      bar(100.1, 99.7, 0.08, 0.18, 5),
      bar(99.75, 100.4, 0.2, 0.1, 7),
      bar(100.35, 100.85, 0.18, 0.1, 7),
      bar(100.8, 100.5, 0.08, 0.16, 5),
      bar(100.55, 101.1, 0.18, 0.1, 6),
    ];
    return draw({
      bars,
      emas: [
        { period: 5, color: 'rgba(99,102,241,0.9)', width: 1.5 },
        { period: 14, color: 'rgba(251,191,36,0.8)', width: 1.35 },
      ],
      entryIndex: 10,
      side: 'BUY',
      title: 'UPTREND  ·  PULLBACK TO FAST EMA  ·  RESUME',
      legend: [
        { color: 'rgba(99,102,241,0.9)', label: 'EMA 20' },
        { color: 'rgba(251,191,36,0.8)', label: 'EMA 100' },
      ],
    });
  }

  function chartFakeout() {
    const sup = 98.2;
    const bars = [
      bar(99.4, 99.1, 0.12, 0.18, 5),
      bar(99.15, 98.85, 0.1, 0.16, 5),
      bar(98.9, 99.2, 0.18, 0.1, 5),
      bar(99.15, 98.7, 0.08, 0.18, 6),
      bar(98.75, 98.45, 0.1, 0.16, 6),
      bar(98.5, 98.85, 0.16, 0.12, 5),
      bar(98.8, 98.35, 0.08, 0.18, 7),
      bar(98.4, 97.35, 0.1, 1.05, 15),
      bar(97.55, 98.55, 0.28, 0.22, 13),
      bar(98.5, 98.95, 0.2, 0.1, 8),
      bar(98.9, 99.25, 0.16, 0.1, 7),
      bar(99.2, 98.95, 0.08, 0.16, 5),
      bar(99.0, 99.45, 0.18, 0.1, 6),
      bar(99.4, 99.7, 0.14, 0.08, 6),
      bar(99.65, 99.4, 0.08, 0.16, 5),
      bar(99.45, 99.9, 0.16, 0.1, 6),
      bar(99.85, 100.15, 0.14, 0.08, 6),
      bar(100.1, 99.95, 0.08, 0.14, 5),
    ];
    return draw({
      bars,
      levels: [{ price: sup, label: 'SUPPORT', color: 'rgba(74,222,128,0.75)' }],
      entryIndex: 8,
      side: 'BUY',
      title: 'WICK THROUGH  ·  CLOSE BACK ABOVE  ·  RECLAIM',
    });
  }

  function chartImpulse() {
    const swing = 100.15;
    const bars = [
      bar(98.6, 98.95, 0.16, 0.12, 5),
      bar(98.9, 99.25, 0.18, 0.1, 5),
      bar(99.2, 98.95, 0.08, 0.18, 5),
      bar(99.0, 99.45, 0.16, 0.1, 6),
      bar(99.4, 99.7, 0.14, 0.1, 6),
      bar(99.65, 99.4, 0.08, 0.16, 5),
      bar(99.45, 99.9, 0.16, 0.1, 6),
      bar(99.85, 100.15, 0.14, 0.08, 7),
      bar(100.1, 101.85, 0.32, 0.1, 18),
      bar(101.75, 102.2, 0.22, 0.12, 12),
      bar(102.15, 101.85, 0.08, 0.2, 8),
      bar(101.9, 102.45, 0.2, 0.1, 9),
      bar(102.4, 102.8, 0.18, 0.1, 8),
      bar(102.75, 102.45, 0.08, 0.18, 6),
      bar(102.5, 103.05, 0.2, 0.1, 8),
      bar(103.0, 103.35, 0.16, 0.1, 7),
      bar(103.3, 103.05, 0.08, 0.16, 6),
      bar(103.1, 103.55, 0.18, 0.1, 7),
    ];
    return draw({
      bars,
      emas: [
        { period: 4, color: 'rgba(99,102,241,0.9)', width: 1.5 },
        { period: 9, color: 'rgba(251,191,36,0.8)', width: 1.3 },
      ],
      levels: [{ price: swing, label: 'SWING HIGH', color: 'rgba(255,255,255,0.35)' }],
      entryIndex: 8,
      side: 'BUY',
      title: 'IMPULSE BAR THROUGH SWING  ·  FOLLOW THROUGH',
      legend: [
        { color: 'rgba(99,102,241,0.9)', label: 'EMA 10' },
        { color: 'rgba(251,191,36,0.8)', label: 'EMA 20' },
      ],
    });
  }

  function chartRange() {
    const top = 101.35;
    const bot = 98.55;
    const bars = [
      bar(99.2, 100.4, 0.22, 0.14, 6),
      bar(100.35, 101.15, 0.22, 0.1, 6),
      bar(101.1, 100.7, 0.12, 0.18, 5),
      bar(100.75, 99.4, 0.1, 0.22, 7),
      bar(99.45, 98.7, 0.1, 0.28, 7),
      bar(98.75, 99.35, 0.2, 0.14, 6),
      bar(99.3, 100.5, 0.22, 0.12, 6),
      bar(100.45, 101.2, 0.2, 0.1, 6),
      bar(101.15, 100.6, 0.1, 0.2, 5),
      bar(100.65, 99.2, 0.1, 0.22, 7),
      bar(99.25, 98.5, 0.1, 0.42, 8),
      bar(98.6, 99.25, 0.24, 0.14, 9),
      bar(99.2, 99.85, 0.18, 0.1, 6),
      bar(99.8, 100.55, 0.18, 0.1, 6),
      bar(100.5, 101.1, 0.18, 0.1, 5),
      bar(101.05, 100.55, 0.1, 0.18, 5),
      bar(100.6, 99.7, 0.08, 0.2, 6),
      bar(99.75, 99.15, 0.1, 0.18, 5),
    ];
    return draw({
      bars,
      levels: [
        { price: top, label: 'RESISTANCE', color: 'rgba(251,113,133,0.7)' },
        { price: bot, label: 'SUPPORT', color: 'rgba(74,222,128,0.7)' },
      ],
      entryIndex: 11,
      side: 'BUY',
      title: 'CLEAN RANGE  ·  HAMMER AT SUPPORT',
    });
  }

  function chartRangeFlip() {
    const flip = 101.2;
    const bars = [
      bar(99.4, 100.3, 0.2, 0.12, 5),
      bar(100.25, 101.0, 0.18, 0.1, 5),
      bar(100.95, 100.5, 0.1, 0.18, 5),
      bar(100.55, 99.5, 0.08, 0.2, 6),
      bar(99.55, 100.2, 0.18, 0.12, 5),
      bar(100.15, 101.05, 0.18, 0.1, 6),
      bar(101.0, 100.4, 0.1, 0.18, 5),
      bar(100.45, 101.85, 0.28, 0.1, 14),
      bar(101.8, 102.25, 0.2, 0.12, 10),
      bar(102.2, 101.7, 0.08, 0.22, 8),
      bar(101.75, 101.35, 0.08, 0.2, 7),
      bar(101.4, 101.95, 0.22, 0.12, 9),
      bar(101.9, 102.45, 0.2, 0.1, 8),
      bar(102.4, 102.8, 0.16, 0.1, 8),
      bar(102.75, 102.4, 0.08, 0.16, 6),
      bar(102.45, 103.0, 0.18, 0.1, 7),
      bar(102.95, 103.25, 0.14, 0.08, 6),
      bar(103.2, 102.95, 0.08, 0.16, 5),
    ];
    return draw({
      bars,
      levels: [{ price: flip, label: 'FLIP  ·  OLD RESISTANCE', color: 'rgba(129,140,248,0.8)' }],
      entryIndex: 11,
      side: 'BUY',
      title: 'BREAK  ·  RETEST  ·  HOLD AS SUPPORT',
    });
  }

  function chartSpike() {
    const res = 102.55;
    const bars = [
      bar(99.4, 99.85, 0.16, 0.1, 5),
      bar(99.8, 100.25, 0.18, 0.1, 6),
      bar(100.2, 100.55, 0.16, 0.1, 6),
      bar(100.5, 100.95, 0.18, 0.1, 7),
      bar(100.9, 101.35, 0.18, 0.1, 8),
      bar(101.3, 101.75, 0.2, 0.1, 9),
      bar(101.7, 102.15, 0.2, 0.1, 10),
      bar(102.1, 102.85, 0.95, 0.12, 18),
      bar(102.55, 101.65, 0.16, 0.22, 14),
      bar(101.7, 101.25, 0.1, 0.2, 9),
      bar(101.3, 100.85, 0.1, 0.18, 8),
      bar(100.9, 101.15, 0.16, 0.1, 6),
      bar(101.1, 100.6, 0.08, 0.18, 7),
      bar(100.65, 100.2, 0.08, 0.18, 7),
      bar(100.25, 100.5, 0.14, 0.1, 5),
      bar(100.45, 100.05, 0.08, 0.16, 6),
      bar(100.1, 99.75, 0.08, 0.16, 6),
      bar(99.8, 99.95, 0.14, 0.1, 5),
    ];
    return draw({
      bars,
      emas: [{ period: 10, color: 'rgba(251,191,36,0.8)', width: 1.4 }],
      levels: [{ price: res, label: 'RESISTANCE', color: 'rgba(251,113,133,0.75)' }],
      entryIndex: 8,
      side: 'SELL',
      title: 'SPIKE INTO LEVEL  ·  REJECTION CLOSE',
      legend: [{ color: 'rgba(251,191,36,0.8)', label: 'EMA 50' }],
    });
  }

  function chartSqueeze() {
    const bars = [
      bar(100.8, 100.35, 0.16, 0.2, 6),
      bar(100.4, 100.65, 0.18, 0.12, 5),
      bar(100.6, 100.3, 0.1, 0.16, 4),
      bar(100.35, 100.5, 0.14, 0.1, 4),
      bar(100.48, 100.32, 0.08, 0.12, 3),
      bar(100.34, 100.46, 0.1, 0.08, 3),
      bar(100.44, 100.36, 0.08, 0.1, 3),
      bar(100.38, 100.5, 0.1, 0.08, 3),
      bar(100.48, 100.4, 0.08, 0.1, 3),
      bar(100.42, 100.55, 0.12, 0.08, 4),
      bar(100.52, 101.45, 0.28, 0.08, 16),
      bar(101.4, 101.9, 0.22, 0.1, 12),
      bar(101.85, 101.55, 0.08, 0.2, 8),
      bar(101.6, 102.15, 0.2, 0.1, 9),
      bar(102.1, 102.5, 0.18, 0.1, 8),
      bar(102.45, 102.2, 0.08, 0.16, 6),
      bar(102.25, 102.7, 0.18, 0.1, 7),
      bar(102.65, 102.95, 0.16, 0.08, 7),
    ];
    return draw({
      bars,
      bb: { period: 8, k: 1.85 },
      entryIndex: 10,
      side: 'BUY',
      title: 'BANDS PINCH  ·  CLOSE OUTSIDE  ·  ATR EXPANDS',
      legend: [
        { color: 'rgba(99,102,241,0.8)', label: 'Mid' },
        { color: 'rgba(148,163,184,0.7)', label: 'BB' },
      ],
    });
  }

  const CHARTS = {
    meanReversion: chartMeanReversion,
    breakout: chartBreakout,
    pullback: chartPullback,
    fakeout: chartFakeout,
    impulse: chartImpulse,
    range: chartRange,
    rangeFlip: chartRangeFlip,
    spike: chartSpike,
    squeeze: chartSqueeze,
  };

  function render(type) {
    const fn = CHARTS[type] || chartBreakout;
    return fn();
  }

  try {
    if (typeof window !== 'undefined') window.utkStrategyCharts = { render };
  } catch (e) {}
  try {
    module.exports = { render };
  } catch (e) {}
})();
