/** Dialog for creating a text box (and editing an existing one) at a page point. */

import { useState } from 'react';
import { Button, Dialog } from '@/components/ui/primitives';
import type { ID } from '@/core/model';

export interface TextBoxTarget {
  pageId: ID;
  x: number;
  y: number;
  /** Set when editing an existing box rather than creating one. */
  objectId?: ID;
  initialText?: string;
  initialFontSize?: number;
  initialColor?: string;
}

export interface TextBoxDialogProps {
  target: TextBoxTarget | null;
  onClose(): void;
  onCommit(
    pageId: ID,
    point: { x: number; y: number },
    text: string,
    fontSize: number,
    color: string,
  ): void;
  onEditCommit?(objectId: ID, text: string, fontSize: number, color: string): void;
}

export function TextBoxDialog({ target, onClose, onCommit, onEditCommit }: TextBoxDialogProps) {
  // The parent remounts this dialog for each target (`key`), so state initialisers are enough.
  const [text, setText] = useState(target?.initialText ?? '');
  const [fontSize, setFontSize] = useState(target?.initialFontSize ?? 18);
  const [color, setColor] = useState(target?.initialColor ?? '#111827');

  if (!target) return null;

  const submit = () => {
    const value = text.trim();
    if (!value) {
      onClose();
      return;
    }
    if (target.objectId && onEditCommit) onEditCommit(target.objectId, value, fontSize, color);
    else onCommit(target.pageId, { x: target.x, y: target.y }, value, fontSize, color);
  };

  return (
    <Dialog
      open
      title={target.objectId ? 'Edit text' : 'Add text'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} data-testid="text-commit">
            {target.objectId ? 'Save' : 'Add text'}
          </Button>
        </>
      }
    >
      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
        Text
        <textarea
          autoFocus
          value={text}
          rows={4}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
          }}
          className="rounded-lg border border-ink-200 bg-white p-2 text-sm font-normal text-ink-900 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-100"
          data-testid="text-input"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
        Font size {fontSize}
        <input
          type="range"
          min={10}
          max={72}
          value={fontSize}
          aria-label="Font size"
          onChange={(event) => setFontSize(Number(event.target.value))}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
        Colour
        <input
          type="color"
          value={color}
          aria-label="Text colour"
          onChange={(event) => setColor(event.target.value)}
          className="h-10 w-full cursor-pointer rounded"
        />
      </label>
      <p className="text-xs text-ink-500">
        Tip: select text with the lasso afterwards to add a hyperlink from the selection bar.
      </p>
    </Dialog>
  );
}
