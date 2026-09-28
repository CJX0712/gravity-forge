// _probe.js — dump human-readable internal structure to _probe.txt (asserts can be green while output is garbage).
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const m = html.match(/<script id="engine">([\s\S]*?)<\/script>/);
const ctx = { console, Math, TextEncoder, TextDecoder, Uint8Array, Int32Array, Int8Array, Float64Array, Float32Array, Uint8ClampedArray, Object, Array, JSON, isFinite, Infinity, Date, NaN, globalThis: {} };
ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(m[1], ctx, { filename: 'engine.js' });
const GRAV = ctx.GRAV;
const out = [];
const P = (s) => out.push(s);

// ---- P1: figure-8 path of body 0 over one period, as ASCII art ----
{
  const bs = GRAV.figureEightIC();
  const o = { G: 1, eps: 0, mode: 'bh', theta: 0.5 };
  GRAV.initAccel(bs, o);
  const T = GRAV.FIGURE_EIGHT_PERIOD;
  const N = 2400, dt = T / N;
  const W = 76, H = 26;
  const grid = [];
  for (let y = 0; y < H; y++) grid.push(new Array(W).fill(' '));
  const xs = [], ys = [];
  for (let i = 0; i <= N; i++) {
    xs.push(bs[0].x); ys.push(bs[0].y);
    if (i < N) GRAV.step(bs, dt, o);
  }
  const minx = -1.1, maxx = 1.1, miny = -0.5, maxy = 0.5;
  for (let i = 0; i < xs.length; i++) {
    const px = Math.round((xs[i] - minx) / (maxx - minx) * (W - 1));
    const py = Math.round((maxy - ys[i]) / (maxy - miny) * (H - 1));
    if (px >= 0 && px < W && py >= 0 && py < H) grid[py][px] = '*';
  }
  // mark start / end
  const ex = Math.round((xs[xs.length - 1] - minx) / (maxx - minx) * (W - 1));
  const ey = Math.round((maxy - ys[ys.length - 1]) / (maxy - miny) * (H - 1));
  if (ex >= 0 && ex < W && ey >= 0 && ey < H) grid[ey][ex] = '@';
  P('P1 三体 8 字轨道：body0 在一个周期 T 的轨迹（* 轨迹，@ 终点=起点附近）');
  for (const row of grid) P('  |' + row.join('') + '|');
  P('  闭合误差 = ' + Math.hypot(bs[0].x - 0.97000436, bs[0].y + 0.24308753).toExponential(3));
  P('');
}

// ---- P2: quadtree layout for a tiny cluster ----
{
  const bs = [
    GRAV.makeBody(-1, -1, 0, 0, 1), GRAV.makeBody(1, 1, 0, 0, 1),
    GRAV.makeBody(1, -1, 0, 0, 1), GRAV.makeBody(-0.05, 0.05, 0, 0, 1),
    GRAV.makeBody(2, 2, 0, 0, 2)
  ];
  const tree = GRAV.buildTree(bs);
  const lines = [];
  function walk(node, ind) {
    const kind = node.kids ? 'cell' : 'LEAF';
    lines.push(`${ind}${kind} half=${node.half.toPrecision(3)} m=${node.mass.toPrecision(4)} com=(${node.mx.toPrecision(3)},${node.my.toPrecision(3)})${node.kids ? '' : ' items=[' + node.items.join(',') + ']'}`);
    if (node.kids) for (let q = 0; q < 4; q++) walk(node.kids[q], ind + '  ');
  }
  walk(tree, '  ');
  P('P2 四叉树结构（5 体，其中 2 体近距 (-0.05,0.05)/(0,0) 邻域）');
  P(lines.join('\n'));
  P('');
}

// ---- P3: BH accuracy / cost table across N ----
{
  P('P3 BH 精度与开销（diskIC, eps=0.05）');
  P('  N      θ=0.2 rms   θ=0.5 rms   θ=0.8 rms   交互(0.5)   精确pairs   节点数   深度');
  for (const n of [100, 400, 1000]) {
    const bs = GRAV.diskIC({ n, seed: 3, R: 1 });
    const A = GRAV.cloneBodies(bs); GRAV.accelerationsBF(A, { G: 1, eps: 0.05 });
    const ref = GRAV.accSnapshot(A);
    const row = { 0.2: null, 0.5: null, 0.8: null };
    let st = null;
    for (const th of [0.2, 0.5, 0.8]) {
      const B = GRAV.cloneBodies(bs);
      st = GRAV.accelerationsBH(B, { G: 1, eps: 0.05, theta: th });
      row[th] = GRAV.rmseRel(ref, GRAV.accSnapshot(B)).rms;
    }
    P('  ' + String(n).padEnd(6) + row[0.2].toExponential(2).padEnd(11) + row[0.5].toExponential(2).padEnd(11) +
      row[0.8].toExponential(2).padEnd(11) + String(st.interactions).padEnd(11) +
      String(n * (n - 1) / 2).padEnd(11) + String(st.nodes).padEnd(8) + st.depth);
  }
  P('');
}

// ---- P4: energy drift trace, verlet vs euler (exact mode), first 12 samples ----
{
  P('P4 能量相对漂移时间序列（diskIC n=30, exact mode, dt=0.01, T=2）');
  for (const integ of ['verlet', 'euler']) {
    const bs = GRAV.diskIC({ n: 30, seed: 5, R: 1 });
    const o = { G: 1, eps: 0.05, mode: 'exact' };
    GRAV.initAccel(bs, o);
    const E0 = GRAV.energy(bs, o);
    const stp = GRAV.stepper(integ);
    const row = [];
    for (let i = 1; i <= 200; i++) {
      stp(bs, 0.01, o);
      if (i % 25 === 0) row.push(((GRAV.energy(bs, o) - E0) / E0).toExponential(2));
    }
    P(`  ${integ.padEnd(7)} t=0.25..2.0: ${row.join('  ')}`);
  }
  P('');
}

// ---- P5: binary orbit sanity: radius over one period (should be constant 0.5) ----
{
  const bs = GRAV.binaryIC({ G: 1, m: 1, r: 1 });
  const o = { G: 1, eps: 0, mode: 'exact' };
  GRAV.initAccel(bs, o);
  const T = GRAV.binaryPeriod({ G: 1, m: 1, r: 1 });
  const N = 2000, dt = T / N;
  const rs = [];
  for (let i = 0; i <= N; i++) {
    if (i % 200 === 0) rs.push(Math.hypot(bs[0].x, bs[0].y).toFixed(6));
    if (i < N) GRAV.step(bs, dt, o);
  }
  P('P5 双星圆轨道 body0 半径采样（应为恒定 0.500000）');
  P('  ' + rs.join('  '));
  P('');
}

fs.writeFileSync(path.join(__dirname, '_probe.txt'), out.join('\n') + '\n');
console.log('probe written');
