// _smoke.js — headless verification of the engine inside Node `vm`, against the SHIPPED index.html.
// Usage: node _smoke.js   → writes _smoke.log
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
if (!m) { console.error('engine script block not found'); process.exit(1); }
const ctx = { console, Math, TextEncoder, TextDecoder, Uint8Array, Int32Array, Int8Array, Float64Array, Float32Array, Uint8ClampedArray, Object, Array, JSON, isFinite, Infinity, Date, NaN, globalThis: {} };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(m[1], ctx, { filename: 'engine.js' });
const GRAV = ctx.GRAV;
if (!GRAV) { console.error('GRAV not exposed'); process.exit(1); }

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? '  | ' + detail : '')); }
  else { fail++; fails.push(name + (detail ? '  | ' + detail : '')); console.log('FAIL ' + name + (detail ? '  | ' + detail : '')); }
}

// ---------- A. the 17 built-in invariant checks (same source as the browser panel) ----------
const checks = GRAV.runChecks();
for (const c of checks) ok('[built-in] ' + c.name, c.ok, c.detail);

// ---------- B. randomized cross-checks beyond the built-ins ----------
const rnd = GRAV.mulberry32(20260929);

function randomCluster(n, seed, spread) {
  const r = GRAV.mulberry32(seed);
  const bs = [];
  for (let i = 0; i < n; i++) {
    bs.push(GRAV.makeBody((r() * 2 - 1) * spread, (r() * 2 - 1) * spread,
      (r() * 2 - 1) * 0.3, (r() * 2 - 1) * 0.3, 0.5 + r()));
  }
  return bs;
}

// B1: theta=0 exactness on 5 random clusters
let b1 = true, worstB1 = 0;
for (let s = 0; s < 5; s++) {
  const bs = randomCluster(120, 100 + s, 1);
  const A = GRAV.cloneBodies(bs); GRAV.accelerationsBF(A, { G: 1, eps: 0.05 });
  const B = GRAV.cloneBodies(bs); GRAV.accelerationsBH(B, { G: 1, eps: 0.05, theta: 0 });
  const rel = GRAV.rmseRel(GRAV.accSnapshot(A), GRAV.accSnapshot(B)).max;
  worstB1 = Math.max(worstB1, rel);
  if (rel > 1e-12) b1 = false;
}
ok('B1 θ=0 精确性（5 组随机星团）', b1, 'worst max-rel=' + worstB1.toExponential(2));

// B2: BH accuracy at theta=0.5 within 6% RMS on random clusters
let b2 = true, worstB2 = 0;
for (let s = 0; s < 4; s++) {
  const bs = randomCluster(150, 200 + s, 1);
  const A = GRAV.cloneBodies(bs); GRAV.accelerationsBF(A, { G: 1, eps: 0.05 });
  const B = GRAV.cloneBodies(bs); GRAV.accelerationsBH(B, { G: 1, eps: 0.05, theta: 0.5 });
  const rms = GRAV.rmseRel(GRAV.accSnapshot(A), GRAV.accSnapshot(B)).rms;
  worstB2 = Math.max(worstB2, rms);
  if (rms > 0.06) b2 = false;
}
ok('B2 θ=0.5 精度 < 6% rms（随机星团）', b2, 'worst rms=' + worstB2.toExponential(2));

// B3: Newton's third law pairwise: m_i a_ij = -m_j a_ji
let b3 = true, worstB3 = 0;
{
  const bs = randomCluster(6, 300, 1);
  for (let i = 0; i < bs.length; i++) {
    for (let j = i + 1; j < bs.length; j++) {
      const pair = [GRAV.cloneBodies([bs[i]])[0], GRAV.cloneBodies([bs[j]])[0]];
      GRAV.accelerationsBF(pair, { G: 1, eps: 0.02 });
      const p = Math.abs(pair[0].m * pair[0].ax + pair[1].m * pair[1].ax)
        + Math.abs(pair[0].m * pair[0].ay + pair[1].m * pair[1].ay);
      const nrm = pair[0].m * Math.abs(pair[0].ax) + pair[1].m * Math.abs(pair[1].ax) || 1;
      const rel = p / nrm;
      worstB3 = Math.max(worstB3, rel);
      if (rel > 1e-12) b3 = false;
    }
  }
}
ok('B3 牛顿第三定律（成对力严格等大反向）', b3, 'worst rel=' + worstB3.toExponential(2));

