/* gravity-forge UI — canvas renderer + controls + self-check panel.
   Requires globalThis.GRAV (engine). No-ops outside a browser. */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var G0 = (typeof globalThis !== 'undefined' ? globalThis : window).GRAV;
  if (!G0) return;

  // ---------- dom helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }

  // ---------- state ----------
  var state = {
    bodies: [],
    G: 1, eps: 0.05, theta: 0.5, dt: 0.004,
    mode: 'bh', integrator: 'verlet',
    playing: true, stepsPerFrame: 2,
    t: 0, steps: 0,
    E0: 0, p0: 0,
    showTree: false, trails: true, showChart: true,
    view: { cx: 0, cy: 0, scale: 120 },   // world->screen
    fps: 0,
    eHist: [],                             // {t, drift, ke, pe}
    preset: 'figure8'
  };

  var PRESETS = {
    figure8: {
      label: '三体 8 字轨道', make: function () {
        return { bodies: G0.figureEightIC(), eps: 0, dt: 0.001, theta: 0.5, mode: 'bh', stepsPerFrame: 3, scale: 150 };
      }
    },
    binary: {
      label: '双星圆轨道', make: function () {
        return { bodies: G0.binaryIC({ G: 1, m: 1, r: 1 }), eps: 0, dt: 0.002, theta: 0.5, mode: 'exact', stepsPerFrame: 2, scale: 130 };
      }
    },
    disk: {
      label: '旋转星系盘', make: function () {
        var n = clampInt($('nslider') ? +$('nslider').value : 400, 50, 3000);
        return { bodies: G0.diskIC({ n: n, seed: 42, R: 1 }), eps: 0.05, dt: 0.004, theta: 0.6, mode: 'bh', stepsPerFrame: 2, scale: 110 };
      }
    },
    collide: {
      label: '星系对撞', make: function () {
        var n = clampInt($('nslider') ? +$('nslider').value : 300, 50, 3000);
        return { bodies: G0.collideIC({ n: n, seed: 7, sep: 1.6 }), eps: 0.05, dt: 0.004, theta: 0.6, mode: 'bh', stepsPerFrame: 2, scale: 80 };
      }
    },
    solar: {
      label: '迷你太阳系', make: function () {
        return { bodies: G0.solarIC({ planets: 6, G: 1, M: 200 }), eps: 0.01, dt: 0.001, theta: 0.5, mode: 'bh', stepsPerFrame: 2, scale: 95 };
      }
    }
  };
  function clampInt(v, a, b) { v = Math.round(v); return v < a ? a : (v > b ? b : v); }

  // ---------- view transform ----------
  function w2sX(x) { return (x - state.view.cx) * state.view.scale + cv.width / 2; }
  function w2sY(y) { return (y - state.view.cy) * state.view.scale + cv.height / 2; }
  function s2wX(px) { return (px - cv.width / 2) / state.view.scale + state.view.cx; }
  function s2wY(py) { return (py - cv.height / 2) / state.view.scale + state.view.cy; }

  var cv = $('cv');
  var ctx = cv.getContext('2d');
  var chart = $('echart');
  var cctx = chart ? chart.getContext('2d') : null;

  function fitView(animated) {
    var bs = state.bodies;
    if (!bs.length) return;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < bs.length; i++) {
      if (bs[i].x < minx) minx = bs[i].x;
      if (bs[i].x > maxx) maxx = bs[i].x;
      if (bs[i].y < miny) miny = bs[i].y;
      if (bs[i].y > maxy) maxy = bs[i].y;
    }
    var cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
    var span = Math.max(maxx - minx, maxy - miny, 1e-6);
    var scale = Math.min(cv.width, cv.height) / (span * 1.25);
    if (animated !== false) {
      state.view.cx += (cx - state.view.cx) * 0.12;
      state.view.cy += (cy - state.view.cy) * 0.12;
      state.view.scale += (scale - state.view.scale) * 0.12;
    } else {
      state.view.cx = cx; state.view.cy = cy; state.view.scale = scale;
    }
  }

  // ---------- physics ----------
  function currentOpts() {
    return { G: state.G, eps: state.eps, theta: state.theta, mode: state.mode };
  }
  function loadPreset(name) {
    var p = PRESETS[name];
    if (!p) return;
    var cfg = p.make();
    state.preset = name;
    state.bodies = cfg.bodies;
    state.eps = cfg.eps !== undefined ? cfg.eps : state.eps;
    state.dt = cfg.dt || state.dt;
    state.theta = cfg.theta || state.theta;
    state.mode = cfg.mode || state.mode;
    state.stepsPerFrame = cfg.stepsPerFrame || 2;
    state.view.scale = cfg.scale || 110;
    state.view.cx = 0; state.view.cy = 0;
    state.t = 0; state.steps = 0;
    state.eHist = [];
    syncControls();
    G0.initAccel(state.bodies, currentOpts());
    state.E0 = G0.energy(state.bodies, currentOpts());
    var pm = G0.momentum(state.bodies);
    state.p0 = Math.hypot(pm.x, pm.y);
    if (state.trails === false || true) clearCanvas();
  }
  function reset() { loadPreset(state.preset); }
  function stepOnce(k) {
    var stp = G0.stepper(state.integrator);
    var o = currentOpts();
    var kk = k || 1;
    for (var i = 0; i < kk; i++) { stp(state.bodies, state.dt, o); state.t += state.dt; state.steps++; }
  }

  // ---------- drawing ----------
  var BODY_COLORS = ['#2456d6', '#c23a3a', '#14834b', '#b97a12', '#7a3fd1', '#0f7f8f'];
  function clearCanvas() {
    ctx.clearRect(0, 0, cv.width, cv.height);
  }
  function fadeCanvas() {
    ctx.fillStyle = 'rgba(247,249,252,0.28)';
    ctx.fillRect(0, 0, cv.width, cv.height);
  }
  function drawTree(node, depth) {
    if (!node) return;
    if (depth > 8) return;
    var x = w2sX(node.cx - node.half), y = w2sY(node.cy - node.half);
    var s = node.half * 2 * state.view.scale;
    ctx.strokeStyle = 'rgba(36,86,214,' + (0.05 + 0.05 / (1 + depth)) + ')';
    ctx.strokeRect(x, y, s, s);
    if (node.kids) {
      for (var q = 0; q < 4; q++) drawTree(node.kids[q], depth + 1);
    }
  }
  function render() {
    if (state.trails) fadeCanvas(); else clearCanvas();
    if (state.showTree && state.mode === 'bh') {
      var st = G0.lastStats();
      if (st.root) drawTree(st.root, 0);
    }
    var bs = state.bodies;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var px = w2sX(b.x), py = w2sY(b.y);
      if (px < -30 || px > cv.width + 30 || py < -30 || py > cv.height + 30) continue;
      var r = Math.max(1.2, 2.6 * Math.cbrt(b.m) * Math.pow(state.view.scale / 120, 0.35));
      ctx.beginPath();
      ctx.arc(px, py, Math.min(9, r), 0, 6.283185307179586);
      ctx.fillStyle = BODY_COLORS[i % BODY_COLORS.length];
      ctx.fill();
      if (bs.length <= 8) {
        ctx.fillStyle = '#1c2330';
        ctx.font = '10px Consolas, monospace';
        ctx.fillText('#' + (i + 1), px + 6, py - 6);
      }
    }
  }

  // ---------- energy chart ----------
  function drawChart() {
    if (!cctx) return;
    var w = chart.width, h = chart.height;
    cctx.clearRect(0, 0, w, h);
    var H = state.eHist;
    if (H.length < 2) return;
    var t0 = H[0].t, t1 = Math.max(H[H.length - 1].t, t0 + 1e-9);
    var mAbs = 0;
    for (var i = 0; i < H.length; i++) {
      mAbs = Math.max(mAbs, Math.abs(H[i].drift), Math.abs(H[i].ke), Math.abs(H[i].pe));
    }
    if (mAbs <= 0) mAbs = 1;
    var mid = h * 0.55, amp = h * 0.38;
    function line(getter, color) {
      cctx.beginPath();
      for (var j = 0; j < H.length; j++) {
        var x = (H[j].t - t0) / (t1 - t0) * w;
        var y = mid - getter(H[j]) / mAbs * amp;
        if (j === 0) cctx.moveTo(x, y); else cctx.lineTo(x, y);
      }
      cctx.strokeStyle = color;
      cctx.lineWidth = 1.2;
      cctx.stroke();
    }
    line(function (p) { return p.ke; }, '#2456d6');
    line(function (p) { return p.pe; }, '#c23a3a');
    line(function (p) { return p.drift * 0 + p.drift; }, '#14834b');
    cctx.fillStyle = '#6b7686';
    cctx.font = '10px Consolas, monospace';
    cctx.fillText('KE', 4, 12); cctx.fillStyle = '#2456d6'; cctx.fillText('—', 20, 12);
    cctx.fillStyle = '#6b7686'; cctx.fillText('PE', 34, 12); cctx.fillStyle = '#c23a3a'; cctx.fillText('—', 50, 12);
    cctx.fillStyle = '#6b7686'; cctx.fillText('漂移', 64, 12); cctx.fillStyle = '#14834b'; cctx.fillText('—', 86, 12);
  }

  // ---------- stats ----------
  var frameNo = 0;
  function paintStats() {
    var o = currentOpts();
    var st = G0.lastStats();
    var E = G0.energy(state.bodies, o);
    var KE = G0.kinetic(state.bodies);
    var drift = state.E0 !== 0 ? (E - state.E0) / Math.abs(state.E0) : 0;
    var pm = G0.momentum(state.bodies);
    var pmag = Math.hypot(pm.x, pm.y);
    var dp = state.p0 > 1e-9 ? Math.abs(pmag - state.p0) / state.p0 : pmag; // 净动量≈0 的场景用绝对值
    var L = G0.angularMomentum(state.bodies);
    var inter = st.interactions || 0, pairs = st.pairs || 1;
    setStat('s-t', state.t.toFixed(2));
    setStat('s-steps', String(state.steps));
    setStat('s-e', E.toFixed(4));
    setStat('s-drift', fmtExp(drift), drift > 0.05 ? 'bad' : (drift > 0.005 ? 'warn' : ''));
    setStat('s-p', fmtExp(dp), dp > 0.01 ? 'warn' : '');
    setStat('s-l', L.toExponential(2));
    setStat('s-bh', inter + ' / ' + pairs, '', (100 * inter / pairs).toFixed(0) + '%');
    setStat('s-tree', st.mode === 'bh' ? (st.nodes + '节点 · 深' + st.depth) : '精确 O(N²)');
    setStat('s-fps', state.fps.toFixed(0));
    setStat('s-virial', G0.virialRatio(state.bodies, o).toFixed(2));
    setStat('s-n', String(state.bodies.length));
    frameNo++;
    if (frameNo % 8 === 0) {
      var o2 = currentOpts();
      state.eHist.push({ t: state.t, drift: drift, ke: KE, pe: E - KE });
      if (state.eHist.length > 600) state.eHist.shift();
      drawChart();
    }
  }
  function setStat(id, v, cls, suffix) {
    var e = $(id);
    if (!e) return;
    e.textContent = suffix ? (v + (suffix ? ' · ' + suffix : '')) : v;
    e.className = 'v' + (cls ? ' ' + cls : '');
  }
  function fmtExp(x) {
    if (Math.abs(x) < 1e-14) return '0';
    return x.toExponential(1);
  }

  // ---------- loop ----------
  var frames = 0, fpsT = Date.now();
  function frame() {
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    var rect = cv.getBoundingClientRect();
    var W = Math.round(rect.width * dpr), H = Math.round(rect.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; clearCanvas(); }

    if (state.playing) stepOnce(state.stepsPerFrame);
    render();
    paintStats();

    frames++;
    var now = Date.now();
    if (now - fpsT > 500) { state.fps = frames * 1000 / (now - fpsT); frames = 0; fpsT = now; }
    if (state.playing) fitView(true);
    requestAnimationFrame(frame);
  }

  // ---------- interaction ----------
  var dragging = false, lastPX = 0, lastPY = 0;
  cv.addEventListener('pointerdown', function (e) {
    dragging = true; lastPX = e.clientX; lastPY = e.clientY;
  });
  cv.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dpr = window.devicePixelRatio || 1;
    state.view.cx -= (e.clientX - lastPX) / state.view.scale;
    state.view.cy -= (e.clientY - lastPY) / state.view.scale;
    lastPX = e.clientX; lastPY = e.clientY;
  });
  window.addEventListener('pointerup', function () { dragging = false; });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = cv.getBoundingClientRect();
    var mx = (e.clientX - rect.left) * (window.devicePixelRatio || 1);
    var my = (e.clientY - rect.top) * (window.devicePixelRatio || 1);
    var wx = s2wX(mx), wy = s2wY(my);
    var k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    state.view.scale = Math.min(1e5, Math.max(0.5, state.view.scale * k));
    state.view.cx = wx - (mx - cv.width / 2) / state.view.scale;
    state.view.cy = wy - (my - cv.height / 2) / state.view.scale;
  }, { passive: false });

  // ---------- controls wiring ----------
  function syncControls() {
    $('preset').value = state.preset;
    $('theta').value = state.theta;
    $('thetaV').textContent = state.theta.toFixed(2);
    $('dtin').value = state.dt;
    $('dtV').textContent = state.dt.toFixed(4);
    $('eps').value = state.eps;
    $('epsV').textContent = state.eps.toFixed(3);
    $('mode').value = state.mode;
    $('integrator').value = state.integrator;
    $('spf').value = state.stepsPerFrame;
    $('spfV').textContent = String(state.stepsPerFrame);
  }
  function wire() {
    $('preset').addEventListener('change', function () { loadPreset(this.value); });
    $('theta').addEventListener('input', function () {
      state.theta = +this.value; $('thetaV').textContent = state.theta.toFixed(2);
    });
    $('dtin').addEventListener('input', function () {
      state.dt = +this.value; $('dtV').textContent = state.dt.toFixed(4);
    });
    $('eps').addEventListener('input', function () {
      state.eps = +this.value; $('epsV').textContent = state.eps.toFixed(3);
      G0.initAccel(state.bodies, currentOpts());
    });
    $('mode').addEventListener('change', function () {
      state.mode = this.value;
      for (var i = 0; i < state.bodies.length; i++) state.bodies[i]._a = false;
    });
    $('integrator').addEventListener('change', function () {
      state.integrator = this.value;
      for (var i = 0; i < state.bodies.length; i++) state.bodies[i]._a = false;
    });
    $('spf').addEventListener('input', function () {
      state.stepsPerFrame = clampInt(+this.value, 1, 40); $('spfV').textContent = String(state.stepsPerFrame);
    });
    $('nslider').addEventListener('input', function () { $('nV').textContent = this.value; });
    $('btn-play').addEventListener('click', function () {
      state.playing = !state.playing;
      this.textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
    });
    $('btn-step').addEventListener('click', function () { stepOnce(1); });
    $('btn-reset').addEventListener('click', function () { reset(); });
    $('btn-fit').addEventListener('click', function () { fitView(false); });
    $('chk-tree').addEventListener('change', function () { state.showTree = this.checked; });
    $('chk-trails').addEventListener('change', function () { state.trails = this.checked; if (!state.trails) clearCanvas(); });
    $('btn-check').addEventListener('click', runSelfCheck);
  }

  // ---------- self-check ----------
  var scRunning = false;
  function runSelfCheck() {
    if (scRunning) return;
    scRunning = true;
    var box = $('sclist');
    var badge = $('scbadge');
    box.innerHTML = '';
    badge.textContent = '运行中…';
    badge.className = 'badge';
    setTimeout(function () {
      var t0 = Date.now();
      var res;
      try { res = G0.runChecks(); }
      catch (err) {
        badge.textContent = '异常';
        badge.className = 'badge bad';
        box.appendChild(el('li', 'bad', '自检抛错：' + err.message));
        scRunning = false;
        return;
      }
      var pass = 0, ms = Date.now() - t0;
      for (var i = 0; i < res.length; i++) {
        var c = res[i];
        if (c.ok) pass++;
        var li = el('li', c.ok ? 'ok' : 'bad');
        li.appendChild(el('span', 'mark', c.ok ? '✅' : '⚠️'));
        li.appendChild(document.createTextNode(c.name));
        li.appendChild(el('span', 'det', c.detail));
        box.appendChild(li);
      }
      badge.textContent = pass + ' / ' + res.length + ' · ' + ms + 'ms';
      badge.className = 'badge ' + (pass === res.length ? 'ok' : 'bad');
      scRunning = false;
    }, 30);
  }

  // ---------- boot ----------
  function boot() {
    wire();
    loadPreset('figure8');
    state.playing = true;
    $('btn-play').textContent = '⏸ 暂停';
    requestAnimationFrame(frame);
  }

  // hooks for headless UI checks
  (typeof globalThis !== 'undefined' ? globalThis : window).__GRAVUI = {
    loadPreset: loadPreset,
    reset: reset,
    stepOnce: stepOnce,
    runSelfCheck: runSelfCheck,
    state: state,
    presets: PRESETS,
    boot: boot
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
