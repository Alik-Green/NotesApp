# Decisions

Where the brief left room for interpretation, this file records the simplest reasonable
choice and why. Newest entries at the bottom.

## D1 — One page = one "layer stack", object array = z-order

The brief says *Notebook → Page → Layers* and also that each page has "a list of objects with
stable IDs, z-order and transforms". Rather than modelling user-visible named layers (GoodNotes'
"layers" are an advanced feature), a page owns an ordered `objects[]` array whose index **is**
the z-order, and the renderer draws four *passes* per page (background, committed ink, live
stroke, overlay). Every object type lives in the same array, so lasso/select/erase/reorder work
uniformly across ink, text, images and shapes. Adding named layers later means making
`Page.objects` a list of layers — the commands already operate on (id, index) pairs, so the
change is contained.

## D2 — Ink stored as quantized Int16 channels, serialized as base64

Ink points are stored per stroke as `Int16Array xs`, `Int16Array ys` (document units × 8 =
1/8 pt precision, ~0.004 mm) and `Uint8Array ps` (pressure). That is 5 bytes/point in memory
and ~6.7 base64 characters/point in JSON. A3-per-page handwriting is therefore ~27 KB per
1000 points, which keeps IndexedDB small and `.inkpad` exports fast.

## D3 — PDF pages are referenced, not copied

A notebook page with a PDF background stores `{kind: 'pdf', assetId, pdfPage}` and the PDF blob
lives once in the `assets` table. Duplicating a page or moving pages therefore costs nothing,
and a 300-page PDF import writes one blob plus 300 tiny page rows. Importing a *second* PDF
into the same notebook is the one case that copies ink-only pages (see D9).

## D4 — History persisted as command data, capped at 500

The command stack keeps unlimited undo within a session and trims to the newest 500 commands.
The same 500 (plus the redo tail) are written to IndexedDB per notebook, so undo survives a
reload. Commands are persisted as plain JSON (`CommandData`) and rehydrated with
`commandFromData`; the document itself is stored separately, so a restore never replays them.

## D5 — Template backgrounds are geometry, not bitmaps

Lined/grid/dotted/Cornell backgrounds are generated from `core/templates.ts` as line/box/dot
lists and drawn as vector strokes on the canvas *and* in PDF export. Nothing raster, nothing
stored per page beyond the template name. Changing the paper colour re-renders rules with a
contrast-aware colour instead of baking a bitmap.

## D6 — Pointer routing: stylus wins, touch pans

With `penOnly: 'auto'` (default) a `pointerdown` with `pointerType === 'touch'` never draws;
it pans/zooms. Once a stylus has been seen in the session, touch input is ignored for inking
entirely; before that, a mouse or finger can still draw (so desktop and phones work).
`penOnly: 'always'` blocks finger drawing outright, `'off'` allows it. Two- and three-finger
taps are undo/redo (toggleable), which is why single-finger touch can never ink in `auto` mode
when a stylus is present.

## D7 — Live layer is a separate canvas, committed on pointerup

Drawing renders into a dedicated `live` canvas sized to the viewport with `requestAnimationFrame`
and coalesced pointer events; the in-progress stroke is rebuilt with perfect-freehand each
frame (`last: false`) and committed to the document as one `InsertObjectsCommand` on pointerup.
This keeps the committed layer untouched during a stroke (no full-page repaint per frame) and
gives the <30 ms first-pixel target on mid-range tablets.

## D8 — Shape recognition needs an explicit hold

A pause of `snapDelayMs` (default 450 ms) at the end of a stroke (pointer still down, or within
120 ms of pointerup) runs `recognizeShape`; a confident match (≥0.6) replaces the ink with a
shape object. The pause is measured from the last *movement*, not from pointerdown, so fast
handwriting is never snapped by accident. Recognition is per-stroke and undoable as one step.

## D9 — "Insert pages from another PDF" inserts after the current page

The page-details dialog lets you pick a PDF; its pages are appended as new pages right after the
current page, reusing the same asset. When the destination notebook already has that PDF as its
background, the new pages reference the original pages (ink-free) rather than duplicating ink.

## D10 — `.inkpad` is a zip; backups are a zip of zips' contents

`.inkpad` = `manifest.json` + `notebook.json` + `assets/*`. A backup uses the same container with
`kind: "backup"`, `backup.json` (folders) and `notebooks/NNNN.json`, sharing one `assets/` folder
so PDFs referenced by two notebooks are stored once. Both use `fflate` (no native code).

## D11 — Dark mode is chrome-only; paper keeps its own colour

Dark mode themes the toolbar, library and page surround. Page paper colour is a separate
notebook/page setting (default white, dark default `#1b2030`) because annotations must stay
legible when the app theme changes; PDF pages always render on white paper.

## D12 — PDF rendering: pdf.js in a worker with OffscreenCanvas when available

`render/pdfEngine.ts` keeps the pdf.js document cache on the main thread (pdf.js is fast at
metadata/outline), while page rasterization runs in `workers/pdfRender.worker.ts` using
OffscreenCanvas when the browser supports it, falling back to an in-thread canvas otherwise.
Results are cached as ImageBitmaps keyed by `assetId:page:scale-bucket` with an LRU cap, and
in-flight renders are cancelled (pdf.js `RenderTask.cancel`) when a page scrolls out of view
or the zoom bucket changes — the low-res bitmap stays visible until the crisp one is ready.

## D13 — PDF text layer for selection + search, highlight-to-annotate

Search uses pdf.js `getTextContent()` per page (cached per notebook, LRU 40 pages) instead of
scanning the raster. A transparent text layer is positioned over the crisp bitmap for
selection; the selection rectangle becomes a `HighlightObject` when the user picks
"Highlight" — exported as a filled, multiplied rectangle in the PDF.
