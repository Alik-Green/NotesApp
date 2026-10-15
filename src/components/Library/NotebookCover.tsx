/** Cover preview for a notebook card: stored thumbnail, else a live render of page 1. */

import { useEffect, useRef, useState } from 'react';
import type { Notebook, Page } from '@/core/model';
import { drawPage } from '@/render/strokeRenderer';
import { loadFirstPage } from '@/data/repository';

export interface NotebookCoverProps {
  notebook: Notebook;
  width: number;
  height: number;
}

export function NotebookCover({ notebook, width, height }: NotebookCoverProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const first = await loadFirstPage(notebook.id);
        if (!cancelled) setPage(first);
      } catch {
        if (!cancelled) setUnsupported(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notebook.id, notebook.updatedAt, notebook.pageCount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const scale = Math.min(width / page.width, height / page.height);
    const offsetX = (width - page.width * scale) / 2;
    const offsetY = (height - page.height * scale) / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    // Subtle page shadow so the cover reads as paper.
    ctx.shadowColor = 'rgba(15,23,42,0.25)';
    ctx.shadowBlur = 8;
    ctx.fillStyle = page.paperColor;
    ctx.fillRect(offsetX, offsetY, page.width * scale, page.height * scale);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(offsetX, offsetY, page.width * scale, page.height * scale);
    ctx.clip();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    drawPage(ctx, page, { scale, includePaper: true });
    ctx.restore();
  }, [page, width, height]);

  return (
    <div
      className="flex items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-ink-200 to-ink-300 dark:from-ink-800 dark:to-ink-900"
      style={{ width, height }}
      data-testid="notebook-cover"
    >
      {unsupported ? null : <canvas ref={canvasRef} style={{ width, height }} aria-hidden="true" />}
    </div>
  );
}
