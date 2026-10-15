/** Minimal hash router: `#/` = library, `#/n/<notebookId>` = editor. */

import { useEffect, useState } from 'react';

export type Route = { name: 'library' } | { name: 'notebook'; id: string };

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts[0] === 'n' && parts[1]) return { name: 'notebook', id: decodeURIComponent(parts[1]) };
  return { name: 'library' };
}

export function routeToHash(route: Route): string {
  return route.name === 'library' ? '#/' : `#/n/${encodeURIComponent(route.id)}`;
}

export function navigate(route: Route): void {
  const hash = routeToHash(route);
  if (window.location.hash !== hash) window.location.hash = hash;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
