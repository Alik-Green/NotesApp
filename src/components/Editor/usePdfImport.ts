/**
 * PDF import: stores the PDF as an asset and creates one notebook page per PDF page, plus
 * "insert pages from another PDF" and PDF outline/bookmark extraction.
 */

import { useCallback } from 'react';
import {
  ImportAssetCommand,
  newAssetId,
  type Command,
} from '@/core/commands';
import { createPage } from '@/core/document';
import { saveOutline, putAsset } from '@/data/repository';
import { newId } from '@/core/ids';
import { useEditor } from '@/state/editorStore';
import type { AssetMeta, OutlineItem, Page } from '@/core/model';

/** pdf.js pulls in ~1 MB (plus its worker): load it only when a PDF is actually imported. */
function loadPdfEngine() {
  return import('@/render/pdfEngine');
}

export interface UsePdfImportOptions {
  onMessage?(message: string): void;
}

export function usePdfImport({ onMessage }: UsePdfImportOptions = {}) {
  /** Import a PDF as new pages after `atIndex` (defaults to the end of the notebook). */
  const importPdfPages = useCallback(
    async (file: File | Blob, name: string, atIndex?: number) => {
      const store = useEditor.getState();
      const doc = store.doc;
      if (!doc) return;
      const size = await file.size;
      if (size === 0) {
        onMessage?.('That PDF is empty');
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      const engine = await loadPdfEngine();
      let pdf;
      try {
        pdf = await engine.pdfFromBytes(bytes);
      } catch (error) {
        console.error(error);
        onMessage?.('That file could not be read as a PDF');
        return;
      }
      const pageCount = pdf.numPages;
      const firstPage = await pdf.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1 });
      const assetId = newAssetId();
      const asset: AssetMeta = {
        id: assetId,
        kind: 'pdf',
        name,
        mime: 'application/pdf',
        pageCount,
        createdAt: Date.now(),
      };
      await putAsset(asset, file instanceof File ? file : new Blob([bytes], { type: 'application/pdf' }));

      const start = atIndex ?? doc.pages.length;
      const pages: Page[] = [];
      for (let i = 0; i < pageCount; i++) {
        const page = createPage(doc.id, start + i, {
          width: viewport.width,
          height: viewport.height,
          background: { kind: 'pdf', assetId, pdfPage: i },
          paperColor: '#ffffff',
        });
        // Page sizes can differ inside one PDF; take each page's own viewport.
        if (i > 0) {
          try {
            const pdfPage = await pdf.getPage(i + 1);
            const box = pdfPage.getViewport({ scale: 1 });
            page.width = box.width;
            page.height = box.height;
          } catch {
            // Keep the first page's size when a page cannot be inspected.
          }
        }
        pages.push(page);
      }

      const outline = await extractOutline(bytes, pages, engine);

      const command: Command = new ImportAssetCommand(asset, pages, start, 'Import PDF');
      store.commit(command, { structural: true });
      if (outline.length) {
        doc.outline = outline;
        void saveOutline(doc.id, outline);
      }
      store.requestScrollToPage(start);
      await engine.destroyPdf(pdf);
      onMessage?.(`Imported ${pageCount} PDF page${pageCount === 1 ? '' : 's'}`);
    },
    [onMessage],
  );

  const importPdf = useCallback(
    async (file: File) => importPdfPages(file, file.name),
    [importPdfPages],
  );

  return { importPdf, importPdfPages };
}

/** Reads the PDF outline (bookmarks) and maps it onto the imported pages. */
async function extractOutline(
  bytes: Uint8Array,
  pages: Page[],
  engine: Awaited<ReturnType<typeof loadPdfEngine>>,
): Promise<OutlineItem[]> {
  const pdf = await engine.pdfFromBytes(bytes);
  try {
    const entries = await engine.getPdfOutline(pdf);
    const notebookId = pages[0]?.notebookId ?? '';
    return entries.map((entry) => ({
      id: newId('ol'),
      notebookId,
      pageId: entry.pageNumber ? (pages[entry.pageNumber - 1]?.id ?? null) : null,
      label: entry.title,
      depth: entry.depth,
      createdAt: Date.now(),
    }));
  } catch {
    // A malformed outline must never break the import itself.
    return [];
  } finally {
    await engine.destroyPdf(pdf);
  }
}
