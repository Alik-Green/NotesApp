/**
 * Notebook search: matches the notebook title, text boxes/sticky notes and (for PDF-backed
 * pages) the PDF text layer, with page navigation and highlight-to-annotate.
 */

import { useEffect, useRef, useState } from 'react';
import { Dialog, Button } from '@/components/ui/primitives';
import type { HighlightObject, ID } from '@/core/model';
import { findMatches } from '@/core/search';
import { newId } from '@/core/ids';
import { InsertObjectsCommand } from '@/core/commands';
import { useEditor } from '@/state/editorStore';
import { assetBytesProvider, getPdfTextContentCached } from '@/render/pdfTextCache';

export interface SearchPanelProps {
  open: boolean;
  onClose(): void;
  onJump(pageIndex: number): void;
}

interface SearchHit {
  pageIndex: number;
  pageId: ID;
  label: string;
  /** Page-space rectangle to jump to / highlight (nil for text objects). */
  rect?: { x: number; y: number; w: number; h: number };
  snippet: string;
  kind: 'text' | 'pdf' | 'title';
}

export function SearchPanel({ open, onClose, onJump }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const version = useEditor((state) => state.version);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    const doc = useEditor.getState().doc;
    if (!doc) return;
    const term = query.trim();
    const current = ++requestId.current;
    // Debounced so the effect body itself never calls setState (and fast typing cancels the
    // previous search instead of racing it).
    const timer = window.setTimeout(() => {
      void (async () => {
        if (term.length < 2) {
          setHits([]);
          setSearching(false);
          return;
        }
        setSearching(true);
        const found: SearchHit[] = [];
        doc.pages.forEach((pageModel, pageIndex) => {
          const page = pageModel.data;
          // Text objects
          for (const object of page.objects) {
            if (object.type !== 'text') continue;
            if (object.text.toLowerCase().includes(term.toLowerCase())) {
              found.push({
                pageIndex,
                pageId: page.id,
                label: `Page ${pageIndex + 1}`,
                snippet: object.text.slice(0, 120),
                rect: { x: object.x, y: object.y, w: object.w, h: object.h },
                kind: 'text',
              });
            }
          }
        });

        // PDF text layer (only for pages backed by a PDF)
        const pdfPages = doc.pages
          .map((pageModel, pageIndex) => ({ pageModel, pageIndex }))
          .filter((entry) => entry.pageModel.data.background.kind === 'pdf');
        for (const { pageModel, pageIndex } of pdfPages) {
          const background = pageModel.data.background;
          if (background.kind !== 'pdf') continue;
          try {
            const content = await getPdfTextContentCached(
              background.assetId,
              background.pdfPage,
              assetBytesProvider,
            );
            if (requestId.current !== current) return;
            const matches = findMatches(content.text, term, 5);
            for (const match of matches) {
              found.push({
                pageIndex,
                pageId: pageModel.data.id,
                label: `Page ${pageIndex + 1} · PDF`,
                snippet: content.text.slice(Math.max(0, match.start - 40), match.end + 40),
                kind: 'pdf',
              });
            }
          } catch {
            // Ignore pages whose PDF text cannot be read.
          }
        }

        if (requestId.current !== current) return;
        setHits(found.slice(0, 80));
        setSearching(false);
      })();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, open, version]);

  const highlight = (hit: SearchHit) => {
    if (!hit.rect) return;
    const store = useEditor.getState();
    const page = store.doc?.pages[hit.pageIndex];
    if (!page) return;
    const object: HighlightObject = {
      type: 'highlight',
      id: newId('hl'),
      ...hit.rect,
      color: '#fde047',
      opacity: 0.45,
    };
    store.commit(
      new InsertObjectsCommand(page.id, [{ object, index: page.objects.length }], 'Highlight'),
    );
  };

  return (
    <Dialog
      open={open}
      title="Search notebook"
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <input
        autoFocus
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search text, handwriting notes and PDF text…"
        aria-label="Search query"
        className="h-11 rounded-lg border border-ink-200 bg-white px-3 text-sm dark:border-ink-700 dark:bg-ink-800"
        data-testid="search-input"
      />
      <div className="max-h-[50vh] overflow-y-auto" data-testid="search-results">
        {searching ? <p className="p-2 text-xs text-ink-500">Searching…</p> : null}
        {!searching && query.trim().length >= 2 && hits.length === 0 ? (
          <p className="p-2 text-xs text-ink-500">No matches found.</p>
        ) : null}
        <ul className="flex flex-col gap-1">
          {hits.map((hit, index) => (
            <li
              key={`${hit.pageId}-${index}`}
              className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              <button
                type="button"
                className="h-11 flex-1 text-left text-sm"
                onClick={() => {
                  onJump(hit.pageIndex);
                  onClose();
                }}
              >
                <span className="mr-2 text-xs text-ink-500">{hit.label}</span>
                <span className="line-clamp-2 text-ink-700 dark:text-ink-200">{hit.snippet}</span>
              </button>
              {hit.rect ? (
                <Button
                  size="sm"
                  onClick={() => {
                    highlight(hit);
                    onJump(hit.pageIndex);
                    onClose();
                  }}
                >
                  Highlight
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
