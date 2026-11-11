(function () {
  'use strict';
  var M = window.BTLMonitor, REG = window.BTL_REGISTRY;
  var state = { rho: 2, alpha: 0.05, view: 'both', sel: null, res: null };
  var DAY = 86400000;
  var fmt1 = function (x) { return x == null ? 'n/a' : x.toFixed(1); };
  var fmt2 = function (x) { return x == null ? 'n/a' : x.toFixed(2); };
  function dateOf(day) { return new Date(Date.parse(REG.origin) + day * DAY); }
  function dshort(day) { return dateOf(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
  function dlong(day) { return dateOf(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  function $(id) { return document.getElementById(id); }
  function status(c) {
    if (c.adj.signalDay != null) return ['Signal', 'c-red'];
    var cur = c.adj.path[c.adj.path.length - 1];
    if (cur >= 0.7 * c.adj.h) return ['Watch', 'c-amber'];
    return ['In control', 'c-green'];
  }

  function run() {
    var t0 = performance.now();
    state.res = M.analyze(REG, { rho: state.rho, alpha: state.alpha, nSim: 600, seed: 7 });
    state.ms = Math.round(performance.now() - t0);
    if (!state.sel) {
      var firstSig = state.res.centers.find(function (c) { return c.adj.signalDay != null; });
      state.sel = (firstSig || state.res.centers[0]).id;
    }
    renderAll();
  }

  function renderAll() {
    var r = state.res, cs = r.centers;
    var nCases = REG.cases.length;
    $('cbMid').innerHTML = '<span>Data cut <b>' + dlong(r.cutDay) + '</b></span><span><b>' + nCases.toLocaleString() + '</b> HOPE cases</span><span><b>' + cs.length + '</b> centers</span>';
    $('centerCount').textContent = cs.length + ' enrolled';
    var adjSig = cs.filter(function (c) { return c.adj.signalDay != null; });
    var unSig = cs.filter(function (c) { return c.unadj.signalDay != null; });
    var unOnly = unSig.filter(function (c) { return c.adj.signalDay == null; });
    var unOnlyDcd = unOnly.filter(function (c) { return c.dcdShare >= 0.5; });
    var txt = '<b>' + adjSig.length + '</b> center' + (adjSig.length === 1 ? '' : 's') + ' signaled on the risk-adjusted chart' +
      (adjSig.length ? ' (' + adjSig.map(function (c) { return c.id; }).join(', ') + ')' : '') + '. ';
    if (unOnly.length) txt += 'An unadjusted chart would also flag ' + unOnly.map(function (c) { return c.id + ' (' + Math.round(c.dcdShare * 100) + '% DCD)'; }).join(', ') + '.';
    else txt += 'An unadjusted chart flags the same set here.';
    $('announce').innerHTML = txt;
    state.summary = { adjSig: adjSig, unOnly: unOnly, unOnlyDcd: unOnlyDcd };

    var tb = $('centerTbl').querySelector('tbody');
    tb.innerHTML = '';
    cs.forEach(function (c) {
      var st = status(c), tr = document.createElement('tr');
      if (c.id === state.sel) tr.className = 'sel';
      tr.innerHTML = '<td><span class="cid">' + c.id + '</span><span class="reg">' + c.region + '</span></td><td class="r">' + c.n +
        '</td><td class="r">' + Math.round(c.dcdShare * 100) + '%</td><td class="r">' + fmt2(c.oe) +
        '</td><td><span class="chip ' + st[1] + '">' + st[0] + '</span></td>';
      tr.onclick = function () { state.sel = c.id; renderAll(); };
      tb.appendChild(tr);
    });

    $('nLab').textContent = r.nLabelled.toLocaleString();
    var bt = $('betaTbl').querySelector('tbody');
    bt.innerHTML = '<tr><td>Baseline 90-day loss risk (pooled)</td><td class="r">' + (r.pooledRate * 100).toFixed(1) + '%</td></tr>' +
      r.features.map(function (f, i) { return '<tr><td>' + f + '</td><td class="r">OR ' + Math.exp(r.beta[i + 1]).toFixed(2) + '</td></tr>'; }).join('');
    $('runMeta').textContent = r.nSim + ' simulations per center · ' + state.ms + ' ms';
    renderCenter();
    renderTruth();
  }

  function renderCenter() {
    var r = state.res, c = r.centers.find(function (x) { return x.id === state.sel; });
    var st = status(c);
    $('selTitle').innerHTML = 'Center ' + c.id + ' <span class="chip ' + st[1] + '" style="vertical-align:3px">' + st[0] + '</span>';
    $('selSub').textContent = c.region + ' · ' + c.n + ' HOPE cases · ' + Math.round(c.dcdShare * 100) + '% DCD · mean expected 90-day loss risk ' + (c.meanRisk * 100).toFixed(1) + '%';
    var cur = c.adj.path[c.adj.path.length - 1];
    $('roV').textContent = fmt2(state.view === 'unadj' ? c.unadj.path[c.unadj.path.length - 1] : cur);
    $('roH').textContent = fmt2(state.view === 'unadj' ? c.unadj.h : c.adj.h);
    $('tObs').textContent = c.observed;
    $('tExp').textContent = fmt1(c.expectedAdj);
    if (c.adj.signalDay != null) {
      $('tSig').textContent = dshort(c.adj.signalDay);
      $('tSigSub').textContent = 'case ' + c.adjSignalCase + ' of ' + c.n;
    } else {
      $('tSig').textContent = 'None';
      $('tSigSub').textContent = 'peak ' + Math.round(100 * c.adj.max / c.adj.h) + '% of limit';
    }
    var far = M.falseAlarmRate(c.adj.cases, r.rho, 0, r.cutDay, c.adj.h, 1000, 4242);
    $('tFar').textContent = (far * 100).toFixed(1) + '%';
    drawChart(c);

    var d = M.drivers(c), db = $('drvTbl').querySelector('tbody');
    db.innerHTML = d.map(function (g) {
      return '<tr><td>' + g.label + '</td><td class="r">' + g.n + '</td><td class="r">' + g.observed + '</td><td class="r">' + fmt1(g.expected) +
        '</td><td class="r">' + (g.oe == null ? 'n/a' : '<b style="color:' + (g.oe >= 1.5 ? '#c11d22' : '#313131') + '">' + g.oe.toFixed(2) + '</b>') + '</td></tr>';
    }).join('');
    var ok = d.filter(function (g) { return g.n >= 15 && g.oe != null; });
    var top = ok.slice().sort(function (a, b) { return b.oe - a.oe; })[0];
    var dcd = d[0], dbd = d[1];
    var note = 'Overall O/E ' + fmt2(c.oe) + '. ';
    if (c.oe != null && c.oe >= 1.3 && top) {
      note += 'The excess is highest in ' + top.label.charAt(0).toLowerCase() + top.label.slice(1) + ' (O/E ' + top.oe.toFixed(2) + '). ';
      note += (dbd.oe != null && dcd.oe != null && dbd.oe >= 1.5 && dcd.oe >= 1.5) ?
        'It shows up in both DCD and DBD grafts, so case mix does not explain it. Next step: review procurement and perfusion logs for the cases since the chart started climbing.' :
        'Compare against perfusion logs for these cases.';
    } else if (c.dcdShare >= 0.5) {
      note += 'This center takes mostly DCD livers. Its raw loss count is higher than the registry average, but in line with what its case mix predicts.';
    } else {
      note += 'No case type stands out.';
    }
    $('drvNote').textContent = note;
  }

  function drawChart(c) {
    var svg = $('chart'), W = 860, H = 300, L = 40, R = 12, T = 12, B = 30;
    var days = c.adj.path.length, view = state.view;
    var ymax = Math.max(c.adj.h, c.unadj.h, c.adj.max, view !== 'adj' ? c.unadj.max : 0) * 1.18;
    ymax = Math.ceil(ymax);
    var x = function (d) { return L + (W - L - R) * d / (days - 1); };
    var y = function (v) { return T + (H - T - B) * (1 - v / ymax); };
    var s = '';
    // grid: vertical every month, horizontal at integer steps
    var step = ymax > 6 ? 2 : 1;
    for (var v = 0; v <= ymax; v += step) {
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#e3e3e3" stroke-width="1"/>';
      s += '<text x="' + (L - 8) + '" y="' + (y(v) + 4) + '" font-size="12" text-anchor="end" fill="#333">' + v + '</text>';
    }
    for (var d = 0; d < days; d++) {
      var dt = dateOf(d);
      if (dt.getUTCDate() === 1) {
        s += '<line x1="' + x(d) + '" x2="' + x(d) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#e3e3e3"/>';
        s += '<text x="' + x(d) + '" y="' + (H - B + 18) + '" font-size="12" text-anchor="middle" fill="#333">' + dshort(d) + '</text>';
      }
    }
    s += '<text x="10" y="' + (T + (H - T - B) / 2) + '" font-size="11" fill="#333" transform="rotate(-90 10 ' + (T + (H - T - B) / 2) + ')" text-anchor="middle">CUSUM G(t)</text>';
    function line(path, color, w, dash) {
      var pts = path.map(function (g, i) { return x(i).toFixed(1) + ',' + y(g).toFixed(1); }).join(' ');
      return '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="' + w + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + ' stroke-linejoin="round"/>';
    }
    function limit(h, color) {
      return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(h) + '" y2="' + y(h) + '" stroke="' + color + '" stroke-width="1.4" stroke-dasharray="6 5"/>';
    }
    if (view !== 'adj') { s += limit(c.unadj.h, '#52a933'); s += line(c.unadj.path, '#52a933', 1.8); }
    if (view !== 'unadj') { s += limit(c.adj.h, '#d0262b'); s += line(c.adj.path, '#d0262b', 2.2); }
    function mark(sd, color, label, dy) {
      if (sd == null) return '';
      var g = (label === 'adj' ? c.adj : c.unadj).path[sd];
      return '<circle cx="' + x(sd) + '" cy="' + y(g) + '" r="5" fill="#fff" stroke="' + color + '" stroke-width="2.4"/>' +
        '<text x="' + (label === 'adj' ? x(sd) - 9 : x(sd) + 9) + '" y="' + (y(g) + dy) + '" font-size="12" font-weight="700" text-anchor="' + (label === 'adj' ? 'end' : 'start') + '" fill="' + color + '">' + (label === 'adj' ? 'Risk-adjusted signal ' : 'Unadjusted signal ') + dshort(sd) + '</text>';
    }
    if (view !== 'unadj') s += mark(c.adj.signalDay, '#d0262b', 'adj', -8);
    if (view !== 'adj') s += mark(c.unadj.signalDay, '#3e8f25', 'unadj', 24);
    s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (H - B) + '" y2="' + (H - B) + '" stroke="#999"/>';
    svg.innerHTML = s;
  }

  function renderTruth() {
    var cs = state.res.centers, out = [];
    cs.forEach(function (c) {
      if (c.truth.kind === 'drift') {
        var onset = c.truth.afterCase + 1;
        var lag = c.adjSignalCase != null ? (c.adjSignalCase - c.truth.afterCase) : null;
        out.push('<b>' + c.id + '</b>: loss odds multiplied by ' + c.truth.oddsMultiplier + ' from its case ' + onset + ' onward. Risk-adjusted chart: ' +
          (lag != null ? 'signaled at case ' + c.adjSignalCase + ', ' + lag + ' cases after the drift began.' : 'no signal yet.'));
      }
    });
    var marg = cs.filter(function (c) { return c.truth.kind === 'marginal'; });
    out.push('<b>' + marg.map(function (c) { return c.id; }).join(', ') + '</b>: in control, but take mostly DCD and older, steatotic livers. Flagged by risk-adjusted chart: ' +
      marg.filter(function (c) { return c.adj.signalDay != null; }).length + ' of ' + marg.length + '; by unadjusted chart: ' +
      marg.filter(function (c) { return c.unadj.signalDay != null; }).length + ' of ' + marg.length + '.');
    var ic = cs.filter(function (c) { return c.truth.kind === 'in-control'; });
    out.push('Other ' + ic.length + ' centers: in control. Flagged by risk-adjusted chart: ' + ic.filter(function (c) { return c.adj.signalDay != null; }).length +
      ' (budget ' + Math.round(state.alpha * 100) + '% each).');
    $('truth').innerHTML = out.join('<br>');
  }

  function seg(id, attr, key, parse) {
    $(id).addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      Array.prototype.forEach.call($(id).children, function (x) { x.classList.toggle('on', x === b); });
      state[key] = parse(b.getAttribute(attr));
      if (key === 'view') renderCenter(); else run();
    });
  }
  seg('viewSeg', 'data-v', 'view', String);
  seg('rhoSeg', 'data-r', 'rho', Number);
  seg('alphaSeg', 'data-a', 'alpha', Number);
  run();
})();
