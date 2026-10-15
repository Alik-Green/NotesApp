/** Page-level cache for PDF text content (used by search and the text selection layer). */

// Type-only, so pdf.js itself stays out of the initial bundle (see the dynamic import below).
import type { PdfTextContent } from './pdfEngine';
import { getAssetBytes } from '@/data/repository';

const MAX_PAGES = 60;
const cache = new Map<string, PdfTextContent>();
const pending = new Map<string, Promise<PdfTextContent>>();

export type AssetBytesProvider = (assetId: string) => Promise<Uint8Array | null>;

/** Default provider: reads the stored blob for an asset out of IndexedDB. */
export const assetBytesProvider: AssetBytesProvider = async (assetId) => {
  const blob = await getAssetBytes(assetId);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
};

export async function getPdfTextContentCached(
  assetId: string,
  pdfPage: number,
  provider: AssetBytesProvider,
): Promise<PdfTextContent> {
  const key = `${assetId}:${pdfPage}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    const { acquirePdf, getPdfTextContent } = await import('./pdfEngine');
    const entry = await acquirePdf(assetId, () => provider(assetId));
    if (!entry) throw new Error('PDF unavailable');
    const content = await getPdfTextContent(entry.document, pdfPage + 1);
    cache.set(key, content);
    evict();
    return content;
  })();
  pending.set(key, task);
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}

function evict(): void {
  while (cache.size > MAX_PAGES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearPdfTextCache(): void {
  cache.clear();
}
