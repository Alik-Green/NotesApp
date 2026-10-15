/** Loads image-object bitmaps for the mounted pages and exposes them to the painters. */

import { useEffect, useMemo, useState } from 'react';
import type { Page } from '@/core/model';
import { assetImageMap, ensureAssetImage } from './assetImages';

export function useAssetImages(
  pages: readonly Page[],
  visiblePageIds: readonly string[],
): Map<string, CanvasImageSource> {
  const needed = useMemo(() => {
    const ids = new Set<string>();
    const wanted = new Set(visiblePageIds);
    for (const page of pages) {
      if (!wanted.has(page.id)) continue;
      for (const object of page.objects) {
        if (object.type === 'image') ids.add(object.assetId);
      }
    }
    return [...ids].sort();
  }, [pages, visiblePageIds]);

  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let loaded = false;
      for (const assetId of needed) {
        const bitmap = await ensureAssetImage(assetId);
        if (bitmap) loaded = true;
      }
      if (loaded && !cancelled) setTick((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [needed]);

  return useMemo(() => {
    // `tick` is a deliberate cache key: decoded bitmaps arrive asynchronously, and reading it
    // here is what makes the map rebuild once they exist.
    void tick;
    return assetImageMap(needed) as Map<string, CanvasImageSource>;
  }, [needed, tick]);
}
