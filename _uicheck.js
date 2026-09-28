// _uicheck.js — headless UI wiring check: minimal DOM stub, run the <script id="ui"> block,
// click every control, verify state + rendering + self-check panel. Catches bugs _smoke cannot see.
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const eng = html.match(/<script id="engine">([\s\S]*?)<\/script>/)[1];
const ui = html.match(/<script id="ui">([\s\S]*?)<\/script>/)[1];

// ---------- DOM stub ----------
const elements = {};
function makeCtx2d() {
  return {
    calls: [],
    _rec(k) { return (...a) => { this.calls.push([k, ...a]); }; },
    clearRect(...a) { this.calls.push(['clearRect', ...a]); },
    fillRect(...a) { this.calls.push(['fillRect', ...a]); },
    strokeRect(...a) { this.calls.push(['strokeRect', ...a]); },
    beginPath() { this.calls.push(['beginPath']); },
    arc(...a) { this.calls.push(['arc', ...a]); },
    fill() { this.calls.push(['fill']); },
    stroke() { this.calls.push(['stroke']); },
    moveTo(...a) { this.calls.push(['moveTo', ...a]); },
    lineTo(...a) { this.calls.push(['lineTo', ...a]); },
    fillText(...a) { this.calls.push(['fillText', ...a]); },
    save() {}, restore() {},
    set fillStyle(v) { this._fs = v; }, get fillStyle() { return this._fs; },
    set strokeStyle(v) { this._ss = v; }, get strokeStyle() { return this._ss; },
    set lineWidth(v) { this._lw = v; }, get lineWidth() { return this._lw; },
    set font(v) { this._f = v; }, get font() { return this._f; }
  };
}
function makeEl(id) {
  const listeners = {};
  const children = [];
  const e = {
    id, tagName: 'DIV',
    value: '', checked: false, textContent: '', innerHTML: '',
    className: '', style: {}, width: 0, height: 0,
    appendChild(c) { children.push(c); c._parent = e; return c; },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    _fire(type, ev) { (listeners[type] || []).forEach(fn => fn.call(e, ev || {})); },
    _listeners: listeners, _children: children,
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 520 }; },
    getContext() { if (!e._ctx) e._ctx = makeCtx2d(); return e._ctx; }
  };
  return e;
}
const IDS = ['cv', 'echart', 'preset', 'nslider', 'nV', 'theta', 'thetaV', 'dtin', 'dtV', 'eps', 'epsV',
  'mode', 'integrator', 'spf', 'spfV', 'btn-play', 'btn-step', 'btn-reset', 'btn-fit',
  'chk-tree', 'chk-trails', 'btn-check', 'sclist', 'scbadge',
  's-t', 's-steps', 's-e', 's-drift', 's-p', 's-l', 's-bh', 's-tree', 's-fps', 's-virial', 's-n'];
const documentStub = {
  readyState: 'complete',
  getElementById(id) { if (!elements[id]) elements[id] = makeEl(id); return elements[id]; },
  createElement(tag) { const e = makeEl('_' + tag + Math.random()); e.tagName = tag.toUpperCase(); return e; },
  addEventListener() {}, createTextNode(t) { return { text: t, textContent: t }; }
};
let rafQ = [], rafCap = 400;
const windowStub = {
  devicePixelRatio: 1,
  addEventListener() {},
  requestAnimationFrame(cb) { if (rafQ.length < rafCap) rafQ.push(cb); },
  setTimeout(cb) { cb(); return 0; }
};
windowStub.globalThis = windowStub;

const ctx = {
  console, Math, Date, JSON, Object, Array, Float64Array, Uint8ClampedArray, Uint8Array, Int32Array,
  isFinite, Infinity, NaN,
  document: documentStub, window: windowStub, requestAnimationFrame: windowStub.requestAnimationFrame,
  setTimeout: windowStub.setTimeout, globalThis: {}
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(eng, ctx, { filename: 'engine.js' });
vm.runInContext(ui, ctx, { filename: 'ui.js' });

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name + (detail ? '  | ' + detail : '')); }
  else { fail++; fails.push(name + (detail ? '  | ' + detail : '')); console.log('FAIL ' + name + (detail ? '  | ' + detail : '')); }
}
const U = ctx.globalThis.__GRAVUI;
ok('UI 脚本加载并暴露 __GRAVUI', !!U && !!U.loadPreset && !!U.state);

// boot ran (readyState complete) → controls synced
ok('boot 后 preset 同步为 figure8', elements['preset'].value === 'figure8', 'value=' + elements['preset'].value);

// run frames
for (let i = 0; i < 6 && rafQ.length; i++) { const q = rafQ; rafQ = []; q.forEach(cb => cb()); }
ok('rAF 帧循环推进模拟步数', U.state.steps > 0, 'steps=' + U.state.steps);
const cvCalls = elements['cv']._ctx ? elements['cv']._ctx.calls : [];
ok('canvas 收到绘制调用（arc/fillRect）', cvCalls.some(c => c[0] === 'arc') && cvCalls.some(c => c[0] === 'fillRect'),
  'calls=' + cvCalls.length);
