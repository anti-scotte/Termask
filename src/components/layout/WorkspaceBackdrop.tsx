// src/components/layout/WorkspaceBackdrop.tsx
// 工作台氛围背景层（视觉重设计）
//
// 设计目标：打破主内容区纯白/纯黑的「死板底色」——
//   1. 三条极淡的模板色光带（emerald / sky / violet，与三大功能页对位：
//      模板管理=绿、概念图谱=蓝、白板=紫），呼吸漂移动画
//   2. 一层极细的斜向织纹（repeating-linear-gradient），增加纸感
//   3. 全程 pointer-events-none，不挡任何交互；prefers-reduced-motion 时静止
//
// 性能：纯 CSS transform 动画（合成层），不触发重排。

export function WorkspaceBackdrop() {
  return (
    <div
      className="wb-backdrop pointer-events-none fixed inset-0 overflow-hidden"
      aria-hidden
    >
      {/* 模板色光带：左（emerald）/ 中上（sky）/ 右下（violet） */}
      <div className="wb-blob wb-blob-a" />
      <div className="wb-blob wb-blob-b" />
      <div className="wb-blob wb-blob-c" />
      {/* 细织纹 */}
      <div className="wb-weave" />
    </div>
  );
}
