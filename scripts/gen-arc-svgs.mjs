#!/usr/bin/env node
/**
 * Generate the modern light-theme architecture diagrams (EN + ZH) from a single layout.
 *
 *   docs/ARC/EN/architecture.svg      docs/ARC/ZH/architecture.svg
 *   docs/ARC/EN/user-flows.svg        docs/ARC/ZH/user-flows.svg
 *   docs/ARC/EN/agent-workflow.svg    docs/ARC/ZH/agent-workflow.svg
 *
 * Re-run after the architecture changes:  node scripts/gen-arc-svgs.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- palette ----------
const C = {
  ink: '#0F172A',        // near-black text
  muted: '#64748B',      // secondary text
  accent: '#4F46E5',     // indigo-600
  accentDeep: '#3730A3', // indigo-900 (on accent fills)
  accentSoft: '#EEF2FF', // indigo-50 (decision fills)
  accentLine: '#C7D2FE', // indigo-200
  band: '#F8FAFC',       // slate-50 (layer bands)
  bandLine: '#E2E8F0',   // slate-200
  cardLine: '#CBD5E1',   // slate-300
  card: '#FFFFFF',
  arrow: '#94A3B8',      // slate-400
  noteFill: '#FFFBEB',   // amber-50
  noteLine: '#FDE68A',   // amber-200
  ifaceFill: '#F5F3FF',  // violet-50 (app interface cards)
  ifaceLine: '#DDD6FE',  // violet-200
  yes: '#16A34A',
  no: '#DC2626',
  onAccent: '#FFFFFF',
};

const FONT_EN = `'Segoe UI', 'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif`;
const FONT_ZH = `'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif`;

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// ---------- small drawing helpers ----------
function marker(id, color) {
  return `<marker id="${id}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 z" fill="${color}"/></marker>`;
}

function arrow(path, { color = C.arrow, sw = 1.5, dash, id = 'arr' } = {}) {
  const m = `url(#${id})`;
  return `<path d="${path}" fill="none" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="${m}"/>`;
}

function line(x1, y1, x2, y2, { color = C.arrow, sw = 1.5, dash } = {}) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

function text(x, y, str, { size = 13, weight = 600, fill = C.ink, anchor = 'middle', ls } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${ls ? ` letter-spacing="${ls}"` : ''}>${esc(str)}</text>`;
}

// centered (and vertically centered) multiline text inside a box
function boxText(cx, cy, str, { size = 13, weight = 600, fill = C.ink } = {}) {
  const lines = String(str).split('\n');
  const lh = size + 4;
  const start = cy - ((lines.length - 1) * lh) / 2;
  return lines
    .map((l, i) => text(cx, start + i * lh + size * 0.36, l, { size, weight, fill }))
    .join('\n');
}

function card(x, y, w, h, label, { kind = 'card', size = 13, weight = 600, fill, stroke, textFill, ts } = {}) {
  const st = stroke ?? (kind === 'iface' ? C.ifaceLine : kind === 'note' ? C.noteLine : C.cardLine);
  const fl = fill ?? (kind === 'iface' ? C.ifaceFill : kind === 'note' ? C.noteFill : C.card);
  const tfl = textFill ?? (kind === 'note' ? C.muted : C.ink);
  const rx = kind === 'note' ? 10 : 10;
  const dash = kind === 'note' ? '5 4' : undefined;
  const fw = kind === 'note' ? 500 : weight;
  const fs = ts ?? size;
  return (
    `<g filter="url(#sh)">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fl}" stroke="${st}" stroke-width="${kind === 'note' ? 1.4 : 1.5}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` +
    boxText(x + w / 2, y + h / 2, label, { size: fs, weight: fw, fill: tfl }) +
    `</g>`
  );
}

function pill(x, y, w, h, label, { size = 13 } = {}) {
  return (
    `<g filter="url(#sh)">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.accent}" stroke="none"/>` +
    boxText(x + w / 2, y + h / 2, label, { size, weight: 600, fill: C.onAccent }) +
    `</g>`
  );
}

function diamond(cx, cy, w, h, label, { size = 13 } = {}) {
  const p = `${cx},${cy - h / 2} ${cx + w / 2},${cy} ${cx},${cy + h / 2} ${cx - w / 2},${cy}`;
  return (
    `<g filter="url(#sh)">` +
    `<polygon points="${p}" fill="${C.accentSoft}" stroke="${C.accent}" stroke-width="1.5"/>` +
    boxText(cx, cy, label, { size, weight: 600, fill: C.accentDeep }) +
    `</g>`
  );
}

function band(x, y, w, h, label) {
  return (
    `<g>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${C.band}" stroke="${C.bandLine}" stroke-width="1.2"/>` +
    text(x + 20, y + 20, label, { size: 11, weight: 700, fill: C.accent, anchor: 'start', ls: 2 }) +
    `</g>`
  );
}

function branchLabel(x, y, str, color) {
  return text(x, y, str, { size: 11, weight: 700, fill: color });
}

function svgDoc(w, h, title, body, lang) {
  const font = lang === 'zh' ? FONT_ZH : FONT_EN;
  return (
    `<!-- Generated by scripts/gen-arc-svgs.mjs — light theme, ${lang === 'zh' ? 'Chinese' : 'English'} -->\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">\n` +
    `<style>svg{font-family:${font};}</style>\n` +
    `<defs>` +
    `<marker id="arr" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L9,4.5 L0,9 z" fill="${C.arrow}"/></marker>` +
    `<filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="1.5" stdDeviation="2.5" flood-color="${C.ink}" flood-opacity="0.07"/></filter>` +
    `</defs>\n` +
    body +
    `\n</svg>\n`
  );
}

// ---------------------------------------------------------------------------
// 1 · SYSTEM ARCHITECTURE (正式软件架构)
// ---------------------------------------------------------------------------
function architecture(L) {
  const body = [];
  body.push(text(48, 34, L.title, { size: 20, weight: 700, fill: C.ink, anchor: 'start' }));

  // bands
  body.push(band(40, 64, 880, 128, L.layerApp));
  body.push(band(40, 216, 880, 104, L.layerCli));
  body.push(band(40, 344, 880, 148, L.layerAction));
  body.push(band(40, 516, 880, 120, L.layerSupport));

  // application cards
  body.push(card(170, 116, 140, 56, L.ui, { kind: 'card', size: 14 }));
  body.push(card(650, 116, 140, 56, L.agent, { kind: 'card', size: 14 }));

  // CLI card (highlighted hub)
  body.push(
    `<g filter="url(#sh)">` +
    `<rect x="405" y="248" width="150" height="56" rx="12" fill="${C.accentSoft}" stroke="${C.accent}" stroke-width="2"/>` +
    boxText(480, 276, L.cli, { size: 14, weight: 700, fill: C.accentDeep }) +
    `</g>`
  );

  // action cards
  const actionX = [68, 210, 352, 494, 636, 778];
  const actionCx = actionX.map((x) => x + 62);
  const actionLabels = [L.bigtable, L.db, L.pipeline, L.rule, L.workspace, L.ingest];
  actionLabels.forEach((lb, i) => body.push(card(actionX[i], 400, 124, 56, lb, { size: 13.5 })));

  // support cards
  const supCx = [260, 480, 700];
  const supLabels = [L.errors, L.logging, L.lineage];
  supLabels.forEach((lb, i) => body.push(card(supCx[i] - 70, 560, 140, 56, lb)));

  // arrows: application -> CLI
  body.push(arrow(`M240,172 L240,240 L480,240 L480,246`));
  body.push(arrow(`M720,172 L720,240 L480,240 L480,246`));

  // CLI -> bus -> action
  body.push(arrow(`M480,304 L480,330`));
  body.push(line(120, 330, 860, 330));
  actionCx.forEach((cx) => body.push(arrow(`M${cx},330 L${cx},396`)));

  // support -> action (arrows rise into the action band)
  supCx.forEach((cx) => body.push(arrow(`M${cx},560 L${cx},494`)));

  return { w: 960, h: 660, title: L.title, body: body.join('\n') };
}

// ---------------------------------------------------------------------------
// 2 · USER FLOWS (软件流程图)
// ---------------------------------------------------------------------------
function userFlows(L) {
  const body = [];
  body.push(text(190, 26, L.colSetup, { size: 12, weight: 700, fill: C.accent, ls: 2 }));
  body.push(text(630, 26, L.colQuery, { size: 12, weight: 700, fill: C.accent, ls: 2 }));
  body.push(text(1090, 26, L.colUpdate, { size: 12, weight: 700, fill: C.accent, ls: 2 }));

  // ---------- column 1 · setup ----------
  body.push(pill(115, 48, 150, 50, L.setupStart));                       // 48-98
  body.push(arrow('M190,98 L190,116'));
  body.push(card(105, 116, 170, 44, L.importFiles));                      // 116-160
  body.push(arrow('M190,160 L190,182'));
  body.push(card(105, 182, 170, 44, L.setMapping));                       // 182-226
  body.push(arrow('M190,226 L190,248'));
  body.push(card(105, 248, 170, 44, L.preview));                          // 248-292
  body.push(arrow('M190,292 L190,320'));
  body.push(diamond(190, 360, 220, 76, L.cleanQ));                        // 322-398
  body.push(branchLabel(268, 352, L.yes, C.yes));
  body.push(branchLabel(307, 352, L.no, C.no));
  body.push(arrow('M190,398 L190,478'));
  body.push(pill(115, 478, 150, 50, L.setupDone));                        // 478-528
  // no -> clean & transform card (floats right), then loop back to preview
  body.push(arrow('M300,360 L328,360'));
  body.push(card(328, 338, 170, 44, L.cleanTransform));                   // 338-382, cx 413
  body.push(arrow('M413,382 L413,412 L290,412 L290,270 L275,270'));

  // ---------- column 2 · query ----------
  body.push(pill(555, 48, 150, 50, L.queryStart));                        // 48-98
  body.push(arrow('M630,98 L630,120'));
  body.push(diamond(630, 160, 220, 76, L.useAi));                         // 122-198
  // yes -> AI lane
  body.push(arrow('M565,198 L530,198 L530,226'));
  body.push(branchLabel(557, 192, L.yes, C.yes));
  body.push(card(455, 226, 150, 40, L.describe));                         // 226-266, cx 530
  body.push(arrow('M530,266 L530,286'));
  body.push(card(455, 286, 150, 40, L.aiSql));                            // 286-326
  body.push(arrow('M530,326 L530,361'));
  body.push(diamond(530, 396, 180, 70, L.correctQ));                      // 361-431
  body.push(branchLabel(452, 392, L.no, C.no));
  body.push(arrow('M440,396 L415,396 L415,246 L453,246'));
  body.push(arrow('M530,431 L530,470 L630,470 L630,486'));
  // no -> manual lane
  body.push(arrow('M695,198 L720,198 L720,226'));
  body.push(branchLabel(678, 192, L.no, C.no));
  body.push(card(645, 226, 150, 40, L.inputSql));                         // 226-266, cx 720
  body.push(arrow('M720,266 L720,301'));
  body.push(diamond(720, 336, 180, 70, L.correctQ));                      // 301-371
  body.push(branchLabel(813, 332, L.no, C.no));
  body.push(arrow('M810,336 L835,336 L835,246 L797,246'));
  body.push(arrow('M720,371 L720,470 L630,470 L630,486'));
  // merge
  body.push(card(545, 486, 170, 44, L.queryTable));                       // 486-530
  body.push(arrow('M630,530 L630,556'));
  body.push(diamond(630, 596, 180, 70, L.saveQ));                         // 561-631
  body.push(branchLabel(585, 645, L.yes, C.yes));
  body.push(branchLabel(676, 648, L.no, C.no));
  body.push(arrow('M590,631 L590,655'));
  body.push(card(545, 655, 170, 40, L.savePipeline));                     // 655-695
  body.push(arrow('M630,695 L630,718'));
  body.push(arrow('M670,631 L670,718'));
  body.push(pill(555, 718, 150, 50, L.queryDone));                        // 718-768

  // ---------- column 3 · update ----------
  body.push(pill(1015, 48, 150, 50, L.updateStart));                      // 48-98
  body.push(arrow('M1090,98 L1090,116'));
  body.push(card(1005, 116, 170, 44, L.updateSource));                    // 116-160
  body.push(arrow('M1090,160 L1090,182'));
  body.push(card(1005, 182, 170, 44, L.recompute));                       // 182-226
  body.push(arrow('M1090,226 L1090,248'));
  body.push(card(1005, 248, 170, 44, L.newData));                         // 248-292
  body.push(arrow('M1090,292 L1090,318'));
  body.push(pill(1015, 318, 150, 50, L.updateDone));                      // 318-368
  // side note
  body.push(
    `<g filter="url(#sh)">` +
    `<rect x="863" y="116" width="132" height="104" rx="10" fill="${C.noteFill}" stroke="${C.noteLine}" stroke-width="1.4" stroke-dasharray="5 4"/>` +
    boxText(929, 168, L.syncNote, { size: 11.5, weight: 500, fill: C.muted }) +
    `</g>`
  );
  body.push(line(995, 168, 1005, 152, { dash: '3 3', color: C.arrow }));

  return { w: 1260, h: 800, title: L.titleFlows, body: body.join('\n') };
}

// ---------------------------------------------------------------------------
// 3 · AGENT WORKFLOW — swimlane (软件泳道流程图)
// ---------------------------------------------------------------------------
function agentWorkflow(L) {
  const body = [];
  body.push(text(48, 28, L.titleWorkflow, { size: 20, weight: 700, fill: C.ink, anchor: 'start' }));

  // lane geometry
  const LANES = {
    a: { x: 30, w: 330, label: L.laneAgent, fill: C.accentSoft, line: C.accent },
    b: { x: 380, w: 280, label: L.laneAuditor, fill: C.noteFill, line: C.noteLine },
    c: { x: 680, w: 270, label: L.laneOnwork, fill: C.ifaceFill, line: C.ifaceLine },
  };
  const GW = { a: 290, b: 250, c: 250 };
  const GX = { a: 40, b: 395, c: 695 };

  // ---- cursor-based layout ----
  const rows = [];
  let y = 122;
  const typeH = (t) => (t === 'pill' ? 50 : t === 'diamond' ? 62 : 44);
  const ROW = (...items) => {
    const h = Math.max(...items.map(([t]) => typeH(t)));
    for (const [key, lane, type, label] of items) rows.push({ key, lane, type, label, y: y + (h - typeH(type)) / 2 });
    y += h + 24;
  };
  const PHASE = (label) => {
    rows.push({ key: 'phase', label, y });
    y += 48;
  };

  PHASE(L.phase1);
  ROW(['r1', 'a', 'pill', L.r1]);
  ROW(['r2a', 'a', 'card', L.r2a], ['r2b', 'b', 'note', L.r2b]);
  ROW(['r3a', 'a', 'card', L.r3a], ['r3c', 'c', 'iface', L.r3c]);
  ROW(['r4a', 'a', 'card', L.r4a], ['r4c', 'c', 'iface', L.r4c]);
  ROW(['r5a', 'a', 'card', L.r5a], ['r5c', 'c', 'iface', L.r5c]);
  ROW(['r6', 'a', 'diamond', L.r6]);
  ROW(['r7a', 'a', 'card', L.r7a], ['r7c', 'c', 'iface', L.r7c]);
  ROW(['r8', 'a', 'diamond', L.r8], ['r8b', 'b', 'note', L.r8b]);
  ROW(['r9a', 'a', 'card', L.r9a], ['r9c', 'c', 'iface', L.r9c]);
  ROW(['r10a', 'a', 'card', L.r10a], ['r10c', 'c', 'iface', L.r10c]);
  ROW(['r11', 'a', 'diamond', L.r11]);
  ROW(['r11Yes', 'a', 'cardS', L.r11Yes], ['r11No', 'a', 'cardS', L.r11No]);
  PHASE(L.phase2);
  ROW(['r12', 'a', 'card', L.r12]);
  ROW(['r13a', 'a', 'card', L.r13a], ['r13c', 'c', 'iface', L.r13c]);
  ROW(['r14c', 'c', 'iface', L.r14c]);
  ROW(['r15', 'a', 'diamond', L.r15], ['r15c', 'c', 'iface', L.r15c]);
  ROW(['r16a', 'a', 'card', L.r16a], ['r16c', 'c', 'iface', L.r16c]);
  PHASE(L.phase3);
  ROW(['r17a', 'a', 'card', L.r17a], ['r17c', 'c', 'iface', L.r17c]);
  ROW(['r18c', 'c', 'iface', L.r18c]);
  ROW(['r19a', 'a', 'card', L.r19a], ['r19c', 'c', 'iface', L.r19c]);
  ROW(['r20', 'a', 'pill', L.r20]);
  const HEIGHT = y + 20;

  // ---- lane headers + separators ----
  for (const k of ['a', 'b', 'c']) {
    const Ln = LANES[k];
    body.push(
      `<g>` +
      `<rect x="${Ln.x}" y="44" width="${Ln.w}" height="34" rx="8" fill="${Ln.fill}" stroke="${Ln.line}" stroke-width="1.2"/>` +
      text(Ln.x + Ln.w / 2, 66, Ln.label, { size: 12, weight: 700, fill: C.accentDeep, ls: 2 }) +
      `<line x1="${Ln.x}" y1="94" x2="${Ln.x + Ln.w}" y2="94" stroke="${C.bandLine}" stroke-width="1.2"/>` +
      `<line x1="${Ln.x}" y1="78" x2="${Ln.x}" y2="${HEIGHT}" stroke="${C.bandLine}" stroke-width="1.2"/>` +
      `<line x1="${Ln.x + Ln.w}" y1="78" x2="${Ln.x + Ln.w}" y2="${HEIGHT}" stroke="${C.bandLine}" stroke-width="1.2"/>` +
      `</g>`
    );
  }

  // ---- render nodes ----
  const byKey = {};
  const boxX = (k) => {
    const r = byKey[k];
    if (r.key === 'r11Yes') return 40;
    if (r.key === 'r11No') return 195;
    return GX[r.lane];
  };
  const boxW = (k) => (byKey[k].type === 'cardS' ? 135 : GW[byKey[k].lane]);

  for (const r of rows) {
    if (r.key === 'phase') {
      body.push(`<rect x="30" y="${r.y - 12}" width="4" height="20" rx="2" fill="${C.accent}"/>`);
      body.push(text(44, r.y + 2, r.label, { size: 13, weight: 700, fill: C.accentDeep, anchor: 'start', ls: 1.5 }));
      body.push(line(30, r.y + 14, 950, r.y + 14, { color: C.bandLine, dash: '6 5' }));
      continue;
    }
    byKey[r.key] = r;
    const h = typeH(r.type);
    const x = boxX(r.key);
    const w = boxW(r.key);
    if (r.type === 'pill') body.push(pill(x, r.y, w, h, r.label, { size: 12.5 }));
    else if (r.type === 'diamond') body.push(diamond(x + w / 2, r.y + h / 2, Math.min(200, w - 40), h, r.label, { size: 12 }));
    else if (r.type === 'note') body.push(card(x, r.y, w, h, r.label, { kind: 'note', size: 12 }));
    else if (r.type === 'iface') body.push(card(x, r.y, w, h, r.label, { kind: 'iface', size: 12 }));
    else if (r.type === 'cardS') body.push(card(x, r.y, w, h, r.label, { size: 12 }));
    else body.push(card(x, r.y, w, h, r.label, { size: 12.5 }));
  }

  // ---- arrows ----
  const top = (k) => byKey[k].y;
  const bot = (k) => byKey[k].y + typeH(byKey[k].type);
  const mid = (k) => byKey[k].y + typeH(byKey[k].type) / 2;
  const cx = (k) => boxX(k) + boxW(k) / 2;
  const dW = (k) => (byKey[k].type === 'diamond' ? Math.min(200, boxW(k) - 40) : 0);
  const lx = (k) => (byKey[k].type === 'diamond' ? cx(k) - dW(k) / 2 : boxX(k));
  const rx = (k) => (byKey[k].type === 'diamond' ? cx(k) + dW(k) / 2 : boxX(k) + boxW(k));

  const V = (k1, k2, label, color) => {
    const x = cx(k1);
    body.push(arrow(`M${x},${bot(k1)} L${x},${top(k2)}`));
    if (label) body.push(branchLabel(x + 12, bot(k1) + 12, label, color || C.yes));
  };
  const H = (k1, k2, label, color) => {
    body.push(arrow(`M${rx(k1)},${mid(k1)} L${lx(k2)},${mid(k2)}`));
    if (label) body.push(branchLabel((rx(k1) + lx(k2)) / 2, mid(k1) - 6, label, color || C.yes));
  };
  const Cross = (k1, k2) => {
    const gy = (bot(k1) + top(k2)) / 2;
    body.push(arrow(`M${cx(k1)},${bot(k1)} L${cx(k1)},${gy} L${cx(k2)},${gy} L${cx(k2)},${top(k2)}`));
  };

  V('r1', 'r2a');
  V('r2a', 'r3a');
  V('r3a', 'r4a');
  V('r4a', 'r5a');
  H('r3a', 'r3c'); H('r4a', 'r4c'); H('r5a', 'r5c');
  V('r5a', 'r6');
  // r6: all files imported? — No loops back to import
  body.push(arrow(`M${lx('r6')},${mid('r6')} L12,${mid('r6')} L12,${mid('r5a')} L${lx('r5a')},${mid('r5a')}`));
  body.push(branchLabel(20, (mid('r6') + mid('r5a')) / 2, L.no, C.no));
  V('r6', 'r7a', L.yes);
  V('r7a', 'r8');
  H('r7a', 'r7c');
  // r8: header found? — No → auditor manual input, then loop back to inspect
  H('r8', 'r8b', L.no, C.no);
  {
    const yB = bot('r8b') + 18;
    body.push(arrow(`M${cx('r8b')},${bot('r8b')} L${cx('r8b')},${yB} L12,${yB} L12,${mid('r7a')} L${lx('r7a')},${mid('r7a')}`));
    body.push(branchLabel(20, (mid('r7a') + bot('r8b')) / 2, L.no, C.no));
  }
  V('r8', 'r9a', L.yes);
  V('r9a', 'r10a');
  H('r9a', 'r9c'); H('r10a', 'r10c');
  V('r10a', 'r11');
  // r11: use template? — Yes → reference template, No → map manually
  body.push(arrow(`M${cx('r11') - 30},${bot('r11') - 9} L${cx('r11') - 30},${top('r11Yes')}`));
  body.push(branchLabel(cx('r11') - 45, bot('r11') + 10, L.yes, C.yes));
  body.push(arrow(`M${cx('r11') + 30},${bot('r11') - 9} L${cx('r11') + 30},${top('r11No')}`));
  body.push(branchLabel(cx('r11') + 45, bot('r11') + 10, L.no, C.no));
  V('r11Yes', 'r12');
  V('r11No', 'r12');
  V('r12', 'r13a');
  H('r13a', 'r13c');
  V('r13c', 'r14c');
  Cross('r14c', 'r15');
  // r15: run success? — No loops back to reload, Yes previews the result
  body.push(arrow(`M${lx('r15')},${mid('r15')} L12,${mid('r15')} L12,${mid('r14c')} L${lx('r14c')},${mid('r14c')}`));
  body.push(branchLabel(20, (mid('r15') + mid('r14c')) / 2, L.no, C.no));
  H('r15', 'r15c', L.yes, C.yes);
  Cross('r15c', 'r16a');
  H('r16a', 'r16c');
  V('r16a', 'r17a');
  H('r17a', 'r17c');
  V('r17c', 'r18c');
  Cross('r18c', 'r19a');
  H('r19a', 'r19c');
  V('r19a', 'r20');

  return { w: 980, h: HEIGHT, title: L.titleWorkflow, body: body.join('\n') };
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------
const EN = {
  // architecture
  title: 'OnWorking — System Architecture',
  titleFlows: 'OnWorking — User Flows',
  titleWorkflow: 'OnWorking — Agent Workflow',
  layerApp: 'APPLICATION LAYER', layerCli: 'CLI LAYER', layerAction: 'ACTION LAYER', layerSupport: 'SUPPORT LAYER',
  ui: 'UI', agent: 'Agent', cli: 'CLI',
  bigtable: 'BigTable', db: 'DB', pipeline: 'Pipeline', rule: 'Rule', workspace: 'Workspace', ingest: 'Ingest',
  errors: 'Errors', logging: 'Logging', lineage: 'Lineage',

  // user flows
  colSetup: 'SETUP FLOW', colQuery: 'QUERY FLOW', colUpdate: 'UPDATE FLOW',
  setupStart: 'Start initial setup', importFiles: 'Import files', setMapping: 'Set up mapping', preview: 'View preview',
  cleanQ: 'Is the data\nclean?', yes: 'Yes', no: 'No', cleanTransform: 'Set cleaning &\ntransforms', setupDone: 'Finish setup',
  queryStart: 'Start query', useAi: 'Use AI?', describe: 'Describe request\nto agent', aiSql: 'AI generates SQL', correctQ: 'Is it\ncorrect?', inputSql: 'Input SQL',
  queryTable: 'Generate query table', saveQ: 'Save?', savePipeline: 'Save pipeline config', queryDone: 'Finish query',
  updateStart: 'Start update', updateSource: 'Update source file', recompute: 'Recompute data', newData: 'Get new data', updateDone: 'Finish update',
  syncNote: 'AI-executed actions\nare mirrored by the\nfrontend in sync',

  // agent workflow
  laneAgent: 'AGENT APP', laneAuditor: 'AUDITOR', laneOnwork: 'ONWORKING',
  phase1: 'PHASE 1 · IMPORT & MAPPING', phase2: 'PHASE 2 · CLEAN PIPELINE', phase3: 'PHASE 3 · AGGREGATE & QUERY',
  r1: 'Start · plan from PBC /\ncustomer files',
  r2a: 'Read manual · connect MCP ·\nprepare app state', r2b: 'Excel / CSV files\nin folders',
  r3a: 'Call tool: open workspace', r3c: 'Interface: switch active\nworkspace · state machine',
  r4a: 'Call tool: create BigTable', r4c: 'Interface: create\nBigTable · state machine',
  r5a: 'Call tool: import files', r5c: 'Interface: import\nsource files',
  r6: 'All files\nimported?',
  r7a: 'Call tool: get headers ·\ninspect sheet', r7c: 'Interface: detect\nheader row',
  r8: 'Header\nfound?', r8b: 'Manual header input ·\nsearch whole sheet',
  r9a: 'Plan fields · call tool:\nset BigTable fields', r9c: 'Interface: generate\nfield config',
  r10a: 'Write field mapping ·\nsave template', r10c: 'Interface: add mapping /\ntemplate / apply',
  r11: 'Use\ntemplate?', r11Yes: 'Call tool: reference template', r11No: 'Think mapping · call tool:\nmapping settings',
  r12: 'Describe cleaning rules\n(or input SQL)',
  r13a: 'Call tool: add clean\npipeline (with SQL)', r13c: 'Interface: add clean pipeline\n(overwritable)',
  r14c: 'Load BigTable DB ·\nload by rules → BigTable',
  r15: 'Run ·\nsuccess?', r15c: 'Interface: preview\nclean result',
  r16a: 'Call tool: save\nclean settings', r16c: 'Interface: generate\nsettings file',
  r17a: 'Call tool: clean & aggregate →\nMasterTable', r17c: 'Interface: execute clean &\naggregate → MasterTable',
  r18c: 'Interface: new query pipeline\n(SQL) · run',
  r19a: 'Build SQL from prompt ·\nrun query pipeline', r19c: 'Run query pipeline',
  r20: 'Finish · deliver CSV',
};

const ZH = {
  // architecture
  title: 'OnWorking — 系统架构',
  titleFlows: 'OnWorking — 用户流程',
  titleWorkflow: 'OnWorking — Agent 工作流',
  layerApp: '应用层', layerCli: '命令行层', layerAction: '动作层', layerSupport: '支撑层',
  ui: '界面', agent: 'Agent', cli: 'CLI',
  bigtable: '大表', db: '数据库', pipeline: '管线', rule: '规则', workspace: '工作区', ingest: '导入',
  errors: '错误', logging: '日志', lineage: '血缘',

  // user flows
  colSetup: '设置流程', colQuery: '查询流程', colUpdate: '更新流程',
  setupStart: '开始初次设置', importFiles: '导入文件', setMapping: '设置映射', preview: '查看预览',
  cleanQ: '数据是否\n干净？', yes: '是', no: '否', cleanTransform: '设置清洗与\n转换', setupDone: '完成设置',
  queryStart: '开始查询', useAi: '是否使用\nAI？', describe: '向 agent\n描述需求', aiSql: 'AI 生成 SQL 语句', correctQ: '是否\n正确？', inputSql: '输入 SQL 语句',
  queryTable: '生成查询表', saveQ: '是否保存？', savePipeline: '保存 pipeline 配置', queryDone: '完成查询',
  updateStart: '开始更新', updateSource: '更新源文件', recompute: '点击数据重算', newData: '获得新数据', updateDone: '结束更新',
  syncNote: 'AI 执行的动作\n前端要同步渲染',

  // agent workflow
  laneAgent: 'Agent 应用', laneAuditor: '审计方', laneOnwork: 'Onworking',
  phase1: '第一阶段 · 导入与映射', phase2: '第二阶段 · 清洗管线', phase3: '第三阶段 · 归集与查询',
  r1: '开始 · 根据计划获取\nPBC / 客户数据',
  r2a: '读取手册 · 连接 MCP ·\n准备应用状态', r2b: '文件夹中的\nExcel / CSV 文件',
  r3a: '调用 tool：打开工作区', r3c: '接口：切换活跃工作区\n· 项目状态机',
  r4a: '调用 tool：创建新大表', r4c: '接口：创建新大表\n· 项目状态机',
  r5a: '调用 tool：导入新文件', r5c: '接口：导入文件',
  r6: '文件是否\n全部导入？',
  r7a: '调用 tool：获取文件表头 ·\n查看工作表', r7c: '接口：确定表头',
  r8: '是否能找\n到表头？', r8b: '人工输入表头 ·\n查找整张工作表',
  r9a: '规划大表字段 · 调用 tool：\n设置大表字段', r9c: '接口：生成大表\n字段配置',
  r10a: '填写字段映射 ·\n保存为模板', r10c: '接口：增加映射 /\n新增模板 / 应用模板',
  r11: '是否存在模板\n并使用？', r11Yes: '调用 tool：引用模板', r11No: '思考映射关系 · 调用 tool：\n映射设置',
  r12: '输入清洗要求\n（或输入 SQL）',
  r13a: '调用 tool：增加数据\n清洗管线（带 SQL）', r13c: '接口：增加清洗管线\n（可覆盖旧文件）',
  r14c: '加载大表数据库 ·\n根据规则加载至大表',
  r15: '是否成功？', r15c: '接口：清洗结果预览',
  r16a: '调用 tool：保存清洗设置', r16c: '接口：生成设置文件',
  r17a: '调用 tool：从大表清洗归集\n到 MasterTable', r17c: '接口：执行清洗并归集\n→ MasterTable',
  r18c: '接口：新建查询管线（带 SQL）\n· 执行查询管线',
  r19a: '根据提示词构建 SQL ·\n运行查询管线', r19c: '执行查询管线',
  r20: '完成 · 交付 CSV',
};

const OUT = { en: 'docs/ARC/EN', zh: 'docs/ARC/ZH' };

function write(lang) {
  const L = lang === 'zh' ? ZH : EN;
  const dir = join(ROOT, OUT[lang]);
  mkdirSync(dir, { recursive: true });
  const diagrams = [
    ['architecture.svg', architecture],
    ['user-flows.svg', userFlows],
    ['agent-workflow.svg', agentWorkflow],
  ];
  for (const [name, fn] of diagrams) {
    const { w, h, title, body } = fn(L);
    writeFileSync(join(dir, name), svgDoc(w, h, title, body, lang), 'utf8');
    console.log('  wrote', join(OUT[lang], name));
  }
}

console.log('Generating architecture SVGs…');
write('en');
write('zh');
console.log('Done.');
