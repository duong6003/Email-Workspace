import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getTemplate } from '../../api/templates.js';
import { thumbnailMode } from './template-thumbnail.js';

/** Email render width the thumbnail is laid out at before scaling. Fixed so every card shares one scale. */
const THUMBNAIL_WIDTH = 640;
const FETCH_TIMEOUT_MS = 5000;

/** Cached per template id: the grid remounts cards on search and filter, and the content does not change under it. */
const htmlCache = new Map<string, string>();

/**
 * The card's visual: the template's own HTML, rendered small.
 *
 * Loaded lazily because a library of 100 templates would otherwise open 100
 * iframes and fetch 100 bodies for the four cards on screen. Rendered in a
 * fully sandboxed frame -- `sandbox=""` grants nothing back, and the HTML was
 * sanitized on save -- which is the same containment the editor preview uses.
 */
export function TemplateThumbnail({ templateId, poster }: { templateId: string; poster: ReactNode }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(templateId) ?? null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(0);
  const observerAvailable = typeof IntersectionObserver !== 'undefined';

  // CSS cannot derive the ratio between the card and a fixed 640px layout width,
  // so the scale is measured here and re-measured when the grid reflows.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => { setScale(host.clientWidth / THUMBNAIL_WIDTH); };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const resize = new ResizeObserver(measure);
    resize.observe(host);
    return () => { resize.disconnect(); };
  }, []);

  useEffect(() => {
    if (!observerAvailable || html !== null) return;
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const timer = setTimeout(() => { if (!cancelled) setFailed(true); }, FETCH_TIMEOUT_MS);
      getTemplate(templateId)
        .then((template) => {
          clearTimeout(timer);
          // Cache before the cancelled check, never after: the grid remounts every
          // card on each search keystroke and filter change, so a response that
          // arrives just after an unmount is the common case, not the edge one.
          // Dropping it here would make the next mount refetch what already came
          // back -- the exact waste this cache exists to prevent.
          htmlCache.set(templateId, template.html);
          if (cancelled) return;
          setHtml(template.html);
        })
        .catch(() => { clearTimeout(timer); if (!cancelled) setFailed(true); });
    });
    observer.observe(host);
    return () => { cancelled = true; observer.disconnect(); };
  }, [templateId, html, observerAvailable]);

  const mode = thumbnailMode({ html, failed, observerAvailable });
  return <div className="template-thumbnail" ref={hostRef}>
    {mode === 'thumbnail' && html !== null
      ? <iframe
          className="template-thumbnail-frame"
          title=""
          aria-hidden="true"
          tabIndex={-1}
          sandbox=""
          scrolling="no"
          srcDoc={html}
          style={{ width: THUMBNAIL_WIDTH, height: THUMBNAIL_WIDTH, transform: `scale(${String(scale)})` }}
        />
      : poster}
  </div>;
}
