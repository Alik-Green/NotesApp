/**
 * Autosave: debounced writes on document change, a slow heartbeat, plus saves on tab hide,
 * page hide and unload so nothing is lost when the tab closes.
 */

import { useEffect, useRef } from 'react';
import { useEditor } from '@/state/editorStore';

export interface AutosaveOptions {
  intervalMs: number;
}

export function useAutosave({ intervalMs }: AutosaveOptions): void {
  const dirtyCount = useEditor((state) => state.dirtyPageIds.size);
  const structuralDirty = useEditor((state) => state.structuralDirty);
  const version = useEditor((state) => state.version);
  const notebookId = useEditor((state) => state.notebookId);
  const timer = useRef<number | null>(null);

  // Debounced save shortly after edits stop.
  useEffect(() => {
    if (!notebookId) return;
    if (dirtyCount === 0 && !structuralDirty) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void useEditor.getState().save();
    }, Math.min(intervalMs, 1500));
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [dirtyCount, structuralDirty, version, notebookId, intervalMs]);

  // Heartbeat: catches long editing sessions where the debounce keeps being reset.
  useEffect(() => {
    if (!notebookId) return;
    const id = window.setInterval(() => {
      void useEditor.getState().save();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [notebookId, intervalMs]);

  // Save when the tab is hidden or closed.
  useEffect(() => {
    if (!notebookId) return;
    const flush = () => {
      void useEditor.getState().flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onBeforeUnload = () => {
      void useEditor.getState().save();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [notebookId]);
}
