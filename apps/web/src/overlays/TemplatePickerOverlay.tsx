import { useEffect, useState } from 'react';
import { listTemplates, type EmailTemplateSummary } from '../api/templates.js';
import { ApiError } from '../api/problem.js';
import { TemplateThumbnail } from '../screens/templates/TemplateThumbnail.js';

/**
 * Ported from the handoff's templatePicker (action-overlays.tsx L122-125:
 * .overlay-search + .template-choice-grid). Found necessary while building
 * M4-S3's sendConfirm: without a way to attach a template to a draft, the
 * whole variable-validation/sendConfirm surface this node owns would be
 * unreachable through the real UI (M4-S1 left "Đổi template" a disabled
 * placeholder; no other node has built one). Scoped to publishing-selection
 * only, not the handoff's "Import HTML" secondary action -- that is
 * M3-S1/importHtml's own flow, already reachable from /templates directly.
 */
export function TemplatePickerOverlay({ onApply, onClose }: {
  onApply: (template: { templateId: string; templateVersionId: string }) => void;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<EmailTemplateSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    listTemplates({ status: 'published', limit: 100 })
      .then((page) => { if (!cancelled) setTemplates(page.items); })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải danh sách template.'); });
    return () => { cancelled = true; };
  }, []);

  const matches = (name: string) => !query.trim() || name.toLocaleLowerCase('vi-VN').includes(query.trim().toLocaleLowerCase('vi-VN'));
  const usable = (templates ?? []).filter((template) => template.latestVersionId !== null);

  return <div className="overlay-backdrop" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="template-picker-title" className="action-overlay" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><h2 id="template-picker-title">Chọn HTML template</h2><p>Template có thể tiếp tục chỉnh sửa sau khi chọn.</p></div>
        <button aria-label="Đóng cửa sổ" onClick={onClose}>×</button>
      </header>
      <div className="overlay-content">
        {loadError && <p className="login-error" role="alert">{loadError}</p>}
        <div className="overlay-search">⌕ <input placeholder="Tìm template" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <div className="template-choice-grid">
          {usable.filter((template) => matches(template.name)).map((template) => (
            <button key={template.id} onClick={() => { onApply({ templateId: template.id, templateVersionId: template.latestVersionId! }); onClose(); }}>
              {/* Same reasoning as the library grid: three grey bars made every
                  choice look identical, which is the one thing a picker must not
                  do. The poster stays as the fallback for a failed or oversized
                  fetch, wrapped so it keeps its inset once the thumbnail's
                  absolutely-positioned container covers the cell's padding. */}
              <span className="template-choice-preview">
                <TemplateThumbnail templateId={template.id} poster={<span className="template-choice-poster"><i /><i /><i /></span>} />
              </span>
              <div><b>{template.name}</b><small>Đã publish</small></div>
            </button>
          ))}
        </div>
        {templates !== null && usable.length === 0 && <p className="compose-variable-state">Chưa có template nào đã publish.</p>}
      </div>
      <footer>
        <button className="secondary-button" onClick={onClose}>Hủy</button>
      </footer>
    </section>
  </div>;
}