// B4: energy + momentum conservation across 3 random ICs, exact mode, 600 steps
let b4 = true, worstB4 = 0, worstB4p = 0;
for (let s = 0; s < 3; s++) {
  const bs = randomCluster(50, 400 + s, 1);
  const o = { G: 1, eps: 0.05, mode: 'exact' };
  GRAV.initAccel(bs, o);
  const E0 = GRAV.energy(bs, o);
  const p0 = GRAV.momentum(bs);
  for (let i = 0; i < 600; i++) GRAV.step(bs, 0.002, o);
  const dE = Math.abs((GRAV.energy(bs, o) - E0) / E0);
  const p1 = GRAV.momentum(bs);
  const dp = Math.hypot(p1.x - p0.x, p1.y - p0.y) / (Math.hypot(p0.x, p0.y) || 1);
  worstB4 = Math.max(worstB4, dE); worstB4p = Math.max(worstB4p, dp);
  if (dE > 1e-2 || dp > 1e-12) b4 = false;
}
ok('B4 随机星团 600 步：能量漂移 < 1% 且动量守恒', b4, 'worst |ΔE/E|=' + worstB4.toExponential(2) + '，|Δp/p|=' + worstB4p.toExponential(2));

// B5: RK4 is 4th order on the two-body orbit (position error after one period)
function binaryErr(dt, integ) {
  const bs = GRAV.binaryIC({ G: 1, m: 1, r: 1 });
  const o = { G: 1, eps: 0, mode: 'exact' };
  GRAV.initAccel(bs, o);
  const T = GRAV.binaryPeriod({ G: 1, m: 1, r: 1 });
  const n = Math.round(T / dt); const dt2 = T / n;
  const stp = GRAV.stepper(integ);
  for (let i = 0; i < n; i++) stp(bs, dt2, o);
  return Math.hypot(bs[0].x + 0.5, bs[0].y) / 0.5;
}
{
  const e1 = binaryErr(2e-3, 'rk4'), e2 = binaryErr(1e-3, 'rk4');
  const ratio = e1 / e2;
  ok('B5 RK4 四阶收敛（dt 减半 → 误差 ~/16）', ratio > 10 && ratio < 40, 'ratio=' + ratio.toFixed(1));
  const v1 = binaryErr(2e-3, 'verlet'), v2 = binaryErr(1e-3, 'verlet');
  ok('B6 Verlet 二阶收敛（dt 减半 → ~/4）', v1 / v2 > 3 && v1 / v2 < 5.5, 'ratio=' + (v1 / v2).toFixed(2));
}

// B7: presets carry zero net momentum (well-conditioned ICs)
let b7 = true, worstB7 = 0;
{
  const sets = [GRAV.diskIC({ n: 100, seed: 1, R: 1 }), GRAV.collideIC({ n: 100, seed: 2, sep: 1.5 }), GRAV.solarIC({ planets: 5, M: 200 })];
  for (const bs of sets) {
    const p = GRAV.momentum(bs), tm = GRAV.totalMass(bs);
    const rel = Math.hypot(p.x, p.y) / (tm * 0.3);
    worstB7 = Math.max(worstB7, rel);
    if (rel > 1e-12) b7 = false;
  }
}
ok('B7 预设初值净动量为零', b7, 'worst |p|/(M·v̄)=' + worstB7.toExponential(2));

// B8: interaction count scaling sub-quadratic: I(800)/I(200) << 16
{
  const i200 = GRAV.accelerationsBH(randomCluster(200, 7, 1), { G: 1, eps: 0.05, theta: 0.5 }).interactions;
  const i800 = GRAV.accelerationsBH(randomCluster(800, 7, 1), { G: 1, eps: 0.05, theta: 0.5 }).interactions;
  const ratio = i800 / i200;
  ok('B8 交互次数亚二次增长', ratio < 8, 'I(800)/I(200)=' + ratio.toFixed(2) + '（二次应为 16）');
}

// B9: tree mass/COM on adversarial input — all bodies at the same point
{
  const bs = [];
  for (let i = 0; i < 30; i++) bs.push(GRAV.makeBody(0.5, 0.5, 0, 0, 1));
  const tree = GRAV.buildTree(bs);
  ok('B9 退化输入（30 体重合）树不崩溃且质量正确', Math.abs(tree.mass - 30) < 1e-12 && isFinite(tree.mx),
    'mass=' + tree.mass + ' depth=' + GRAV.treeDepth(tree));
  GRAV.accelerationsBH(bs, { G: 1, eps: 0.05, theta: 0.5 });
  ok('B10 退化输入力有限', bs.every(b => isFinite(b.ax) && isFinite(b.ay)));
}

// ---------- summary ----------
const line = `PASS ${pass} / ${pass + fail}\n` + (fail ? 'FAIL ' + fails.join(' ;; ') : 'ALL GREEN') + '\n';
fs.writeFileSync(path.join(__dirname, '_smoke.log'), line);
console.log('\n' + line);
process.exit(fail ? 1 : 0);
