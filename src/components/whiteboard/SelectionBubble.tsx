// src/components/whiteboard/SelectionBubble.tsx
// 选中形状后浮现的「AI 助读 / 加入收集区」悬浮条
//
// 挂在画布容器内（与 Tldraw 同级，占满画布的 relative 包裹层），
// tldraw 的 screen 坐标系即容器相对坐标，可直接用于绝对定位。
// 通过 useValue 订阅 editor 的选择集信号，选中变化即重渲染。

import { useValue } from "tldraw";
import type { Editor } from "tldraw";
import { Plus, Sparkles } from "lucide-react";

/** 取选中形状上的全部文字（文本形状有值；图片等无文字返回空串） */
export function getSelectionText(editor: Editor): string {
  return editor
    .getSelectedShapes()
    .map((s) => {
      const props = (s.props ?? {}) as { richText?: unknown };
      return richTextToPlain(props.richText).trim();
    })
    .filter((t) => t.length > 0)
    .join(" ")
    .trim();
}

/** tiptap 富文本 JSON（TLRichText）→ 纯文本（v5 已移除 editor.getText） */
export function richTextToPlain(rich: unknown): string {
  if (!rich || typeof rich !== "object") return "";
  const node = rich as { text?: unknown; content?: unknown };
  if (typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map((c) => richTextToPlain(c)).join("\n");
  }
  return "";
}

export function SelectionBubble({
  editor,
  onAsk,
  onToCollection,
  asking,
}: {
  editor: Editor;
  onAsk: () => void;
  onToCollection: () => void;
  asking: boolean;
}) {
  const selectedIds = useValue(
    "selectedIds",
    () => editor.getSelectedShapeIds(),
    [editor],
  );

  if (selectedIds.length === 0) return null;
  const bounds = editor.getSelectionScreenBounds();
  if (!bounds) return null;
  const hasText = getSelectionText(editor).length > 0;

  return (
    <div
      className="absolute z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-popover px-1.5 py-1 shadow-lg"
      style={{ left: bounds.x + bounds.w / 2, top: bounds.y + bounds.h + 12 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onAsk}
        disabled={asking}
        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-violet-600 transition-colors hover:bg-violet-500/10 disabled:opacity-60"
      >
        <Sparkles size={13} />
        {asking ? "解析中…" : "AI 助读"}
      </button>
      {hasText && (
        <button
          type="button"
          onClick={onToCollection}
          className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10"
        >
          <Plus size={13} />
          加入收集区
        </button>
      )}
    </div>
  );
}
