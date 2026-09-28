// build.js — inline _style.css + _engine.js + _ui.js into a single index.html (zero deps).
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const css = fs.readFileSync(path.join(dir, '_style.css'), 'utf8');
const engine = fs.readFileSync(path.join(dir, '_engine.js'), 'utf8');
const ui = fs.readFileSync(path.join(dir, '_ui.js'), 'utf8');

const body = `
<div class="wrap">
  <header class="top">
    <h1><code>gravity-forge</code> <span style="font-size:14px;color:var(--muted)">v1.0</span></h1>
    <span class="sub">Barnes-Hut 四叉树 N 体引力实验室 · 单文件 · 零依赖 · 完全离线</span>
    <span class="right">作者 <a href="https://github.com/CJX0712" target="_blank" rel="noopener">晨星</a> ·
      <a href="https://github.com/CJX0712/gravity-forge" target="_blank" rel="noopener">GitHub</a></span>
  </header>

  <div class="layout">
    <div class="stage">
      <div id="stagebox">
        <canvas id="cv"></canvas>
        <div id="hud">拖拽平移 · 滚轮缩放</div>
      </div>

      <div class="panel" style="margin-top:12px">
        <h2>守恒量与性能 <b>实时诊断</b></h2>
        <div class="stats">
          <div class="stat"><div class="k">模拟时间 t</div><div class="v" id="s-t">–</div></div>
          <div class="stat"><div class="k">步数</div><div class="v" id="s-steps">–</div></div>
          <div class="stat"><div class="k">总能量 E</div><div class="v" id="s-e">–</div></div>
          <div class="stat"><div class="k">能量漂移 |ΔE/E₀|</div><div class="v" id="s-drift">–</div></div>
          <div class="stat"><div class="k">动量漂移</div><div class="v" id="s-p">–</div></div>
          <div class="stat"><div class="k">角动量 L</div><div class="v" id="s-l">–</div></div>
          <div class="stat"><div class="k">本帧力交互 BH / 精确</div><div class="v" id="s-bh">–</div></div>
          <div class="stat"><div class="k">四叉树</div><div class="v" id="s-tree">–</div></div>
          <div class="stat"><div class="k">FPS</div><div class="v" id="s-fps">–</div></div>
          <div class="stat"><div class="k">维里比 2K/|U|</div><div class="v" id="s-virial">–</div></div>
          <div class="stat"><div class="k">质点数 N</div><div class="v" id="s-n">–</div></div>
        </div>
        <canvas id="echart" width="600" height="96" style="margin-top:10px"></canvas>
      </div>
    </div>

    <div class="side">
      <div class="panel">
        <h2>初始条件</h2>
        <div class="ctl-grid">
          <div class="row"><label for="preset">场景</label>
            <select id="preset">
              <option value="figure8">三体 8 字轨道</option>
              <option value="binary">双星圆轨道</option>
              <option value="disk">旋转星系盘</option>
              <option value="collide">星系对撞</option>
              <option value="solar">迷你太阳系</option>
            </select>
          </div>
          <div class="row"><label for="nslider">质点数 N（盘/对撞）</label>
            <input type="range" id="nslider" min="50" max="3000" step="50" value="400">
            <span class="val" id="nV">400</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <h2>物理与算法</h2>
        <div class="ctl-grid">
          <div class="row"><label for="theta">θ 开关阈值</label>
            <input type="range" id="theta" min="0" max="1.2" step="0.05" value="0.5">
            <span class="val" id="thetaV">0.50</span>
          </div>
          <div class="row"><label for="dtin">步长 dt</label>
            <input type="number" id="dtin" min="0.00005" max="0.05" step="0.0005" value="0.001">
            <span class="val" id="dtV">0.0010</span>
          </div>
          <div class="row"><label for="eps">软化 ε</label>
            <input type="range" id="eps" min="0" max="0.2" step="0.005" value="0.05">
            <span class="val" id="epsV">0.050</span>
          </div>
          <div class="row"><label for="mode">力计算</label>
            <select id="mode">
              <option value="bh">Barnes-Hut O(N log N)</option>
              <option value="exact">精确两两 O(N²)</option>
            </select>
          </div>
          <div class="row"><label for="integrator">积分器</label>
            <select id="integrator">
              <option value="verlet">速度 Verlet（辛）</option>
              <option value="euler">显式 Euler（对照）</option>
              <option value="rk4">RK4（对照）</option>
            </select>
          </div>
          <div class="row"><label for="spf">每帧步数</label>
            <input type="range" id="spf" min="1" max="40" step="1" value="2">
            <span class="val" id="spfV">2</span>
          </div>
          <div class="checks">
            <label><input type="checkbox" id="chk-trails" checked> 轨迹拖尾</label>
            <label><input type="checkbox" id="chk-tree"> 显示四叉树</label>
          </div>
        </div>
        <div class="btns">
          <button id="btn-play" class="primary">⏸ 暂停</button>
          <button id="btn-step">单步</button>
          <button id="btn-reset">重置</button>
          <button id="btn-fit">适配视野</button>
        </div>
      </div>

      <div class="panel selfcheck">
        <div class="sc-head">
          <h2 style="margin:0">算法不变量自检</h2>
          <span class="badge" id="scbadge">未运行</span>
          <button id="btn-check" style="margin-left:auto">▶ 运行 17 项自检</button>
        </div>
        <ul class="sclist" id="sclist">
          <li style="border:none;color:var(--muted)">点击右上角按钮：在浏览器里现场验证 θ=0 退化、
          动量/角动量守恒、Verlet 二阶收敛、时间可逆性、二体解析周期、三体 8 字闭合等不变量。</li>
        </ul>
        <div class="sc-note">全部自检在浏览器本地运行，不需要网络；断言与无头测试 <code>_smoke.js</code> 同源。</div>
      </div>
    </div>
  </div>

  <footer class="foot">
    gravity-forge · MIT License · 作者 晨星 (CJX0712) · Barnes-Hut 1986 · 速度 Verlet · Chenciner–Montgomery 8 字轨道
  </footer>
</div>
`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gravity-forge — Barnes-Hut N 体引力实验室（单文件 · 零依赖）</title>
<style>
${css}
</style>
</head>
<body>
${body}
<script id="engine">
${engine}
</script>
<script id="ui">
${ui}
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log('index.html written:', (html.length / 1024).toFixed(1) + ' KB');
