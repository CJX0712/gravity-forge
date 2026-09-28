# gravity-forge

[![License: MIT](https://img.shields.io/badge/License-MIT-2456d6.svg)](LICENSE)
[![zero deps](https://img.shields.io/badge/deps-zero-14834b.svg)](#)
[![offline](https://img.shields.io/badge/run-fully%20offline-b97a12.svg)](#)
[![tests](https://img.shields.io/badge/smoke%20%2B%20uicheck-42%2F42%20green-14834b.svg)](#无头验证)

**Barnes-Hut 四叉树 N 体引力实验室** —— 单文件 HTML，零依赖，完全离线，浏览器直接打开即用。
作者：**晨星**（[CJX0712](https://github.com/CJX0712)）

> 从三体 8 字周期轨道到星系对撞，每一帧都在被物理守恒律审计：
> θ=0 时 Barnes-Hut 逐位退化为精确两两求和、Verlet 辛积分时间可逆（前进 300 步 + 后退 300 步误差 ~1e-14）、
> 二体圆轨道一周期后回到解析初值、三体 8 字轨道 T=6.32591398 精确闭合。

## 快速开始

```bash
git clone https://github.com/CJX0712/gravity-forge.git
# 直接双击打开 index.html 即可（无需服务器、无网络、无构建）
```

或运行无头验证：

```bash
node _smoke.js    # 27 项引擎不变量（Node vm 沙箱，针对交付的 index.html）
node _uicheck.js  # 15 项 UI 接线检查（最小 DOM stub）
node _probe.js    # 结构探针：8 字轨迹 ASCII、四叉树布局、能量序列
```

## 界面

- **5 个场景**：三体 8 字轨道 / 双星圆轨道 / 旋转星系盘（N≤3000）/ 星系对撞 / 迷你太阳系
- **实时诊断卡**：能量漂移 |ΔE/E₀|、动量漂移、角动量、维里比 2K/|U|、本帧 BH/精确交互数、四叉树节点数与深度、FPS
- **能量曲线**：KE / PE / 漂移三条时间序列
- **可视化四叉树**：勾选后叠加显示空间剖分
- **交互**：拖拽平移、滚轮缩放、单步、暂停；θ / dt / ε / 积分器 / 力模式全部可调

## 算法

| 模块 | 实现 |
|---|---|
| 引力加速 | Barnes-Hut 四叉树（θ 开关判据，叶桶 + 深度上限 26）＋ 精确两两 O(N²) 参照 |
| 软化 | Plummer：`a ∝ r/(r²+ε²)^{3/2}`，势能 `-Gm₁m₂/√(r²+ε²)` 严格配套 → 能量守恒闭合 |
| 积分器 | 速度 Verlet（辛、二阶、时间可逆）/ 显式 Euler（一阶对照）/ 经典 RK4（四阶对照） |
| 初值 | Chenciner–Montgomery 三体 8 字周期解；解析双星圆轨道 `v=√(Gm/2r)`；旋转盘 / 对撞 / 太阳系 |

### 可验证不变量（浏览器内可现场重跑 17 项自检）

| 不变量 | 实测 |
|---|---|
| θ=0 ⇒ BH ≡ 精确两两求和 | max rel err = 7.1e-15 |
| BH 误差随 θ 单调增大 | rms: 1.0e-3 → 1.3e-2 → 4.3e-2（θ=0.2/0.5/0.8） |
| 每体交互数亚线性增长 | N 1000→4000：97.7 → 132.9 次/体（×1.36，N 增 4 倍） |
| 动量守恒（精确模式 400 步） | \|Δp\| = 8.8e-17 |
| 角动量守恒（精确模式 400 步） | ΔL = 3.3e-16 |
| Verlet 能量误差二阶收敛 | dt 减半 → 误差 /3.96 |
| Euler 一阶 + 差 200 倍 | ratio 1.49；4.8e-1 vs 2.3e-3 |
| **BH 存在与 dt 无关的 θ 误差地板** | dt 减半误差比 0.92（≈1 即不收敛） |
| Verlet 时间可逆 | 前 300 步 + 后 300 步：位置误差 1.1e-14 |
| 二体圆轨道解析周期 | T=2π√(r³/2Gm)=4.442883，回到初态误差 4.2e-6 |
| 三体 8 字一周期闭合 | 闭合误差 6.7e-8（T=6.32591398） |
| 退化输入（30 体重合一点） | 树深度 27 不崩溃，力有限 |

最有教学价值的一条：**BH 模式下能量漂移存在与 dt 无关的地板**——dt 从 0.005 减到 0.0025，精确模式误差 /4（二阶收敛），BH 模式几乎不动（0.92）。它精确演示了「力近似误差」和「积分截断误差」是两条独立误差轴。

## 文件结构

```
gravity-forge/
├── index.html      # 唯一交付物：内联 CSS/JS 的单文件应用（~53 KB）
├── _smoke.js       # 无头引擎自检（Node vm，27 项）
├── _uicheck.js     # 无头 UI 接线自检（最小 DOM stub，15 项）
├── _probe.js       # 结构探针（ASCII 轨迹 / 树 / 能量序列）
├── build.js        # 开发用：_engine.js + _ui.js + _style.css → index.html
└── _engine.js/_ui.js/_style.css  # 源码分件（已内联进 index.html）
```

## 许可

MIT © 2026 晨星
