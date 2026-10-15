/** Vitest setup: fake IndexedDB + browser-ish globals for tests that need them. */

import 'fake-indexeddb/auto';

if (typeof globalThis.URL.createObjectURL !== 'function') {
  globalThis.URL.createObjectURL = () => `blob:test/${Math.random().toString(36).slice(2)}`;
  globalThis.URL.revokeObjectURL = () => undefined;
}
