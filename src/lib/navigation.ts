import { useCallback, useEffect, useState } from 'react';
import { toQueryString } from './query';

export const PAGES = ['overview', 'sessions', 'runs', 'projects', 'analytics', 'templates', 'settings'] as const;
export type Page = (typeof PAGES)[number];
export const PAGE_NAMES: Record<Page, string> = {
  overview: '개요', sessions: '세션', runs: '실행', projects: '프로젝트',
  analytics: '분석', templates: '템플릿', settings: '설정',
};

function readLocation() {
  const [path, query = ''] = window.location.hash.replace(/^#\/?/, '').split('?');
  const page: Page = PAGES.includes(path as Page) ? path as Page : 'overview';
  return { page, search: query };
}

export function useNavigation() {
  const [location, setLocation] = useState(readLocation);
  useEffect(() => {
    const update = () => setLocation(readLocation());
    window.addEventListener('hashchange', update);
    window.addEventListener('popstate', update);
    return () => {
      window.removeEventListener('hashchange', update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  const navigate = useCallback((page: Page, query: object = {}, replace = false) => {
    const search = toQueryString(query);
    const hash = `#/${page}${search ? `?${search}` : ''}`;
    if (replace) {
      window.history.replaceState(null, '', hash);
      setLocation(readLocation());
    } else if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }, []);
  return { ...location, navigate };
}
