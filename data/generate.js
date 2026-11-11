// Seeded synthetic registry generator. Run: node data/generate.js  -> data/registry.json and data/registry.js
// All patients, centers and outcomes are synthetic. Center codes are anonymous.
'use strict';
const fs = require('fs');
const path = require('path');
const { mulberry32 } = require('../core/monitor.js');

const SEED = Number(process.env.SEED || 2);
const rng = mulberry32(SEED);
const normal = () => { let u = 0, v = 0; while (u === 0) u = rng(); v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const ORIGIN = '2026-02-01';
const CUT = '2026-11-06';
const START = Date.parse('2026-02-02');
const END = Date.parse('2026-10-30');
const DAY = 86400000;

const regions = ['Northeast', 'Southeast', 'Midwest', 'South Central', 'Mountain West', 'Pacific'];
// volume, DCD share, donor-age shift, steatosis share, and synthetic ground truth
const spec = [
  [118, 0.24, 0, 0.10], [96, 0.28, 0, 0.12], [84, 0.72, 10, 0.32, 'marginal'], [80, 0.22, -2, 0.08],
  [74, 0.30, 1, 0.12], [71, 0.26, 0, 0.10], [92, 0.27, 0, 0.11, 'drift'], [62, 0.70, 11, 0.30, 'marginal'],
  [58, 0.25, -1, 0.09], [55, 0.31, 2, 0.13], [52, 0.24, 0, 0.10], [49, 0.76, 12, 0.34, 'marginal'],
  [45, 0.29, 0, 0.12], [41, 0.21, -3, 0.08], [38, 0.33, 1, 0.12], [34, 0.27, 0, 0.10],
  [30, 0.24, 0, 0.09], [27, 0.30, 2, 0.13], [22, 0.26, 0, 0.10], [18, 0.35, 1, 0.14]
];
// true data-generating model for 90-day graft loss (logit scale)
const TRUE = { b0: -3.3, age10: 0.24, dcd: 0.7, steat: 0.5, cit: 0.14, meld5: 0.13, retx: 0.75 };
const DRIFT_AFTER = 20;   // drift starts after this many cases at the drift center
const DRIFT_OR = 3.5;     // odds multiplier after drift

const centers = [];
const cases = [];
spec.forEach((s, i) => {
  const id = 'C-' + String(i + 1).padStart(2, '0');
  const [n, dcdShare, ageShift, steatShare, kind] = s;
  const truth = kind === 'drift' ? { kind, afterCase: DRIFT_AFTER, oddsMultiplier: DRIFT_OR }
    : kind === 'marginal' ? { kind } : { kind: 'in-control' };
  centers.push({ id, region: regions[i % regions.length], truth });
  // adoption ramps: later-adopting smaller centers start later
  const startOffset = Math.floor(rng() * 40 + (i > 12 ? 30 : 0));
  const dates = [];
  for (let k = 0; k < n; k++) dates.push(START + startOffset * DAY + Math.floor(Math.pow(rng(), 0.85) * ((END - START) / DAY - startOffset)) * DAY);
  dates.sort((a, b) => a - b);
  dates.forEach((t, k) => {
    const dcd = rng() < dcdShare;
    const donorAge = Math.round(clamp(46 + ageShift + 14 * normal() + (dcd ? 3 : 0), 12, 82));
    const macrosteatosis = rng() < steatShare ? Math.round(30 + rng() * 25) : Math.round(rng() * 25);
    const coldHoursBeforeHope = Math.round(clamp(5.2 + 1.6 * normal() + (dcd ? -0.6 : 0.3), 2, 11) * 10) / 10;
    const hopeHours = Math.round(clamp(2.4 + 1.1 * normal(), 1, 7) * 10) / 10;
    const meld = Math.round(clamp(25 + 7 * normal(), 8, 42));
    const retransplant = rng() < 0.05;
    let z = TRUE.b0 + TRUE.age10 * (donorAge - 40) / 10 + TRUE.dcd * (dcd ? 1 : 0) + TRUE.steat * (macrosteatosis >= 30 ? 1 : 0)
      + TRUE.cit * Math.max(0, coldHoursBeforeHope - 6) + TRUE.meld5 * (meld - 25) / 5 + TRUE.retx * (retransplant ? 1 : 0);
    if (kind === 'drift' && k >= DRIFT_AFTER) z += Math.log(DRIFT_OR);
    const p = 1 / (1 + Math.exp(-z));
    // time to loss: same front-loaded Weibull(0.5) shape the monitor assumes
    const theta = -Math.log(1 - p);
    const E = -Math.log(1 - rng());
    const lossDay = E < theta ? Math.max(1, Math.ceil(90 * Math.pow(E / theta, 2))) : null;
    const ead = rng() < clamp(0.12 + 0.6 * p + (dcd ? 0.05 : 0), 0, 0.9);
    cases.push({
      caseId: id + '-' + String(k + 1).padStart(3, '0'), center: id,
      txDate: new Date(t).toISOString().slice(0, 10),
      donorAge, dcd, macrosteatosis, coldHoursBeforeHope, hopeHours, meld, retransplant, ead, lossDay
    });
  });
});

const reg = { generatedBy: "data/generate.js seed " + SEED, origin: ORIGIN, cutDate: CUT, outcome: '90-day graft loss', centers, cases };
fs.writeFileSync(path.join(__dirname, 'registry.json'), JSON.stringify(reg));
fs.writeFileSync(path.join(__dirname, 'registry.js'), 'window.BTL_REGISTRY = ' + JSON.stringify(reg) + ';\n');
const losses = cases.filter(c => c.lossDay != null).length;
console.log(`centers=${centers.length} cases=${cases.length} losses(any time)=${losses}`);
