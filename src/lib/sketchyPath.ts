// src/lib/sketchyPath.ts
// 「随手写」手绘风路径生成器（零依赖，Excalidraw / Rough.js 思路）
//
// 核心原则：确定性抖动 —— 同一条边每次渲染必须画出同一形状，
// 否则 React Flow 重渲染时线会「抽搐」。做法：
//   1. FNV-1a 把边 id 哈希成 32bit 种子
//   2. mulberry32 伪随机序列驱动抖动幅度
//   3. 沿基准曲线采样 + 垂直方向 seeded 偏移 → Catmull-Rom 平滑回贝塞尔

export interface Pt {
  x: number;
  y: number;
}

/** FNV-1a：字符串 → 32bit 种子 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32：种子 → [0,1) 伪随机序列 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 二次贝塞尔采样（t ∈ [0,1] 均匀取 n 点） */
function sampleQuadratic(p0: Pt, c: Pt, p1: Pt, n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
    });
  }
  return pts;
}

/** Catmull-Rom → 三次贝塞尔：把抖动后的采样点连成平滑曲线 */
function catmullRomPath(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/**
 * 生成手绘抖动曲线路径。
 *
 * @param source 起点（连线出发点，即节点边缘）
 * @param target 终点
 * @param seedStr 确定性种子（用边 id）
 * @param amp 抖动幅度（px，默认 2.5 —— 够歪但不影响阅读）
 * @param bow 基准弓高比例（相对两点距离，默认 0.18，方向由 handle 决定由调用方给带符号值）
 */
export function sketchyPath(
  source: Pt,
  target: Pt,
  seedStr: string,
  amp = 2.5,
  bow = 0.18,
): string {
  const rand = seededRandom(hashString(seedStr));
  // 弓向：seeded 随机 ±1（同一条边恒定）
  const dir = rand() > 0.5 ? 1 : -1;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dist = Math.hypot(dx, dy) || 1;
  // 中垂线方向的弓形控制点
  const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const nx = -dy / dist;
  const ny = dx / dist;
  const control = {
    x: mid.x + nx * dist * bow * dir,
    y: mid.y + ny * dist * bow * dir,
  };
  // 基准曲线采样 9 点，内部点做垂直 seeded 抖动
  const base = sampleQuadratic(source, control, target, 9);
  const jittered: Pt[] = base.map((p, i) => {
    if (i === 0 || i === base.length - 1) return p; // 端点不抖，保证落在 Handle 上
    const off = (rand() * 2 - 1) * amp;
    return { x: p.x + nx * off, y: p.y + ny * off };
  });
  return catmullRomPath(jittered);
}

/** 生成第二条更淡的陪衬描边（手绘重笔感），形状与主线错开 */
export function sketchyGhostPath(
  source: Pt,
  target: Pt,
  seedStr: string,
  amp = 2.5,
  bow = 0.18,
): string {
  // 种子加盐 → 形状近似但不同的第二笔
  return sketchyPath(source, target, `${seedStr}#ghost`, amp * 0.8, bow * 1.12);
}

/* ------------------------------------------------------------------ *
 *  压感带状笔迹（GoodNotes 质感）
 *
 *  与描边思路的本质区别：不是「一条线 + stroke 宽度」，而是
 *  「沿笔迹中心线按压感生成变宽的填充轮廓」——起收笔收细、
 *  中段饱满，宽度带 seeded 微涟漪，视觉上等同真实钢笔/马克笔。
 *  参考 perfect-freehand 的轮廓思路，自实现零依赖版。
 * ------------------------------------------------------------------ */

/** 宽度包络：t ∈ [0,1] → 宽度系数（相对 baseWidth） */
function widthProfile(t: number, seed: () => number): number {
  // 起收笔收细（GoodNotes 笔锋），中段饱满
  const attack = Math.min(t / 0.18, 1); // 起笔渐入
  const release = Math.min((1 - t) / 0.22, 1); // 收笔渐出
  const body = Math.min(attack, release);
  // 中段宽度涟漪（±10%，seeded，模拟手部自然抖动）
  const ripple = 1 + (seed() * 2 - 1) * 0.1;
  return (0.32 + 0.68 * body) * ripple;
}

/**
 * 生成压感带状笔迹的闭合填充路径。
 *
 * @param baseWidth 笔迹基准宽度（px，默认 3）
 */
export function ribbonSketchPath(
  source: Pt,
  target: Pt,
  seedStr: string,
  baseWidth = 3,
  bow = 0.16,
): string {
  const rand = seededRandom(hashString(seedStr));
  const dir = rand() > 0.5 ? 1 : -1;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const mid = { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  const control = {
    x: mid.x + nx * dist * bow * dir,
    y: mid.y + ny * dist * bow * dir,
  };

  const N = 16;
  const base = sampleQuadratic(source, control, target, N);
  const center: Pt[] = base.map((p, i) => {
    if (i === 0 || i === base.length - 1) return p;
    const off = (rand() * 2 - 1) * 1.1; // 中心线微抖（比描边版收敛）
    return { x: p.x + nx * off, y: p.y + ny * off };
  });

  // 沿法向两侧生成轮廓点
  const left: Pt[] = [];
  const right: Pt[] = [];
  center.forEach((p, i) => {
    const t = i / (center.length - 1);
    const w = (baseWidth * widthProfile(t, rand)) / 2;
    left.push({ x: p.x + nx * w, y: p.y + ny * w });
    right.push({ x: p.x - nx * w, y: p.y - ny * w });
  });

  // 闭合多边形：左去 + 右回，Catmull-Rom 平滑后闭合
  const loop = [...left, ...right.reverse()];
  let d = `M ${loop[0].x.toFixed(2)} ${loop[0].y.toFixed(2)}`;
  for (let i = 0; i < loop.length - 1; i++) {
    const p0 = loop[Math.max(i - 1, 0)];
    const p1 = loop[i];
    const p2 = loop[i + 1];
    const p3 = loop[Math.min(i + 2, loop.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return `${d} Z`;
}

/** 笔迹中点（供标签定位；带状路径的视觉中心） */
export function ribbonMidpoint(source: Pt, target: Pt, bow = 0.16): Pt {
  return {
    x: (source.x + target.x) / 2 - (target.y - source.y) * bow * 0.18,
    y: (source.y + target.y) / 2 + (target.x - source.x) * bow * 0.18,
  };
}
