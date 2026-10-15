# InkPad

An offline-first handwritten note-taking app for the browser: handwriting, PDF annotation and
notebook organisation, with no backend, no accounts and no network access at runtime.

> Status: all eight milestones implemented. See `PLAN.md` for the architecture and
> `DECISIONS.md` for the interpretation calls made along the way.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run build` | Type-check + production bundle (Vite, PWA service worker) |
| `npm run preview` | Serve the production build on :4173 |
| `npm run typecheck` | `tsc -b --noEmit`, strict mode |
| `npm run lint` | ESLint (flat config, includes the "core stays framework-free" rule) |
| `npm test` | Vitest unit + DOM tests |
| `npm run test:e2e` | Playwright end-to-end tests (needs `npx playwright install chromium`) |
| `npm run verify` | lint → typecheck → unit tests → build |

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│ UI (React 18 + Tailwind)                                                   │
│   components/Library/*   components/Editor/*   components/ui/*             │
└───────────────▲───────────────────────────────────────────▲────────────────┘
                │ zustand stores (libraryStore, editorStore, settings)
                │
┌───────────────┴───────────────┐            ┌──────────────┴────────────────┐
│ core/*  (pure TypeScript)     │            │ render/*                      │
│  model · geometry · spatial   │            │  strokeRenderer (canvas 2D)   │
│  stroke · hitTest · commands  │◀──────────▶│  pdfEngine + pdfCache         │
│  commandStack · templates     │            │  workers/pdfRender.worker     │
│  shapeRecognition · search    │            │  workers/export.worker        │
│  serialization · export/*     │            └──────────────▲────────────────┘
└───────────────▲───────────────┘                           │
                │                                           │
┌───────────────┴───────────────┐            ┌──────────────┴────────────────┐
│ data/*  Dexie → IndexedDB     │            │ input/*  Pointer Events,      │
│  notebooks · pages · assets   │            │  gestures, palm rejection     │
│  folders · history · settings │            └───────────────────────────────┘
└───────────────────────────────┘
```

* **Document model**: `Notebook → Page → Layers`. A page owns an ordered `objects[]`
  (stroke, text, image, shape, highlight) whose index is the z-order, plus a background
  (template or PDF page reference) and a paper colour.
* **Canvas layers per page**: background (template/PDF bitmap) → committed ink → live stroke →
  selection/UI overlay. Only the live layer repaints while drawing.
* **Spatial index**: an rbush per page (`core/spatial.ts`) backs hit-testing, lasso selection and
  both erasers.
* **Commands**: every mutation is a reversible command (`core/commands.ts`), executed through
  `CommandStack` (batching, 500-command cap, persisted per notebook).
* **Purity rule**: `src/core/**` may not import React, the DOM or the stores — enforced by an
  ESLint `no-restricted-imports`/`no-restricted-globals` block, so the whole document model is
  unit-testable in Node.
