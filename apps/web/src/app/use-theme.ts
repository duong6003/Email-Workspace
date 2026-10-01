import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

/**
 * Ported from the handoff's inline theme-restoration effect (app/page.tsx).
 * Theme/sidebar preferences are legitimate UI state and stay in
 * localStorage under their original keys — only `ecs-auth` was removed.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>('light');
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = () => setSystemDark(media.matches);
    const restorePreferences = () => {
      const savedTheme = window.localStorage.getItem('ecs-theme');
      if (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system') setThemeState(savedTheme);
      syncSystemTheme();
    };
    const animationFrame = window.requestAnimationFrame(restorePreferences);
    media.addEventListener('change', syncSystemTheme);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      media.removeEventListener('change', syncSystemTheme);
    };
  }, []);

  const setTheme = (next: Theme) => {
    setThemeState(next);
    window.localStorage.setItem('ecs-theme', next);
  };

  const darkActive = theme === 'dark' || (theme === 'system' && systemDark);
  return { theme, setTheme, darkActive };
}

export function useSidebarCollapsed() {
  const [collapsed, setCollapsedState] = useState(false);

  useEffect(() => {
    const savedSidebar = window.localStorage.getItem('ecs-sidebar');
    if (savedSidebar === 'collapsed' || savedSidebar === 'expanded') setCollapsedState(savedSidebar === 'collapsed');
  }, []);

  const setCollapsed = (next: boolean) => {
    setCollapsedState(next);
    window.localStorage.setItem('ecs-sidebar', next ? 'collapsed' : 'expanded');
  };

  return { collapsed, setCollapsed };
}
