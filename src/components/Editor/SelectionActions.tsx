/**
 * Floating action bar shown while objects are selected: copy, cut, paste, delete, z-order and
 * (when strokes are selected) recolour. Positioned bottom-centre above the page status.
 */

import { IconButton } from '@/components/ui/primitives';
import { ReplaceObjectsCommand } from '@/core/commands';
import type { SceneObject } from '@/core/model';
import { useEditor } from '@/state/editorStore';

export interface SelectionActionsProps {
  onCopy(): void;
  onCut(): void;
  onPaste(): void;
  onDelete(): void;
  onZOrder(where: 'front' | 'back' | 'forward' | 'backward'): void;
  hasClipboard: boolean;
}

const RECOLOUR = ['#111827', '#ef4444', '#22c55e', '#0ea5e9', '#a855f7', '#f59e0b'];

export function SelectionActions({ onCopy, onCut, onPaste, onDelete, onZOrder, hasClipboard }: SelectionActionsProps) {
  const selection = useEditor((state) => state.selection);
  const version = useEditor((state) => state.version);
  void version;

  if (selection.length === 0) {
    return hasClipboard ? (
      <div className="pointer-events-auto absolute bottom-14 left-1/2 z-20 -translate-x-1/2 rounded-full bg-white/95 px-2 py-1 shadow-panel dark:bg-ink-900/95" role="toolbar" aria-label="Clipboard">
        <IconButton label="Paste" onClick={onPaste}>
          <span aria-hidden="true">📋</span>
        </IconButton>
      </div>
    ) : null;
  }

  const recolour = (color: string) => {
    const store = useEditor.getState();
    const page = store.doc?.pages[store.currentPageIndex];
    if (!page) return;
    const before: Array<{ object: SceneObject; index: number }> = [];
    const after: Array<{ object: SceneObject; index: number }> = [];
    for (const id of store.selection) {
      const index = page.indexOf(id);
      const object = page.get(id);
      if (!object || index < 0) continue;
      before.push({ object, index });
      if (object.type === 'stroke' || object.type === 'shape' || object.type === 'text') {
        after.push({ object: { ...object, color } as SceneObject, index });
      }
    }
    if (before.length) store.commit(new ReplaceObjectsCommand(page.id, before, after, 'Recolour'));
  };

  return (
    <div
      className="pointer-events-auto absolute bottom-14 left-1/2 z-20 flex max-w-[95vw] -translate-x-1/2 flex-wrap items-center gap-1 rounded-2xl bg-white/95 px-2 py-1 shadow-panel dark:bg-ink-900/95"
      role="toolbar"
      aria-label="Selection actions"
      data-testid="selection-actions"
    >
      <span className="px-1 text-xs text-ink-500">
        {selection.length} selected
      </span>
      <IconButton label="Copy (Ctrl+C)" onClick={onCopy}>
        <span aria-hidden="true">⧉</span>
      </IconButton>
      <IconButton label="Cut (Ctrl+X)" onClick={onCut}>
        <span aria-hidden="true">✂</span>
      </IconButton>
      <IconButton label="Paste (Ctrl+V)" onClick={onPaste} disabled={!hasClipboard}>
        <span aria-hidden="true">📋</span>
      </IconButton>
      <IconButton label="Delete (Del)" onClick={onDelete}>
        <span aria-hidden="true">🗑</span>
      </IconButton>
      <IconButton label="Bring forward (Ctrl+])" onClick={() => onZOrder('forward')}>
        <span aria-hidden="true">↑</span>
      </IconButton>
      <IconButton label="Send backward (Ctrl+[)" onClick={() => onZOrder('backward')}>
        <span aria-hidden="true">↓</span>
      </IconButton>
      <IconButton label="Bring to front (Ctrl+Shift+])" onClick={() => onZOrder('front')}>
        <span aria-hidden="true">⤒</span>
      </IconButton>
      <IconButton label="Send to back (Ctrl+Shift+[)" onClick={() => onZOrder('back')}>
        <span aria-hidden="true">⤓</span>
      </IconButton>
      <span className="mx-1 hidden h-6 w-px bg-ink-200 sm:block dark:bg-ink-700" />
      {RECOLOUR.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Recolour selection ${color}`}
          className="h-8 w-8 rounded-full ring-1 ring-ink-300 dark:ring-ink-600"
          style={{ background: color }}
          onClick={() => recolour(color)}
        />
      ))}
    </div>
  );
}
