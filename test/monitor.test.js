'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../core/monitor.js');

test('hazard increments over the 90-day window sum to the full cumulative hazard', () => {
  const p = 0.08, theta = -Math.log(1 - p);
  assert.ok(Math.abs(M.cumHaz(theta, 90) - theta) < 1e-12);
  assert.ok(M.cumHaz(theta, 30) > M.cumHaz(theta, 10));
  assert.strictEqual(M.cumHaz(theta, 0), 0);
  assert.strictEqual(M.cumHaz(theta, 400), theta);
});

test('CUSUM with no losses stays at zero; one loss jumps by ln(rho)', () => {
  const quiet = M.cusumPath([{ tx: 0, theta: 0.05, loss: null }], 2, 0, 120);
  assert.strictEqual(quiet.max, 0);
  const one = M.cusumPath([{ tx: 0, theta: 0.05, loss: 10 }], 2, 0, 30);
  const sameDayHazard = M.cumHaz(0.05, 10) - M.cumHaz(0.05, 9);
  assert.ok(Math.abs(one.max - (Math.log(2) - sameDayHazard)) < 1e-12, 'jump equals ln 2 minus that day\'s expected hazard');
  assert.ok(one.path[29] < one.path[10] + 1e-12);
});

test('logistic IRLS recovers known coefficients', () => {
  const rng = M.mulberry32(5), X = [], y = [];
  for (let i = 0; i < 20000; i++) {
    const a = rng() * 4 - 2, b = rng() < 0.4 ? 1 : 0;
    const p = 1 / (1 + Math.exp(-(-2 + 0.8 * a + 0.6 * b)));
    X.push([1, a, b]); y.push(rng() < p ? 1 : 0);
  }
  const beta = M.fitLogistic(X, y);
  assert.ok(Math.abs(beta[0] + 2) < 0.12, 'intercept ' + beta[0]);
  assert.ok(Math.abs(beta[1] - 0.8) < 0.08, 'slope ' + beta[1]);
  assert.ok(Math.abs(beta[2] - 0.6) < 0.12, 'binary ' + beta[2]);
});

test('simulation-calibrated limit holds the false-alarm rate near alpha on fresh draws', () => {
  const rng = M.mulberry32(11), cases = [];
  for (let i = 0; i < 70; i++) cases.push({ tx: Math.floor(rng() * 200), p: 0.03 + rng() * 0.12, loss: null });
  const cal = M.calibrateLimit(cases, 2, 0, 280, { nSim: 1500, alpha: 0.05, seed: 3 });
  const far = M.falseAlarmRate(cases, 2, 0, 280, cal.h, 1500, 99);
  assert.ok(far > 0.025 && far < 0.08, 'false alarm rate ' + far);
});

test('a doubled-odds center is detected far more often than an in-control one', () => {
  const rng = M.mulberry32(21), base = [];
  for (let i = 0; i < 90; i++) base.push({ tx: Math.floor(rng() * 180), p: 0.06 + rng() * 0.06, loss: null });
  const cal = M.calibrateLimit(base, 2, 0, 280, { nSim: 800, alpha: 0.05, seed: 4 });
  const bad = base.map(c => { const o = c.p / (1 - c.p) * 3; return { tx: c.tx, p: o / (1 + o), loss: null }; });
  let hits = 0;
  const r2 = M.mulberry32(8);
  for (let s = 0; s < 400; s++) {
    // outcomes drawn from the elevated risk, judged against the in-control expectation
    const sim = M.simulateOutcomes(bad, r2).map((c, i) => ({ tx: c.tx, theta: -Math.log(1 - base[i].p), loss: c.loss }));
    if (M.cusumPath(sim, 2, 0, 280).max >= cal.h) hits++;
  }
  assert.ok(hits / 400 > 0.6, 'power ' + hits / 400);
});

test('full analysis of the committed registry is internally consistent', () => {
  const reg = require('../data/registry.json');
  const r = M.analyze(reg, { nSim: 200 });
  const cut = M.dayIndex(reg.cutDate, reg.origin);
  const lossesBeforeCut = reg.cases.filter(c => c.lossDay != null && M.dayIndex(c.txDate, reg.origin) + c.lossDay <= cut).length;
  assert.strictEqual(r.centers.reduce((s, c) => s + c.observed, 0), lossesBeforeCut);
  assert.strictEqual(r.centers.reduce((s, c) => s + c.n, 0), reg.cases.length);
  const drift = r.centers.find(c => c.truth.kind === 'drift');
  assert.ok(drift.adj.signalDay != null, 'drift center should signal on the adjusted chart');
  for (const c of r.centers) {
    assert.ok(c.adj.h > 0 && Number.isFinite(c.adj.h));
    const d = M.drivers(c);
    const dcd = d.find(x => x.label === 'DCD donors'), dbd = d.find(x => x.label === 'DBD donors');
    assert.strictEqual(dcd.n + dbd.n, c.n);
    assert.strictEqual(dcd.observed + dbd.observed, c.observed);
    assert.ok(Math.abs(dcd.expected + dbd.expected - c.expectedAdj) < 1e-9);
  }
});
