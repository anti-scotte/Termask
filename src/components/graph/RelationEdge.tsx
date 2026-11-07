// src/components/graph/RelationEdge.tsx
// 自定义关系边：主标签（关系词）+ 副标签（模型解释）+ 三种连线形态
//
// 用 EdgeLabelRenderer 在 SVG 之上渲染 HTML 标签：
//   - 关系词：深色胶囊、高对比
//   - explanation 存在时在其下方渲染浅色小字胶囊（截断展示，title 悬浮看全文）
//
// 连线形态（data.lineStyle，缺省 smooth）：
//   - smooth   自由连线：贝塞尔曲线（发散联想）
//   - straight 直线：干净直连（逻辑链箭头）
//   - sketch   随手写：seeded 手绘抖动线（sketchyPath，同一条边形状恒定）
//              + 淡色第二笔（重描手感）+ 箭头指向
// 双击边可在 GraphPage 循环切换三种形态（onEdgeDoubleClick）。

import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from "@xyflow/react";
import type { ConceptEdgeData } from "@/types/graph";
import {
  hashString,
  ribbonSketchPath,
  seededRandom,
  sketchyPath,
  sketchyGhostPath,
} from "@/lib/sketchyPath";

export const RelationEdge = memo(function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps) {
  const d = (data ?? {}) as ConceptEdgeData;
  const lineStyle = d.lineStyle ?? "smooth";
  let ribbon: string | null = null;
  /** sketch 控制点（供箭头方向计算，与 ribbonSketchPath 内部基准一致） */
  let sketchCtrlX = 0;
  let sketchCtrlY = 0;

  // 三种形态各自计算路径；sketch 用 seeded 抖动（id 作种子，重渲染形状恒定）
  let path: string;
  let labelX: number;
  let labelY: number;
  let ghostPath: string | null = null;

  if (lineStyle === "orthogonal") {
    // 规整折线：直线 + 90° 折线，弯折处圆弧半径可调（data.cornerRadius）
    [path, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: Math.max(0, d.cornerRadius ?? 12),
    });
  } else if (lineStyle === "straight") {
    [path, labelX, labelY] = getStraightPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
    });
  } else if (lineStyle === "sketch") {
    // 随手写：GoodNotes 压感带状笔迹（起收笔收细、中段饱满、seeded 恒定形状）
    // label 位置沿用贝塞尔中点；交互热区仍用贝塞尔描边（BaseEdge stroke 透明化由下层处理）
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      curvature: 0.16,
    });
    ghostPath = sketchyGhostPath(
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
      id,
    );
    ribbon = ribbonSketchPath(
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
      id,
      3.2,
    );
    // 复现 ribbonSketchPath 内部的弓向 seed（同 id 同 dir），得到控制点供箭头切线
    {
      const rnd = seededRandom(hashString(id));
      const dir = rnd() > 0.5 ? 1 : -1;
      const ddx = targetX - sourceX;
      const ddy = targetY - sourceY;
      const dd = Math.hypot(ddx, ddy) || 1;
      const nx = -ddy / dd;
      const ny = ddx / dd;
      sketchCtrlX = (sourceX + targetX) / 2 + nx * dd * 0.16 * dir;
      sketchCtrlY = (sourceY + targetY) / 2 + ny * dd * 0.16 * dir;
    }
    path = sketchyPath(
      { x: sourceX, y: sourceY },
      { x: targetX, y: targetY },
      id,
    );
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  // 随手写形态必带箭头指向；旧边/推送边可能未设 markerEnd → 自带 <defs> 箭头兜底
  const selfMarkerId = `sketch-arrow-${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const sketchStroke = selected ? "#38bdf8" : "#94a3b8";
  const sketchFill = selected ? "#38bdf8" : "#a3b2c7";
  const resolvedMarkerEnd = lineStyle === "sketch" && !markerEnd
    ? `url(#${selfMarkerId})`
    : markerEnd;

  return (
    <>
      {lineStyle === "sketch" && !markerEnd && (
        <defs>
          <marker
            id={selfMarkerId}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="14"
            markerHeight="14"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path
              d="M 0 1 L 8 5 L 0 9"
              fill="none"
              stroke={sketchStroke}
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        </defs>
      )}
      {/* 压感带状笔迹本体（填充）；其下保留 BaseEdge 作为交互热区（透明描边加粗） */}
      {ribbon && (
        <>
          <BaseEdge
            id={id}
            path={path}
            className={selected ? "!stroke-sky-400" : undefined}
            style={{
              stroke: "transparent",
              strokeWidth: 10,
              fill: "none",
            }}
          />
          <path
            d={ribbon}
            fill={sketchFill}
            fillOpacity={0.92}
            stroke="none"
            pointerEvents="none"
          />
          {/* 末端箭头：按贝塞尔末端切线方向的填充三角（带状路径无法用 marker 沿 stroke 定位） */}
          <polygon
            points="0,-4.6 9,0 0,4.6"
            fill={sketchFill}
            transform={`translate(${targetX}, ${targetY}) rotate(${(Math.atan2(
              targetY - sketchCtrlY,
              targetX - sketchCtrlX,
            ) * 180) / Math.PI})`}
            pointerEvents="none"
          />
          {/* 手绘重笔第二道（低透明度错位描边） */}
          <path
            d={ghostPath ?? ""}
            fill="none"
            className={selected ? "stroke-sky-300/40" : "stroke-slate-400/25"}
            strokeWidth={1.2}
            strokeLinecap="round"
            pointerEvents="none"
          />
        </>
      )}
      {!ribbon && (
        <BaseEdge
          id={id}
          path={path}
          markerEnd={resolvedMarkerEnd}
          className={
            selected
              ? "!stroke-sky-400"
              : lineStyle === "sketch"
                ? "!stroke-slate-400"
                : undefined
          }
        />
      )}
      {/* 手绘第二笔：错位淡描边（仅 sketch，不参与交互） */}
      {ghostPath && (
        <path
          d={ghostPath}
          fill="none"
          className={selected ? "stroke-sky-300/40" : "stroke-slate-400/30"}
          strokeWidth={1.4}
          strokeLinecap="round"
          pointerEvents="none"
        />
      )}
      {(d.label || d.explanation) && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute flex flex-col items-center gap-0.5"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {d.label && (
              <span
                className={`rounded-md border px-2 py-0.5 text-[11px] font-medium shadow-sm backdrop-blur-sm transition-colors ${
                  selected
                    ? "border-sky-300/70 bg-sky-500/90 text-white"
                    : "border-slate-600/70 bg-slate-800/95 text-slate-100"
                }`}
              >
                {d.label}
              </span>
            )}
            {d.explanation && (
              <span
                className="max-w-[180px] truncate rounded border border-slate-700/50 bg-slate-900/85 px-1.5 py-0.5 text-[10px] leading-tight text-slate-400"
                title={d.explanation}
              >
                {d.explanation}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
