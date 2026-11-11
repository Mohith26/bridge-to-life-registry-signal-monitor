// Robustness sweep: regenerate the synthetic registry under 12 seeds and record which centers each chart flags.
// Run: node data/sweep.js   (restores the default seed-2 data afterwards)
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const gen = path.join(__dirname, 'generate.js');
const rows = [];
for (let s = 1; s <= 12; s++) {
  execFileSync(process.execPath, [gen], { env: Object.assign({}, process.env, { SEED: String(s) }) });
  delete require.cache[require.resolve('./registry.json')];
  const reg = require('./registry.json');
  const M = require('../core/monitor.js');
  const r = M.analyze(reg, { nSim: 600 });
  const kind = id => r.centers.find(c => c.id === id).truth.kind;
  const adj = r.centers.filter(c => c.adj.signalDay != null).map(c => c.id);
  const un = r.centers.filter(c => c.unadj.signalDay != null).map(c => c.id);
  rows.push({ seed: s, driftCaughtAdj: adj.some(id => kind(id) === 'drift'), driftCaughtUnadj: un.some(id => kind(id) === 'drift'),
    marginalFlaggedAdj: adj.filter(id => kind(id) === 'marginal').length, marginalFlaggedUnadj: un.filter(id => kind(id) === 'marginal').length,
    inControlFlaggedAdj: adj.filter(id => kind(id) === 'in-control').length, inControlFlaggedUnadj: un.filter(id => kind(id) === 'in-control').length });
}
execFileSync(process.execPath, [gen]);
const sum = k => rows.reduce((s, r) => s + (r[k] === true ? 1 : r[k] === false ? 0 : r[k]), 0);
console.table(rows);
console.log(JSON.stringify({ seeds: rows.length, driftCaughtAdj: sum('driftCaughtAdj'), driftCaughtUnadj: sum('driftCaughtUnadj'),
  marginalFlagsAdj: sum('marginalFlaggedAdj'), marginalFlagsUnadj: sum('marginalFlaggedUnadj'),
  inControlFlagsAdj: sum('inControlFlaggedAdj'), inControlFlagsUnadj: sum('inControlFlaggedUnadj') }));
