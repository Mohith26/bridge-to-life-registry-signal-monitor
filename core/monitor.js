/*
 * Registry Signal Monitor core.
 *
 * Risk-adjusted, continuous-time CUSUM (Biswas & Kalbfleisch 2008 style) for
 * 90-day graft loss after HOPE-perfused liver transplant, with per-center
 * control limits calibrated by Monte Carlo simulation.
 *
 * Works in the browser (window.BTLMonitor) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  var DAY = 86400000;
  var WINDOW = 90;          // days of follow-up that count toward the outcome
  var SHAPE = 0.5;          // Weibull shape for the within-window hazard (front-loaded early losses)

  // ---------- utilities ----------
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function dayIndex(iso, originIso) {
    return Math.round((Date.parse(iso) - Date.parse(originIso)) / DAY);
  }
  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    var pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  // ---------- covariates ----------
  var FEATURES = [
    { key: 'donorAge10', label: 'Donor age (per 10 y over 40)', f: function (c) { return (c.donorAge - 40) / 10; } },
    { key: 'dcd', label: 'DCD donor', f: function (c) { return c.dcd ? 1 : 0; } },
    { key: 'steatosis30', label: 'Macrosteatosis >= 30%', f: function (c) { return c.macrosteatosis >= 30 ? 1 : 0; } },
    { key: 'citOver6', label: 'Cold time before HOPE (per h over 6)', f: function (c) { return Math.max(0, c.coldHoursBeforeHope - 6); } },
    { key: 'meld5', label: 'Recipient MELD (per 5 over 25)', f: function (c) { return (c.meld - 25) / 5; } },
    { key: 'retx', label: 'Re-transplant', f: function (c) { return c.retransplant ? 1 : 0; } }
  ];
  function design(c) {
    var x = [1];
    for (var i = 0; i < FEATURES.length; i++) x.push(FEATURES[i].f(c));
    return x;
  }

  // ---------- logistic regression (IRLS with a small ridge) ----------
  function solve(A, b) {
    var n = b.length, M = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === col) continue;
        var f = M[r2][col] / M[col][col];
        for (var k = col; k <= n; k++) M[r2][k] -= f * M[col][k];
      }
    }
    return M.map(function (r, i) { return r[n] / r[i]; });
  }
  function fitLogistic(X, y, opts) {
    opts = opts || {};
    var ridge = opts.ridge == null ? 1e-3 : opts.ridge, iters = opts.iters || 50;
    var p = X[0].length, beta = new Array(p).fill(0);
    for (var it = 0; it < iters; it++) {
      var H = [], g = new Array(p).fill(0);
      for (var a = 0; a < p; a++) H.push(new Array(p).fill(0));
      for (var i = 0; i < X.length; i++) {
        var z = 0; for (var j = 0; j < p; j++) z += X[i][j] * beta[j];
        var mu = sigmoid(z), w = mu * (1 - mu);
        for (var j2 = 0; j2 < p; j2++) {
          g[j2] += X[i][j2] * (y[i] - mu);
          for (var k = 0; k < p; k++) H[j2][k] += w * X[i][j2] * X[i][k];
        }
      }
      for (var d = 1; d < p; d++) { H[d][d] += ridge; g[d] -= ridge * beta[d]; }
      var step = solve(H, g), maxStep = 0;
      for (var s = 0; s < p; s++) { beta[s] += step[s]; maxStep = Math.max(maxStep, Math.abs(step[s])); }
      if (maxStep < 1e-9) break;
    }
    return beta;
  }
  function predict(beta, c) {
    var x = design(c), z = 0;
    for (var j = 0; j < beta.length; j++) z += x[j] * beta[j];
    return sigmoid(z);
  }

  // Outcome label usable for model fitting: only cases whose full 90-day window has closed by the data cut
  // (including early losses would bias the fitted risk upward).
  function labelled(c, cutDay, origin) {
    var tx = dayIndex(c.txDate, origin);
    if (tx + WINDOW > cutDay) return null;
    return c.lossDay != null && c.lossDay <= WINDOW ? 1 : 0;
  }

  // ---------- hazard bookkeeping ----------
  // 90-day loss probability p  ->  cumulative hazard theta = -ln(1-p), spread as Weibull(SHAPE) over the window.
  function cumHaz(theta, t) {
    if (t <= 0) return 0;
    return theta * Math.pow(Math.min(t, WINDOW) / WINDOW, SHAPE);
  }

  /*
   * Continuous-time risk-adjusted CUSUM, evaluated daily.
   *   G(t) = max(0, G(t-1) + ln(rho) * dN(t) - (rho - 1) * dLambda(t))
   * dN: observed graft losses that day (within each patient's 90-day window)
   * dLambda: expected hazard accumulated that day by every patient still at risk
   * cases: [{tx: dayIndex, p: expected 90-day risk, loss: day-of-loss after tx or null}]
   */
  var INC = (function () {
    var a = [0];
    for (var t = 1; t <= WINDOW; t++) a.push(Math.pow(t / WINDOW, SHAPE) - Math.pow((t - 1) / WINDOW, SHAPE));
    return a;
  })();

  function cusumPath(cases, rho, startDay, endDay) {
    var lr = Math.log(rho), G = 0, maxG = 0, n = cases.length, len = endDay - startDay + 1;
    var dN = new Float64Array(len), dL = new Float64Array(len);
    for (var i = 0; i < n; i++) {
      var c = cases[i];
      var last = WINDOW;
      if (c.loss != null && c.loss <= WINDOW) {
        last = c.loss;
        var ed = c.tx + c.loss - startDay;
        if (ed >= 0 && ed < len) dN[ed] += 1;
      }
      for (var t = 1; t <= last; t++) {
        var d = c.tx + t - startDay;
        if (d < 0) continue;
        if (d >= len) break;
        dL[d] += c.theta * INC[t];
      }
    }
    var path = new Array(len);
    for (var k = 0; k < len; k++) {
      G = G + lr * dN[k] - (rho - 1) * dL[k];
      if (G < 0) G = 0;
      if (G > maxG) maxG = G;
      path[k] = G;
    }
    return { path: path, max: maxG };
  }

  function withTheta(cases) {
    return cases.map(function (c) { return { tx: c.tx, p: c.p, theta: -Math.log(1 - c.p), loss: c.loss }; });
  }

  // Draw an in-control outcome for each case from its own expected risk (same Weibull shape).
  function simulateOutcomes(cases, rng) {
    return cases.map(function (c) {
      var theta = -Math.log(1 - c.p);
      // total hazard over window = theta; draw E ~ Exp(1); loss if E < theta at t = WINDOW * (E/theta)^(1/SHAPE)
      var E = -Math.log(1 - rng());
      var loss = null;
      if (E < theta) loss = Math.max(1, Math.ceil(WINDOW * Math.pow(E / theta, 1 / SHAPE)));
      return { tx: c.tx, p: c.p, theta: theta, loss: loss };
    });
  }

  // Control limit h so that P(max G over the monitoring window >= h | in control) = alpha.
  function calibrateLimit(cases, rho, startDay, endDay, opts) {
    var nSim = opts.nSim || 400, alpha = opts.alpha || 0.05, rng = opts.rng || mulberry32(opts.seed || 1);
    var maxes = [];
    for (var s = 0; s < nSim; s++) {
      var sim = simulateOutcomes(cases, rng);
      // censor at the data cut: losses after endDay are not yet observed
      maxes.push(cusumPath(sim, rho, startDay, endDay).max);
    }
    maxes.sort(function (a, b) { return a - b; });
    var h = quantile(maxes, 1 - alpha);
    return { h: Math.max(h, Math.log(rho) * 0.999), maxes: maxes };
  }

  function falseAlarmRate(cases, rho, startDay, endDay, h, nSim, seed) {
    var rng = mulberry32(seed), hits = 0;
    for (var s = 0; s < nSim; s++) {
      var sim = simulateOutcomes(cases, rng);
      if (cusumPath(sim, rho, startDay, endDay).max >= h) hits++;
    }
    return hits / nSim;
  }

  function firstCrossing(path, h, startDay) {
    for (var i = 0; i < path.length; i++) if (path[i] >= h) return startDay + i;
    return null;
  }

  /*
   * Full analysis of a registry snapshot.
   * reg: { origin, cutDate, centers:[{id,...}], cases:[{center, txDate, ..., lossDay}] }
   */
  function analyze(reg, opts) {
    opts = opts || {};
    var rho = opts.rho || 2, alpha = opts.alpha || 0.05, nSim = opts.nSim || 300, seed = opts.seed || 7;
    var origin = reg.origin, cutDay = dayIndex(reg.cutDate, origin);

    // 1) risk model fit on all cases with a known 90-day label
    var X = [], y = [];
    reg.cases.forEach(function (c) {
      var l = labelled(c, cutDay, origin);
      if (l != null) { X.push(design(c)); y.push(l); }
    });
    var beta = fitLogistic(X, y);
    var pooledRate = y.reduce(function (s, v) { return s + v; }, 0) / y.length;

    // 2) per-center CUSUM, adjusted and unadjusted
    var byCenter = {};
    reg.cases.forEach(function (c) { (byCenter[c.center] = byCenter[c.center] || []).push(c); });
    var startDay = 0;
    var centers = reg.centers.map(function (ce, idx) {
      var cs = (byCenter[ce.id] || []).slice().sort(function (a, b) { return Date.parse(a.txDate) - Date.parse(b.txDate); });
      var obsCases = cs.map(function (c) {
        var tx = dayIndex(c.txDate, origin);
        var loss = (c.lossDay != null && tx + c.lossDay <= cutDay) ? c.lossDay : null;
        return { tx: tx, loss: loss, raw: c };
      });
      function run(pFn, salt) {
        var cases = obsCases.map(function (o) {
          var p = pFn(o.raw), atRisk = o.loss != null ? o.loss : cutDay - o.tx;
          return { tx: o.tx, p: p, loss: o.loss, raw: o.raw, e: cumHaz(-Math.log(1 - p), atRisk) };
        });
        var cal = calibrateLimit(cases, rho, startDay, cutDay, { nSim: nSim, alpha: alpha, seed: seed * 1000 + idx * 17 + salt });
        var res = cusumPath(withTheta(cases), rho, startDay, cutDay);
        var sigDay = firstCrossing(res.path, cal.h, startDay);
        var expectedToDate = 0;
        cases.forEach(function (c) { expectedToDate += c.e; });
        return { h: cal.h, path: res.path, max: res.max, signalDay: sigDay, expected: expectedToDate,
          cases: cases };
      }
      var adj = run(function (c) { return predict(beta, c); }, 1);
      var unadj = run(function () { return pooledRate; }, 2);
      var observed = obsCases.filter(function (o) { return o.loss != null; }).length;
      var casesBeforeSignal = function (sd) {
        if (sd == null) return null;
        return obsCases.filter(function (o) { return o.tx <= sd; }).length;
      };
      var dcdShare = cs.length ? cs.filter(function (c) { return c.dcd; }).length / cs.length : 0;
      var meanRisk = cs.length ? adj.cases.reduce(function (s, c) { return s + c.p; }, 0) / cs.length : 0;
      return {
        id: ce.id, region: ce.region, n: cs.length, observed: observed,
        expectedAdj: adj.expected, expectedUnadj: unadj.expected,
        oe: adj.expected > 0 ? observed / adj.expected : null,
        dcdShare: dcdShare, meanRisk: meanRisk,
        adj: adj, unadj: unadj,
        adjSignalCase: casesBeforeSignal(adj.signalDay), unadjSignalCase: casesBeforeSignal(unadj.signalDay),
        truth: ce.truth || null
      };
    });

    return { beta: beta, features: FEATURES.map(function (f) { return f.label; }), pooledRate: pooledRate,
      nLabelled: y.length, cutDay: cutDay, rho: rho, alpha: alpha, nSim: nSim, centers: centers };
  }

  // Subgroup observed/expected for one center (which kinds of cases are driving the excess).
  function drivers(centerResult) {
    var groups = [
      { label: 'DCD donors', f: function (c) { return c.dcd; } },
      { label: 'DBD donors', f: function (c) { return !c.dcd; } },
      { label: 'Donor age 60+', f: function (c) { return c.donorAge >= 60; } },
      { label: 'Cold time before HOPE > 6 h', f: function (c) { return c.coldHoursBeforeHope > 6; } },
      { label: 'MELD 30+', f: function (c) { return c.meld >= 30; } }
    ];
    var cs = centerResult.adj.cases;
    return groups.map(function (g) {
      var o = 0, e = 0, n = 0;
      cs.forEach(function (c) {
        if (!g.f(c.raw)) return;
        n++; if (c.loss != null) o++;
        e += c.e;
      });
      return { label: g.label, n: n, observed: o, expected: e, oe: e > 0 ? o / e : null };
    });
  }

  var api = { mulberry32: mulberry32, dayIndex: dayIndex, quantile: quantile, fitLogistic: fitLogistic,
    predict: predict, design: design, FEATURES: FEATURES, cumHaz: cumHaz, cusumPath: cusumPath,
    withTheta: withTheta, simulateOutcomes: simulateOutcomes, calibrateLimit: calibrateLimit,
    falseAlarmRate: falseAlarmRate, firstCrossing: firstCrossing, analyze: analyze, labelled: labelled,
    drivers: drivers,
    WINDOW: WINDOW, SHAPE: SHAPE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BTLMonitor = api;
})(this);