ok('统计卡已写入（s-t / s-steps）', elements['s-t'].textContent !== '' && elements['s-steps'].textContent !== '',
  't=' + elements['s-t'].textContent + ' steps=' + elements['s-steps'].textContent);

// fire every control once
let fired = 0;
function fire(id, type, ev) { elements[id]._fire(type, ev); fired++; }
for (const v of ['binary', 'disk', 'collide', 'solar', 'figure8']) {
  elements['preset'].value = v; fire('preset', 'change');
}
ok('preset 五个场景全部切换成功（无异常，体数>0）', U.state.bodies.length > 0, 'bodies=' + U.state.bodies.length + ' fired=' + fired);
elements['preset'].value = 'disk'; fire('preset', 'change');

elements['theta'].value = '0.3'; fire('theta', 'input');
elements['dtin'].value = '0.002'; fire('dtin', 'input');
elements['eps'].value = '0.08'; fire('eps', 'input');
elements['spf'].value = '4'; fire('spf', 'input');
elements['nslider'].value = '150'; fire('nslider', 'input');
ok('滑杆/输入更新引擎参数', Math.abs(U.state.theta - 0.3) < 1e-12 && Math.abs(U.state.dt - 0.002) < 1e-12
  && Math.abs(U.state.eps - 0.08) < 1e-12 && U.state.stepsPerFrame === 4,
  'theta=' + U.state.theta + ' dt=' + U.state.dt + ' eps=' + U.state.eps + ' spf=' + U.state.stepsPerFrame);

elements['mode'].value = 'exact'; fire('mode', 'change');
elements['mode'].value = 'bh'; fire('mode', 'change');
elements['integrator'].value = 'euler'; fire('integrator', 'change');
elements['integrator'].value = 'verlet'; fire('integrator', 'change');
elements['chk-tree'].checked = true; fire('chk-tree', 'change');
elements['chk-trails'].checked = false; fire('chk-trails', 'change');
ok('模式/积分器/复选框切换无异常', U.state.showTree === true && U.state.trails === false);
elements['chk-trails'].checked = true; fire('chk-trails', 'change');

fire('btn-step', 'click');
fire('btn-reset', 'click');
fire('btn-fit', 'click');
ok('单步/重置/适配按钮无异常', U.state.steps >= 0 && U.state.bodies.length > 0);

// play/pause roundtrip
const wasPlaying = U.state.playing;
fire('btn-play', 'click');
ok('播放/暂停切换', U.state.playing === !wasPlaying, 'now=' + U.state.playing);
fire('btn-play', 'click');

// energy history growth
const h0 = U.state.eHist.length;
for (let i = 0; i < 4 && rafQ.length; i++) { const q = rafQ; rafQ = []; q.forEach(cb => cb()); }
ok('能量历史随帧累积', U.state.eHist.length > h0, h0 + ' → ' + U.state.eHist.length);

// self-check panel (setTimeout runs synchronously)
fire('btn-check', 'click');
const lis = Array.from(new Set(elements['sclist']._children));
function markOf(li) {
  for (const c of li._children || []) { if (c._children && c._children.length === 0 && /✅|⚠️/.test(c.textContent)) return c.textContent; }
  return '';
}
const oks = lis.filter(li => markOf(li) === '✅').length;
const bads = lis.filter(li => markOf(li) === '⚠️').length;
ok('自检面板渲染 17 项且全绿', lis.length === 17 && oks === 17 && bads === 0,
  `li=${lis.length} ok=${oks} bad=${bads} badge="${elements['scbadge'].textContent}" badgeClass="${elements['scbadge'].className}"`);
ok('自检徽章为 ok 样式', /ok/.test(elements['scbadge'].className), elements['scbadge'].className);

// lastStats sane after BH steps
U.stepOnce(3);
const st = ctx.GRAV.lastStats();
ok('lastStats：BH 交互数 < 精确对数', st.interactions > 0 && st.interactions < st.pairs,
  `${st.interactions} < ${st.pairs} nodes=${st.nodes} depth=${st.depth}`);

// no NaN in stats panel
const statText = IDS.filter(i => i.startsWith('s-')).map(i => elements[i].textContent).join('|');
ok('统计面板无 NaN', !/NaN/.test(statText), statText.slice(0, 120));

const line = `PASS ${pass} / ${pass + fail}\n` + (fail ? 'FAIL ' + fails.join(' ;; ') : 'ALL GREEN') + '\n';
fs.writeFileSync(path.join(__dirname, '_uicheck.log'), line);
console.log('\n' + line);
process.exit(fail ? 1 : 0);
