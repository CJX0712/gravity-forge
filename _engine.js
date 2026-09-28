/* gravity-forge engine — pure JS, DOM-free, deterministic.
   Exposes globalThis.GRAV
   Barnes-Hut quadtree N-body + exact O(N^2) reference + symplectic integrators
   + conserved-quantity diagnostics + runnable invariant checks.
   Author: 晨星 */
(function (root) {
  'use strict';

  var VERSION = '1.0.0';

  // ---------- deterministic RNG ----------
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- bodies ----------
  function makeBody(x, y, vx, vy, m) {
    return { x: x, y: y, vx: vx, vy: vy, m: m, ax: 0, ay: 0 };
  }
  function cloneBodies(bs) {
    var out = new Array(bs.length);
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      out[i] = { x: b.x, y: b.y, vx: b.vx, vy: b.vy, m: b.m, ax: b.ax, ay: b.ay };
    }
    return out;
  }

  // ---------- quadtree ----------
  var LEAF_CAP = 1;
  var MAX_DEPTH = 26;

  function mkNode(cx, cy, half) {
    return {
      cx: cx, cy: cy, half: half,
      mass: 0, mx: 0.0, my: 0.0,
      items: [], kids: null
    };
  }

  function quadrant(node, x, y) {
    var q = 0;
    if (x > node.cx) q |= 1;
    if (y > node.cy) q |= 2;
    return q;
  }

  function splitNode(node, depth) {
    var h = node.half * 0.5;
    node.kids = [
      mkNode(node.cx - h, node.cy - h, h),
      mkNode(node.cx + h, node.cy - h, h),
      mkNode(node.cx - h, node.cy + h, h),
      mkNode(node.cx + h, node.cy + h, h)
    ];
    var items = node.items;
    node.items = null;
    for (var k = 0; k < items.length; k++) insertN(node, items[k], depth);
  }

  function insertN(node, i, depth) {
    var b = BODIES[i];
    if (node.kids !== null) {
      insertN(node.kids[quadrant(node, b.x, b.y)], i, depth + 1);
    } else {
      node.items.push(i);
      if (node.items.length > LEAF_CAP && depth < MAX_DEPTH) splitNode(node, depth);
    }
  }

  var BODIES = null; // insert/rebalance uses a module-scoped pointer for speed

  function buildTree(bodies) {
    var n = bodies.length;
    if (n === 0) return null;
    var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (var i = 0; i < n; i++) {
      var b = bodies[i];
      if (b.x < minx) minx = b.x;
      if (b.x > maxx) maxx = b.x;
      if (b.y < miny) miny = b.y;
      if (b.y > maxy) maxy = b.y;
    }
    var side = Math.max(maxx - minx, maxy - miny);
    if (!(side > 0)) side = 1;
    var half = side * 0.5 * 1.0000001 + 1e-9;
    var root = mkNode((minx + maxx) * 0.5, (miny + maxy) * 0.5, half);
    BODIES = bodies;
    for (var j = 0; j < n; j++) insertN(root, j, 0);
    BODIES = null;
    computeMass(root, bodies);
    return root;
  }

  function computeMass(node, bodies) {
    if (node.kids === null) {
      var m = 0, sx = 0, sy = 0;
      var items = node.items;
      for (var k = 0; k < items.length; k++) {
        var b = bodies[items[k]];
        m += b.m; sx += b.m * b.x; sy += b.m * b.y;
      }
      node.mass = m;
      if (m > 0) { node.mx = sx / m; node.my = sy / m; }
      return;
    }
    var M = 0, cx = 0, cy = 0, kids = node.kids;
    for (var q = 0; q < 4; q++) {
      computeMass(kids[q], bodies);
      var km = kids[q].mass;
      if (km > 0) { M += km; cx += km * kids[q].mx; cy += km * kids[q].my; }
    }
    node.mass = M;
    if (M > 0) { node.mx = cx / M; node.my = cy / M; }
  }

  function countNodes(node) {
    if (node === null) return 0;
    if (node.kids === null) return 1;
    var c = 1;
    for (var q = 0; q < 4; q++) c += countNodes(node.kids[q]);
    return c;
  }
  function treeDepth(node) {
    if (node === null) return 0;
    if (node.kids === null) return 1;
    var d = 0;
    for (var q = 0; q < 4; q++) { var t = treeDepth(node.kids[q]); if (t > d) d = t; }
    return 1 + d;
  }
  function leafItems(node, acc) {
    acc = acc || [];
    if (node === null) return acc;
    if (node.kids === null) { for (var k = 0; k < node.items.length; k++) acc.push(node.items[k]); return acc; }
    for (var q = 0; q < 4; q++) leafItems(node.kids[q], acc);
    return acc;
  }

  // ---------- forces ----------
  function def(o, k, d) { return (o && o[k] !== undefined) ? o[k] : d; }

  var LAST_STATS = { interactions: 0, nodes: 0, depth: 0, pairs: 0, mode: 'bh' };

  // exact O(N^2), pairwise-symmetric accumulation
  function accelerationsBF(bodies, o) {
    o = o || {};
    var G = def(o, 'G', 1), eps = def(o, 'eps', 0);
    var n = bodies.length, i, j, e2 = eps * eps, inter = 0;
    for (i = 0; i < n; i++) { bodies[i].ax = 0; bodies[i].ay = 0; }
    for (i = 0; i < n; i++) {
      var bi = bodies[i];
      for (j = i + 1; j < n; j++) {
        var bj = bodies[j];
        var dx = bj.x - bi.x, dy = bj.y - bi.y;
        var r2 = dx * dx + dy * dy + e2;
        var inv = 1 / Math.sqrt(r2);
        var f = G * inv * inv * inv;
        var fx = f * dx, fy = f * dy;
        bi.ax += fx * bj.m; bi.ay += fy * bj.m;
        bj.ax -= fx * bi.m; bj.ay -= fy * bi.m;
        inter++;
      }
    }
    LAST_STATS = { interactions: inter, nodes: 0, depth: 0, pairs: inter, mode: 'exact' };
    return LAST_STATS;
  }

  // Barnes-Hut: walk the tree per body, open a cell when s/d > theta
  function accelerationsBH(bodies, o) {
    o = o || {};
    var G = def(o, 'G', 1), theta = def(o, 'theta', 0.5), eps = def(o, 'eps', 0);
    var e2 = eps * eps, n = bodies.length, i, inter = 0;
    var root = buildTree(bodies);
    var theta2 = theta * theta;
    for (i = 0; i < n; i++) bodies[i].ax = bodies[i].ay = 0;
    var stack = [];
    for (i = 0; i < n; i++) {
      var b = bodies[i];
      var ax = 0, ay = 0;
      stack.length = 0;
      stack.push(root);
      while (stack.length > 0) {
        var node = stack.pop();
        if (node === null || node.mass === 0) continue;
        var dx = node.mx - b.x, dy = node.my - b.y;
        var d2 = dx * dx + dy * dy;
        var s = node.half * 2;
        if (node.kids !== null && s * s > theta2 * d2) {
          var kids = node.kids;
          for (var q = 0; q < 4; q++) stack.push(kids[q]);
          continue;
        }
        // treat node (leaf or far cell) as a single mass — skip self contribution for leaves
        if (node.kids === null) {
          var items = node.items;
          for (var k = 0; k < items.length; k++) {
            var idx = items[k];
            if (idx === i) continue;
            var bj = bodies[idx];
            var ddx = bj.x - b.x, ddy = bj.y - b.y;
            var rr2 = ddx * ddx + ddy * ddy + e2;
            var inv = 1 / Math.sqrt(rr2);
            var ff = G * inv * inv * inv * bj.m;
            ax += ff * ddx; ay += ff * ddy;
            inter++;
          }
        } else {
          if (d2 <= 0) {
            // coincident centre-of-mass: open regardless to stay finite
            var kk = node.kids;
            for (var qq = 0; qq < 4; qq++) stack.push(kk[qq]);
            continue;
          }
          var rr2b = d2 + e2;
          var invb = 1 / Math.sqrt(rr2b);
          var ffb = G * invb * invb * invb * node.mass;
          ax += ffb * dx; ay += ffb * dy;
          inter++;
        }
      }
      b.ax = ax; b.ay = ay;
    }
    LAST_STATS = { interactions: inter, nodes: countNodes(root), depth: treeDepth(root), pairs: n * (n - 1) / 2, mode: 'bh', root: root };
    return LAST_STATS;
  }

  function accelDispatch(mode) {
    return mode === 'exact' ? accelerationsBF : accelerationsBH;
  }

  // ---------- diagnostics ----------
  function kinetic(bodies) {
    var s = 0;
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];
      s += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy);
    }
    return s;
  }
  function potential(bodies, o) {
    o = o || {};
    var G = def(o, 'G', 1), eps = def(o, 'eps', 0), e2 = eps * eps, n = bodies.length, s = 0;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var dx = bodies[j].x - bodies[i].x, dy = bodies[j].y - bodies[i].y;
        s -= G * bodies[i].m * bodies[j].m / Math.sqrt(dx * dx + dy * dy + e2);
      }
    }
    return s;
  }
  function energy(bodies, o) { return kinetic(bodies) + potential(bodies, o); }
  function momentum(bodies) {
    var px = 0, py = 0;
    for (var i = 0; i < bodies.length; i++) { px += bodies[i].m * bodies[i].vx; py += bodies[i].m * bodies[i].vy; }
    return { x: px, y: py };
  }
  function totalMass(bodies) {
    var m = 0;
    for (var i = 0; i < bodies.length; i++) m += bodies[i].m;
    return m;
  }
  function centerOfMass(bodies) {
    var m = 0, sx = 0, sy = 0;
    for (var i = 0; i < bodies.length; i++) { m += bodies[i].m; sx += bodies[i].m * bodies[i].x; sy += bodies[i].m * bodies[i].y; }
    if (m === 0) return { x: 0, y: 0, m: 0 };
    return { x: sx / m, y: sy / m, m: m };
  }
  function angularMomentum(bodies) {
    var c = centerOfMass(bodies);
    var vcx = 0, vcy = 0;
    if (c.m > 0) {
      for (var k = 0; k < bodies.length; k++) { vcx += bodies[k].m * bodies[k].vx; vcy += bodies[k].m * bodies[k].vy; }
      vcx /= c.m; vcy /= c.m;
    }
    var L = 0;
    for (var j = 0; j < bodies.length; j++) {
      var bb = bodies[j];
      var rx = bb.x - c.x, ry = bb.y - c.y;
      L += bb.m * (rx * (bb.vy - vcy) - ry * (bb.vx - vcx));
    }
    return L;
  }
  function virialRatio(bodies, o) { return 2 * kinetic(bodies) / Math.abs(potential(bodies, o) + 1e-300); }

  // ---------- integrators ----------
  function initAccel(bodies, o) {
    accelDispatch(def(o, 'mode', 'bh'))(bodies, o);
    for (var i = 0; i < bodies.length; i++) bodies[i]._a = true;
  }

  function stepVerlet2(bodies, dt, o) {
    var acc = accelDispatch(def(o, 'mode', 'bh'));
    var n = bodies.length, i;
    if (n > 0 && bodies[0]._a !== true) acc(bodies, o);
    var px = new Float64Array(n), py = new Float64Array(n);
    for (i = 0; i < n; i++) { px[i] = bodies[i].ax; py[i] = bodies[i].ay; }
    var hdt2 = 0.5 * dt * dt;
    for (i = 0; i < n; i++) {
      var b = bodies[i];
      b.x += b.vx * dt + px[i] * hdt2;
      b.y += b.vy * dt + py[i] * hdt2;
    }
    acc(bodies, o);
    var hdt = 0.5 * dt;
    for (i = 0; i < n; i++) {
      var bb = bodies[i];
      bb.vx += (px[i] + bb.ax) * hdt;
      bb.vy += (py[i] + bb.ay) * hdt;
    }
    if (n > 0) bodies[0]._a = true;
  }

  function stepEuler(bodies, dt, o) {
    var acc = accelDispatch(def(o, 'mode', 'bh'));
    acc(bodies, o);
    var n = bodies.length;
    var vx = new Float64Array(n), vy = new Float64Array(n);
    for (var i = 0; i < n; i++) { vx[i] = bodies[i].ax * dt; vy[i] = bodies[i].ay * dt; }
    for (i = 0; i < n; i++) {
      var b = bodies[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.vx += vx[i]; b.vy += vy[i];
    }
  }

  function stepRK4(bodies, dt, o) {
    var acc = accelDispatch(def(o, 'mode', 'bh'));
    var G = def(o, 'G', 1), eps = def(o, 'eps', 0), th = def(o, 'theta', 0.5);
    var mode = def(o, 'mode', 'bh');
    var n = bodies.length, i;
    var x0 = new Float64Array(n), y0 = new Float64Array(n), vx0 = new Float64Array(n), vy0 = new Float64Array(n);
    for (i = 0; i < n; i++) { var b = bodies[i]; x0[i] = b.x; y0[i] = b.y; vx0[i] = b.vx; vy0[i] = b.vy; }

    function setAll(fx, fy, fvx, fvy) {
      for (var k = 0; k < n; k++) {
        var bb = bodies[k];
        bb.x = x0[k] + fx[k]; bb.y = y0[k] + fy[k];
        bb.vx = vx0[k] + fvx[k]; bb.vy = vy0[k] + fvy[k];
      }
    }
    function deriv(outax, outay) {
      var st = acc(bodies, { G: G, eps: eps, theta: th, mode: mode });
      for (var k = 0; k < n; k++) { outax[k] = bodies[k].ax; outay[k] = bodies[k].ay; }
      return st;
    }
    var k1ax = new Float64Array(n), k1ay = new Float64Array(n), k1vx = new Float64Array(n), k1vy = new Float64Array(n);
    var t2 = new Float64Array(n);
    for (i = 0; i < n; i++) { k1vx[i] = bodies[i].vx; k1vy[i] = bodies[i].vy; }
    deriv(k1ax, k1ay);
    for (i = 0; i < n; i++) { t2[i] = 0; }
    for (i = 0; i < n; i++) { bodies[i].x = x0[i]; bodies[i].y = y0[i]; bodies[i].vx = vx0[i]; bodies[i].vy = vy0[i]; }

    var k2ax = new Float64Array(n), k2ay = new Float64Array(n);
    var h2 = dt * 0.5;
    for (i = 0; i < n; i++) { bodies[i].x = x0[i] + k1vx[i] * h2; bodies[i].y = y0[i] + k1vy[i] * h2; bodies[i].vx = vx0[i] + k1ax[i] * h2; bodies[i].vy = vy0[i] + k1ay[i] * h2; }
    deriv(k2ax, k2ay);

    var k3ax = new Float64Array(n), k3ay = new Float64Array(n);
    for (i = 0; i < n; i++) { bodies[i].x = x0[i] + (vx0[i] + k1ax[i] * h2) * h2; bodies[i].y = y0[i] + (vy0[i] + k1ay[i] * h2) * h2; bodies[i].vx = vx0[i] + k2ax[i] * h2; bodies[i].vy = vy0[i] + k2ay[i] * h2; }
    deriv(k3ax, k3ay);

    var k4ax = new Float64Array(n), k4ay = new Float64Array(n);
    for (i = 0; i < n; i++) { bodies[i].x = x0[i] + (vx0[i] + k2ax[i] * h2) * dt; bodies[i].y = y0[i] + (vy0[i] + k2ay[i] * h2) * dt; bodies[i].vx = vx0[i] + k3ax[i] * dt; bodies[i].vy = vy0[i] + k3ay[i] * dt; }
    deriv(k4ax, k4ay);

    var s6 = dt / 6;
    for (i = 0; i < n; i++) {
      bodies[i].x = x0[i] + s6 * (k1vx[i] + 2 * (vx0[i] + k1ax[i] * h2) + 2 * (vx0[i] + k2ax[i] * h2) + (vx0[i] + k3ax[i] * dt));
      bodies[i].y = y0[i] + s6 * (k1vy[i] + 2 * (vy0[i] + k1ay[i] * h2) + 2 * (vy0[i] + k2ay[i] * h2) + (vy0[i] + k3ay[i] * dt));
      bodies[i].vx = vx0[i] + s6 * (k1ax[i] + 2 * k2ax[i] + 2 * k3ax[i] + k4ax[i]);
      bodies[i].vy = vy0[i] + s6 * (k1ay[i] + 2 * k2ay[i] + 2 * k3ay[i] + k4ay[i]);
    }
    initAccel(bodies, o);
  }

  var INTEGRATORS = { verlet: stepVerlet2, euler: stepEuler, rk4: stepRK4 };

  function stepper(name) { return INTEGRATORS[name] || stepVerlet2; }

  function run(bodies, T, dt, o) {
    var step = stepper(def(o, 'integrator', 'verlet'));
    var steps = Math.max(0, Math.round(T / dt));
    var trail = [];
    for (var s = 0; s < steps; s++) {
      step(bodies, dt, o);
      if (o && o.sample) trail.push(o.sample(bodies, s * dt));
    }
    return trail;
  }

  // ---------- initial conditions ----------
  // two equal masses m separated by r on the x axis, circular orbit about the COM
  function binaryIC(o) {
    o = o || {};
    var G = def(o, 'G', 1), m = def(o, 'm', 1), r = def(o, 'r', 1);
    var half = r * 0.5;
    var v = Math.sqrt(G * m / (2 * r)); // each body: omega = sqrt(2Gm/r^3), radius r/2
    return [
      makeBody(-half, 0, 0, v, m),
      makeBody(half, 0, 0, -v, m)
    ];
  }
  function binaryPeriod(o) {
    o = o || {};
    var G = def(o, 'G', 1), m = def(o, 'm', 1), r = def(o, 'r', 1);
    return 2 * Math.PI * Math.sqrt(r * r * r / (2 * G * m));
  }
  // Chenciner-Montgomery figure-eight three-body choreography (G=1, m=1 all)
  function figureEightIC() {
    var vx = 0.4662036850, vy = 0.4323657300;
    return [
      makeBody(0.97000436, -0.24308753, vx, vy, 1),
      makeBody(-0.97000436, 0.24308753, vx, vy, 1),
      makeBody(0, 0, -2 * vx, -2 * vy, 1)
    ];
  }
  var FIGURE_EIGHT_PERIOD = 6.32591398;

  // rotating disk cluster
  function diskIC(o) {
    o = o || {};
    var n = def(o, 'n', 200), seed = def(o, 'seed', 42), R = def(o, 'R', 1), Mstar = def(o, 'Mstar', 0);
    var rnd = mulberry32(seed);
    var bs = [];
    var Mtot = 0;
    for (var i = 0; i < n; i++) {
      var rad = R * Math.sqrt(rnd()) + 1e-6;
      var ang = rnd() * Math.PI * 2;
      var m = 1 / n;
      Mtot += m;
      var enc = Mstar + Mtot; // enclosed mass (rough)
      var v = Math.sqrt(enc / rad) * (0.85 + 0.3 * rnd());
      bs.push(makeBody(rad * Math.cos(ang), rad * Math.sin(ang), -v * Math.sin(ang), v * Math.cos(ang), m));
    }
    if (Mstar > 0) bs.unshift(makeBody(0, 0, 0, 0, Mstar));
    // zero net momentum
    var p = momentum(bs), tm = totalMass(bs);
    for (var k = 0; k < bs.length; k++) { bs[k].vx -= p.x / tm; bs[k].vy -= p.y / tm; }
    return bs;
  }
  // two clusters flying past each other (collision test)
  function collideIC(o) {
    o = o || {};
    var n = def(o, 'n', 120), seed = def(o, 'seed', 7), sep = def(o, 'sep', 1.5);
    var a = diskIC({ n: Math.floor(n / 2), seed: seed, R: 0.5, Mstar: 0.4 });
    var b = diskIC({ n: n - Math.floor(n / 2), seed: seed + 1, R: 0.5, Mstar: 0.4 });
    for (var i = 0; i < a.length; i++) { a[i].x -= sep; a[i].vx += 0.35; }
    for (var j = 0; j < b.length; j++) { b[j].x += sep; b[j].vx -= 0.35; }
    var all = a.concat(b);
    var p = momentum(all), tm = totalMass(all);
    for (var k = 0; k < all.length; k++) { all[k].vx -= p.x / tm; all[k].vy -= p.y / tm; }
    return all;
  }
  // toy 'solar system': dominant central mass + coplanar circular orbiters
  function solarIC(o) {
    o = o || {};
    var k = def(o, 'planets', 6), G = def(o, 'G', 1), M = def(o, 'M', 200);
    var bs = [makeBody(0, 0, 0, 0, M)];
    for (var i = 0; i < k; i++) {
      var r = 0.25 + 0.22 * i;
      var v = Math.sqrt(G * M / r);
      var a = i * 1.7;
      bs.push(makeBody(r * Math.cos(a), r * Math.sin(a), -v * Math.sin(a), v * Math.cos(a), 0.05));
    }
    var p = momentum(bs), tm = totalMass(bs);
    for (var q = 0; q < bs.length; q++) { bs[q].vx -= p.x / tm; bs[q].vy -= p.y / tm; }
    return bs;
  }

  // ---------- invariant checks (also used by the browser self-test panel) ----------
  function rmseRel(aRef, aBH) {
    var num = 0, den = 0, mx = 0, mxDen = 0;
    for (var i = 0; i < aRef.length; i++) {
      var rx = aRef[i].x, ry = aRef[i].y, bx = aBH[i].x, by = aBH[i].y;
      var dr = (bx - rx) * (bx - rx) + (by - ry) * (by - ry);
      num += dr; den += rx * rx + ry * ry;
      var nrm = Math.sqrt(rx * rx + ry * ry);
      var rel = Math.sqrt(dr) / (nrm > 1e-12 ? nrm : 1e-12);
      var scale = Math.max(1, nrm);
      if (rel > mx) mx = rel;
      if (rel > mxDen) mxDen = rel;
    }
    return { rms: Math.sqrt(num / (den || 1)), max: mx, maxScaled: mxDen };
  }
  function accSnapshot(bodies) {
    var out = new Array(bodies.length);
    for (var i = 0; i < bodies.length; i++) out[i] = { x: bodies[i].ax, y: bodies[i].ay };
    return out;
  }

  function checkTreeVsBrute(bs, o) {
    var A = cloneBodies(bs);
    accelerationsBF(A, o);
    var ref = accSnapshot(A);
    var out = {};
    ['0.0', '0.2', '0.5', '0.8'].forEach(function (t) {
      var B = cloneBodies(bs);
      var st = accelerationsBH(B, { G: o.G, eps: o.eps, theta: parseFloat(t) });
      out[t] = rmseRel(ref, accSnapshot(B));
      out[t].interactions = st.interactions;
    });
    return { ref: ref, byTheta: out };
  }

  function maxDrift(integrator, o, dt, T, n, seedv) {
    var bs = diskIC({ n: n, seed: seedv, R: 1 });
    initAccel(bs, o);
    var E0 = energy(bs, o);
    var stp = stepper(integrator);
    var worst = 0, steps = Math.round(T / dt);
    for (var i = 0; i < steps; i++) {
      stp(bs, dt, o);
      worst = Math.max(worst, Math.abs((energy(bs, o) - E0) / E0));
    }
    return worst;
  }

  function runChecks(opts) {
    opts = opts || {};
    var checks = [];
    function add(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail }); }

    var G = 1;

    // ---------- tree structure ----------
    var cluster = diskIC({ n: 220, seed: 42, R: 1 });

    var tree = buildTree(cluster);
    var tm = totalMass(cluster);
    add('四叉树总质量 == 所有质点质量之和', Math.abs(tree.mass - tm) < 1e-12 * Math.max(1, tm),
      'Δ=' + Math.abs(tree.mass - tm).toExponential(2));

    var c1 = centerOfMass(cluster);
    var dcom = Math.hypot(tree.mx - c1.x, tree.my - c1.y);
    var items = leafItems(tree, []);
    var seen = {}, dup = false;
    for (var qi = 0; qi < items.length; qi++) { if (seen[items[qi]] !== undefined) dup = true; seen[items[qi]] = 1; }
    add('每体恰好属于一个叶节点 & 树质心 == 直接计算',
      dcom < 1e-12 && !dup && items.length === cluster.length,
      'Δcom=' + dcom.toExponential(2) + '，叶元 ' + items.length + '/' + cluster.length + '，重复=' + dup);

    // ---------- BH vs exact ----------
    var tv = checkTreeVsBrute(cluster, { G: G, eps: 0.05 });
    add('θ=0 时 BH 退化为精确两两求和', tv.byTheta['0.0'].max < 1e-12,
      'max rel err=' + tv.byTheta['0.0'].max.toExponential(2));

    var e2 = tv.byTheta['0.2'].rms, e5 = tv.byTheta['0.5'].rms, e8 = tv.byTheta['0.8'].rms;
    add('BH 误差随 θ 单调增大，θ=0.5 时 rms < 5%', e2 < e5 && e5 < e8 && e5 < 0.05,
      'rms θ=0.2/0.5/0.8 → ' + e2.toExponential(2) + ' / ' + e5.toExponential(2) + ' / ' + e8.toExponential(2));

    // ---------- cost / scaling ----------
    var bigA = diskIC({ n: 1000, seed: 3, R: 1 });
    var stA = accelerationsBH(bigA, { G: G, eps: 0.05, theta: 0.5 });
    var pairsA = 1000 * 999 / 2;
    var bigB = diskIC({ n: 4000, seed: 3, R: 1 });
    var stB = accelerationsBH(bigB, { G: G, eps: 0.05, theta: 0.5 });
    var perA = stA.interactions / 1000, perB = stB.interactions / 4000;
    add('N=1000 时 BH 交互数 < 精确法的 25%',
      stA.interactions < 0.25 * pairsA,
      'BH=' + stA.interactions + ' vs 精确=' + pairsA + '（' + (100 * stA.interactions / pairsA).toFixed(1) + '%）');
    add('每体交互数亚线性增长（O(log N) 而非 O(N)）',
      perB / perA < 0.6 * (4000 / 1000),
      'per-body 1000→4000：' + perA.toFixed(1) + ' → ' + perB.toFixed(1) + '（×' + (perB / perA).toFixed(2) + '，N 增 4 倍）');

    // ---------- conservation laws (pairwise-symmetric mode) ----------
    var sym = diskIC({ n: 80, seed: 11, R: 1 });
    var oEx = { G: G, eps: 0.05, mode: 'exact' };
    initAccel(sym, oEx);
    var p0 = momentum(sym), L0 = angularMomentum(sym);
    for (var s6 = 0; s6 < 400; s6++) stepVerlet2(sym, 0.005, oEx);
    var p1 = momentum(sym), L1 = angularMomentum(sym);
    var dp = Math.hypot(p1.x - p0.x, p1.y - p0.y), dL = Math.abs(L1 - L0);
    add('动量守恒（精确模式，400 步 Verlet）', dp < 1e-12, '|Δp|=' + dp.toExponential(2));
    add('角动量守恒（精确模式，400 步 Verlet）', dL < 1e-9 * Math.max(1, Math.abs(L0)),
      'ΔL=' + dL.toExponential(2) + '，L₀=' + L0.toExponential(3));

    // ---------- integrator order (exact mode isolates the integrator) ----------
    var dV1 = maxDrift('verlet', oEx, 0.01, 2, 40, 5);
    var dV2 = maxDrift('verlet', oEx, 0.005, 2, 40, 5);
    var ratioV = dV1 / dV2;
    add('Verlet 能量误差二阶收敛（dt 减半 → 误差 /4）', ratioV > 3 && ratioV < 5,
      'ratio=' + ratioV.toFixed(2) + '（' + dV1.toExponential(2) + ' → ' + dV2.toExponential(2) + '）');

    var dE1 = maxDrift('euler', oEx, 0.01, 2, 40, 5);
    var dE2 = maxDrift('euler', oEx, 0.005, 2, 40, 5);
    var ratioE = dE1 / dE2;
    add('Euler 能量误差一阶收敛，且远大于 Verlet', ratioE > 1.4 && ratioE < 2.6 && dE1 > 100 * dV1,
      'ratio=' + ratioE.toFixed(2) + '；Euler=' + dE1.toExponential(2) + ' vs Verlet=' + dV1.toExponential(2));

    // ---------- BH approximation floor: independent of dt ----------
    var oBHc = { G: G, eps: 0.05, mode: 'bh', theta: 0.5 };
    var dB1 = maxDrift('verlet', oBHc, 0.005, 2, 40, 5);
    var dB2 = maxDrift('verlet', oBHc, 0.0025, 2, 40, 5);
    var ratioB = dB1 / dB2;
    add('BH 模式存在与 dt 无关的 θ 误差地板',
      ratioB > 0.6 && ratioB < 1.7 && dB1 > 2 * dV2,
      'dt 减半误差比为 ' + ratioB.toFixed(2) + '（≈1 即不随 dt 收敛）；BH=' + dB1.toExponential(2) + ' vs 精确=' + dV2.toExponential(2));

    // ---------- symplectic time reversibility ----------
    var rev = diskIC({ n: 50, seed: 3, R: 1 });
    var oR = { G: G, eps: 0.05, mode: 'bh', theta: 0.5 };
    initAccel(rev, oR);
    var snaps = [];
    for (var r0 = 0; r0 < rev.length; r0++) snaps.push({ x: rev[r0].x, y: rev[r0].y, vx: rev[r0].vx, vy: rev[r0].vy });
    for (var f = 0; f < 300; f++) stepVerlet2(rev, 0.005, oR);
    for (var b8 = 0; b8 < 300; b8++) stepVerlet2(rev, -0.005, oR);
    var mrev = 0, mvrev = 0;
    for (var r9 = 0; r9 < rev.length; r9++) {
      mrev = Math.max(mrev, Math.hypot(rev[r9].x - snaps[r9].x, rev[r9].y - snaps[r9].y));
      mvrev = Math.max(mvrev, Math.hypot(rev[r9].vx - snaps[r9].vx, rev[r9].vy - snaps[r9].vy));
    }
    add('Verlet 时间可逆（前进 300 步 + 后退 300 步）', mrev < 1e-9 && mvrev < 1e-9,
      'max 位置误差=' + mrev.toExponential(2) + '，速度误差=' + mvrev.toExponential(2));

    // ---------- analytic two-body orbit ----------
    var bin = binaryIC({ G: 1, m: 1, r: 1 });
    var oBin = { G: 1, eps: 0, mode: 'exact' };
    initAccel(bin, oBin);
    var Tp = binaryPeriod({ G: 1, m: 1, r: 1 });
    var stepsB = 4443;
    var dtB = Tp / stepsB;                 // integrate exactly one period
    var rMin = Infinity, rMax = 0;
    for (var b9 = 0; b9 < stepsB; b9++) {
      stepVerlet2(bin, dtB, oBin);
      var rr = Math.hypot(bin[0].x, bin[0].y);
      if (rr < rMin) rMin = rr;
      if (rr > rMax) rMax = rr;
    }
    var backErr = Math.hypot(bin[0].x - (-0.5), bin[0].y - 0) / 0.5;
    add('二体圆轨道：积分一个解析周期后回到初态', backErr < 1e-3,
      'T=2π√(r³/2Gm)=' + Tp.toFixed(6) + '，位置误差=' + backErr.toExponential(2));
    add('二体圆轨道半径恒定（偏心率 = 0）', (rMax - rMin) / 0.5 < 1e-4,
      'Δr/r=' + ((rMax - rMin) / 0.5).toExponential(2));

    // ---------- figure-eight choreography ----------
    var f8 = figureEightIC();
    var oF = { G: 1, eps: 0, mode: 'bh', theta: 0.5 };
    initAccel(f8, oF);
    var f8start = [];
    for (var f0 = 0; f0 < f8.length; f0++) f8start.push({ x: f8[f0].x, y: f8[f0].y, vx: f8[f0].vx, vy: f8[f0].vy });
    var nF = Math.round(FIGURE_EIGHT_PERIOD / 2e-4);
    var dtF = FIGURE_EIGHT_PERIOD / nF;
    var f8max = 0;
    for (var f1 = 0; f1 < nF; f1++) {
      stepVerlet2(f8, dtF, oF);
      for (var f2 = 0; f2 < f8.length; f2++) {
        f8max = Math.max(f8max, Math.hypot(f8[f2].x - f8start[f2].x, f8[f2].y - f8start[f2].y));
      }
    }
    var f8close = Math.hypot(f8[0].x - f8start[0].x, f8[0].y - f8start[0].y);
    add('三体 8 字轨道：一周期后闭合', f8close < 5e-3 && f8max < 4,
      '闭合误差=' + f8close.toExponential(2) + '，过程中最大偏移=' + f8max.toFixed(3) + '（T=' + FIGURE_EIGHT_PERIOD + '）');

    // ---------- determinism ----------
    function roll(seedv) {
      var bs3 = diskIC({ n: 40, seed: seedv, R: 1 });
      var oD = { G: 1, eps: 0.05, mode: 'bh', theta: 0.5 };
      initAccel(bs3, oD);
      for (var d1 = 0; d1 < 100; d1++) stepVerlet2(bs3, 0.01, oD);
      return energy(bs3, oD);
    }
    var eA = roll(9), eB = roll(9);
    add('确定性：同种子逐位一致', eA === eB, 'E=' + eA.toFixed(15));

    // ---------- softening ----------
    var closePair = [makeBody(0, 0, 0, 0, 1), makeBody(1e-12, 0, 0, 0, 1)];
    accelerationsBF(closePair, { G: 1, eps: 0.05 });
    var finiteOk = isFinite(closePair[0].ax) && Math.abs(closePair[0].ax) < 1 / (0.05 * 0.05);
    add('软化半径内力有限（r→0 不发散）', finiteOk,
      '|a|=' + Math.abs(closePair[0].ax).toExponential(2) + ' < 1/ε²=' + (1 / 0.0025).toExponential(2));

    return checks;
  }

  var API = {
    VERSION: VERSION,
    mulberry32: mulberry32,
    makeBody: makeBody,
    cloneBodies: cloneBodies,
    buildTree: buildTree,
    countNodes: countNodes,
    treeDepth: treeDepth,
    leafItems: leafItems,
    accelerationsBF: accelerationsBF,
    accelerationsBH: accelerationsBH,
    accelDispatch: accelDispatch,
    lastStats: function () { return LAST_STATS; },
    initAccel: initAccel,
    step: stepVerlet2,
    stepVerlet: stepVerlet2,
    stepEuler: stepEuler,
    stepRK4: stepRK4,
    stepper: stepper,
    run: run,
    kinetic: kinetic,
    potential: potential,
    energy: energy,
    momentum: momentum,
    totalMass: totalMass,
    centerOfMass: centerOfMass,
    angularMomentum: angularMomentum,
    virialRatio: virialRatio,
    binaryIC: binaryIC,
    binaryPeriod: binaryPeriod,
    figureEightIC: figureEightIC,
    FIGURE_EIGHT_PERIOD: FIGURE_EIGHT_PERIOD,
    diskIC: diskIC,
    collideIC: collideIC,
    solarIC: solarIC,
    runChecks: runChecks,
    rmseRel: rmseRel,
    accSnapshot: accSnapshot,
    checkTreeVsBrute: checkTreeVsBrute
  };

  root.GRAV = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
