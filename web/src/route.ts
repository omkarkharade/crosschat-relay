import { useEffect, useState } from 'react';

export type View = 'board' | 'agents' | 'activity' | 'connect';

export interface Route {
  view: View;
  /** The task open in the detail drawer, if any. */
  taskId?: string;
}

const VIEWS: View[] = ['board', 'agents', 'activity', 'connect'];

function parse(hash: string): Route {
  // Hash routes look like #/board or #/activity?task=<id>.
  const url = new URL(hash.replace(/^#/, '') || '/', 'http://dashboard');
  const path = url.pathname.replace(/^\//, '');
  // #/setup was the old name of the Connect page.
  const view = (path === 'setup' ? 'connect' : path) as View;
  const taskId = url.searchParams.get('task') ?? undefined;
  return { view: VIEWS.includes(view) ? view : 'board', ...(taskId ? { taskId } : {}) };
}

export function href(route: Route): string {
  return `#/${route.view}${route.taskId ? `?task=${encodeURIComponent(route.taskId)}` : ''}`;
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
