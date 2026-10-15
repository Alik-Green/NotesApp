/**
 * Global keyboard shortcuts. Tools, undo/redo, zoom, navigation and selection actions.
 * Ignores events while typing in inputs so rename/text editing keeps working.
 */

import { useEffect } from 'react';
import { useEditor } from '@/state/editorStore';
import { useSettings } from '@/state/settings';
import type { ToolKind } from '@/core/model';

export interface ShortcutHandlers {
  onShowShortcuts(): void;
  onShowSearch(): void;
  onToggleOverview(): void;
  onCopy(): void;
  onCut(): void;
  onPaste(): void;
  onDeleteSelection(): void;
  onNudge(dx: number, dy: number): void;
  onSelectAll(): void;
  onZOrder(where: 'front' | 'back' | 'forward' | 'backward'): void;
  onPrintPage?(): void;
}

const TOOL_KEYS: Record<string, ToolKind> = {
  p: 'pen',
  h: 'highlighter',
  n: 'pencil',
  e: 'eraser',
  l: 'lasso',
  t: 'text',
  s: 'shape',
  i: 'image',
  r: 'laser',
  v: 'pan',
};

export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    let spacePan = false;
    let previousTool: ToolKind | null = null;

    const isTyping = (target: EventTarget | null): boolean => {
      const element = target as HTMLElement | null;
      if (!element) return false;
      const tag = element.tagName;
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        element.isContentEditable === true
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const store = useEditor.getState();
      const modifier = event.metaKey || event.ctrlKey;

      if (isTyping(event.target)) {
        // Still allow Escape to blur text editing.
        if (event.key === 'Escape') (event.target as HTMLElement).blur();
        return;
      }

      if (event.code === 'Space' && !spacePan && !event.repeat) {
        spacePan = true;
        previousTool = store.tool;
        store.setTool('pan');
        event.preventDefault();
        return;
      }

      if (modifier) {
        switch (event.key.toLowerCase()) {
          case 'z':
            event.preventDefault();
            if (event.shiftKey) store.redo();
            else store.undo();
            return;
          case 'y':
            event.preventDefault();
            store.redo();
            return;
          case 'c':
            handlers.onCopy();
            return;
          case 'x':
            handlers.onCut();
            return;
          case 'v':
            void handlers.onPaste();
            return;
          case 'a':
            event.preventDefault();
            handlers.onSelectAll();
            return;
          case 'f':
            event.preventDefault();
            handlers.onShowSearch();
            return;
          case 'p':
            event.preventDefault();
            handlers.onToggleOverview();
            return;
          case '0':
            event.preventDefault();
            useEditor.getState().setZoom(1);
            return;
          case '=':
          case '+':
            event.preventDefault();
            store.zoomBy(1.25);
            return;
          case '-':
            event.preventDefault();
            store.zoomBy(0.8);
            return;
          case ']':
            handlers.onZOrder(event.shiftKey ? 'front' : 'forward');
            return;
          case '[':
            handlers.onZOrder(event.shiftKey ? 'back' : 'backward');
            return;
          default:
            break;
        }
        return;
      }

      switch (event.key) {
        case '?':
          handlers.onShowShortcuts();
          event.preventDefault();
          return;
        case 'Delete':
        case 'Backspace':
          if (store.selection.length) {
            handlers.onDeleteSelection();
            event.preventDefault();
          }
          return;
        case 'Escape':
          useEditor.getState().clearSelection();
          return;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          if (!store.selection.length) return;
          const step = event.shiftKey ? 10 : 1;
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
          const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
          handlers.onNudge(dx, dy);
          event.preventDefault();
          return;
        }
        case 'PageDown':
          store.requestScrollToPage(Math.min(store.currentPageIndex + 1, (store.doc?.pages.length ?? 1) - 1));
          event.preventDefault();
          return;
        case 'PageUp':
          store.requestScrollToPage(Math.max(0, store.currentPageIndex - 1));
          event.preventDefault();
          return;
        default:
          break;
      }

      const key = event.key.toLowerCase();
      if (event.shiftKey && key === 'e') {
        store.setTool('eraser-pixel');
        return;
      }
      const tool = TOOL_KEYS[key];
      if (tool) {
        store.setTool(tool);
        event.preventDefault();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && spacePan) {
        spacePan = false;
        if (previousTool) useEditor.getState().setTool(previousTool);
        previousTool = null;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handlers]);

  // Palm rejection: remember that a stylus exists for this session.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'pen') useSettings.setState({ pressureEnabled: useSettings.getState().pressureEnabled });
    };
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);
}
