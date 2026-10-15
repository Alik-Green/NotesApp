# InkPad — implementation plan

Offline-first handwriting notebook app. No backend, no auth, everything in the browser
(IndexedDB for documents/assets, service worker for offline, file export for sharing).

## 1. File structure

```
├── index.html
├── vite.config.ts            # Vite + React + Tailwind v4 + PWA + Vitest config
├── playwright.config.ts      # e2e (preview/dev server, Chromium)
├── DECISIONS.md              # ambiguous-requirement calls + rationale
├── README.md                 # setup, architecture diagram, limitations
├── public/                   # icons, favicon (PWA manifest is generated)
├── e2e/                      # Playwright specs (draw/undo, PDF annotate+export, .inkpad io)
└── src/
    ├── main.tsx / App.tsx / index.css
    ├── core/                 # PURE TypeScript. No React, no DOM globals, unit-tested.
    │   ├── model.ts          # Notebook / Page / Object types (the data model)
    │   ├── ids.ts            # id generation
    │   ├── geometry.ts       # points, bounds, transforms, hit tests, dashes
    │   ├── spatial.ts        # rbush-backed spatial index (strokes/objects)
    │   ├── stroke.ts         # stroke outline generation (perfect-freehand), quantization
    │   ├── templates.ts      # page template geometry (lined/grid/dotted/cornell)
    │   ├── document.ts       # mutable NotebookDocument facade + z-order ops
    │   ├── commands.ts       # reversible command objects (add/erase/transform/…)
    │   ├── commandStack.ts   # undo/redo, batching, 500-command cap, serialization
    │   ├── shapeRecognition.ts # hold-to-snap: line/circle/rect/triangle
    │   ├── hitTest.ts        # object hit-testing & lasso (pure, over spatial index)
    │   ├── search.ts         # title/text search helpers
    │   ├── serialization.ts  # .inkpad zip (JSON + assets) read/write + full backup
    │   └── export/
    │       ├── pdfExport.ts  # pdf-lib: original pages preserved, ink as vector paths
    │       └── svg.ts        # shared path building for PDF/SVG output
    ├── data/
    │   ├── db.ts             # Dexie schema (notebooks, folders, pages, assets, history)
    │   ├── repository.ts     # async CRUD used by the store + import/export
    │   └── migrations.ts     # size/versioning notes, compaction of history
    ├── render/
    │   ├── pdfEngine.ts      # pdf.js facade (main thread), document cache
    │   ├── workers/pdfRender.worker.ts  # OffscreenCanvas pdf.js rasterization
    │   ├── workers/export.worker.ts     # OffscreenCanvas PNG/PDF raster export
    │   ├── strokeRenderer.ts # canvas2d drawing of strokes/objects/backgrounds
    │   └── pdfCache.ts       # LRU bitmap cache keyed by page+zoom, cancellation
    ├── input/
    │   ├── pointerRouter.ts  # pointer events → tools, gestures, palm rejection
    │   └── gestures.ts       # two/three-finger taps, pinch math
    ├── state/
    │   ├── store.ts          # zustand: library + editor UI state
    │   ├── editorStore.ts    # open notebook, pages, tool state, selection
    │   └── settings.ts       # persisted user settings (theme, palm rejection, …)
    └── components/
        ├── Library/*         # grid of notebooks/folders, search, create/rename/dup/move/delete
        ├── Editor/*          # toolbar, page canvas stack, thumbnails, outline, dialogs
        └── ui/*              # buttons, dialogs, menus, colour picker (a11y)
```

## 2. Data model (types)

```ts
type ID = string;                       // nanoid-ish, stable across export/import

Notebook   { id, title, folderId|null, template, paperColor, createdAt, updatedAt,
             pageCount, coverPageId|null, thumb?: Blob, searchText }
Folder     { id, name, parentId|null, createdAt, updatedAt }
Asset      { id, kind: 'pdf'|'image', name, mime, bytes: Blob, pageCount? }
Page       { id, notebookId, index, width, height, rotation: 0|90|180|270,
             background: {kind:'template', template} | {kind:'pdf', assetId, pdfPage},
             paperColor, objects: SceneObject[], updatedAt }
SceneObject = Stroke | TextBox | ImageObj | Shape | Sticky | PdfHighlight
  Stroke { id, type:'stroke', tool:'pen'|'highlighter'|'pencil', color, size, opacity,
           seed, points: number[] /* x,y,pressure quantized */, bbox }
  TextBox { id, type:'text', x,y,w,h, rotation, text, font, fontSize, color, link? }
  ImageObj { id, type:'image', assetId, x,y,w,h, rotation, crop?, opacity }
  Shape  { id, type:'shape', shape:'rect'|'ellipse'|'line'|'arrow', x,y,w,h, rotation,
           stroke, fill, size }
  Sticky { id, type:'sticky', x,y,w,h, rotation, text, color, fontSize }
  PdfHighlight { id, type:'highlight', x,y,w,h, page, color }
Bookmark   { id, notebookId, pageId, label, createdAt }
CommandRecord { id, notebookId, seq, kind, label, payload }   // persisted history (≤500)
```

Hierarchy: **Notebook → Page → Layers**. Layers are the four render passes per page
(background / committed ink / live ink / overlay); object z-order is array order in
`Page.objects`, so a page behaves as a single editable layer set with stable ids.

## 3. Milestones

1. Scaffold + tooling + Dexie schema + library screen with notebook CRUD.
2. Single-page canvas: pen, smoothing, pressure, pan/zoom, autosave.
3. Command stack with undo/redo; highlighter, pencil, stroke eraser.
4. Multi-page notebooks, templates, thumbnail sidebar, page management.
5. PDF import, lazy rendering, PDF export with vector ink.
6. Lasso select + transform; text boxes; images; shapes; shape recognition.
7. Pixel eraser, laser pointer, palm rejection, search, bookmarks, links.
8. PWA/offline, `.inkpad` import/export, dark mode, performance pass, e2e tests.
