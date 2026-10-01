import { useEffect, useState } from 'react';
import { previewCampaignAudience, type AudienceResolution, type AudienceSkipReason, type CampaignAudience } from '../api/campaigns.js';
import { listRecipientLists, listTags, type RecipientList, type Tag } from '../api/segments.js';
import { ApiError } from '../api/problem.js';

const SKIP_REASON_LABELS: Record<AudienceSkipReason, string> = {
  deleted: 'Đã xóa',
  status_paused: 'Tạm dừng',
  status_unsubscribed: 'Đã hủy đăng ký',
  status_bounced: 'Gửi thất bại (bounced)',
  excluded_by_list: 'Bị loại trừ theo danh sách',
  excluded_by_tag: 'Bị loại trừ theo tag',
  excluded_by_recipient: 'Bị loại trừ riêng lẻ',
};

type Selection = Required<Pick<CampaignAudience, 'listIds' | 'tagIds' | 'excludeListIds' | 'excludeTagIds'>>;

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

/**
 * Ported from the handoff's "recipientPicker" overlay (action-overlays.tsx
 * L106-109, modal-large): the lists/tags tabs, search box and choice-list
 * checkboxes are verbatim vocabulary. Two deliberate differences from the
 * handoff, both recorded rather than silently done:
 *
 * - The handoff's third tab, "Import Excel", is not built here. It uploads
 *   ad-hoc rows as audience members, which resolveAudience() cannot express
 *   (it operates over existing `recipient` rows via BR-SEG-008/009's
 *   list/tag/recipient sources) and no BR-SEG/BR-CMP rule names it. M2-S4's
 *   import flow already owns turning a spreadsheet into real recipients;
 *   this overlay picks from what already exists.
 * - The handoff has no exclusion affordance at all. BR-SEG-009 is one of
 *   this node's owned rules and its acceptance requires the preview to name
 *   an excluded reason, so an "Bao gồm/Loại trừ" toggle is added, reusing
 *   the handoff's own two-button `.tag-logic` vocabulary (already used
 *   elsewhere for the tag include/all-any toggle) rather than inventing a
 *   new control.
 * - The handoff's own recipient-variable-audit panel (missing-template-data
 *   warning) is deliberately not ported: that is BR-TPL (M4-S3)'s variable
 *   policy, not this node's audience resolution.
 */
export function RecipientPickerOverlay({ campaignId, audience, onApply, onClose }: {
  campaignId: string;
  audience: CampaignAudience;
  onApply: (audience: CampaignAudience) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'lists' | 'tags'>('lists');
  const [target, setTarget] = useState<'include' | 'exclude'>('include');
  const [selection, setSelection] = useState<Selection>({
    listIds: audience.listIds ?? [],
    tagIds: audience.tagIds ?? [],
    excludeListIds: audience.excludeListIds ?? [],
    excludeTagIds: audience.excludeTagIds ?? [],
  });
  const [query, setQuery] = useState('');
  const [lists, setLists] = useState<RecipientList[] | null>(null);
  const [tags, setTags] = useState<Tag[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AudienceResolution | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listRecipientLists({ limit: 100 }), listTags({ limit: 100 })])
      .then(([listPage, tagPage]) => { if (!cancelled) { setLists(listPage.items); setTags(tagPage.items); } })
      .catch((cause) => { if (!cancelled) setLoadError(cause instanceof ApiError ? cause.message : 'Không thể tải danh sách và tag.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      previewCampaignAudience(campaignId, selection)
        .then((resolution) => { if (!cancelled) { setPreview(resolution); setPreviewError(null); } })
        .catch((cause) => { if (!cancelled) setPreviewError(cause instanceof ApiError ? cause.message : 'Không thể tính người nhận.'); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [campaignId, selection]);

  const toggleList = (id: string) => setSelection((current) => target === 'include'
    ? { ...current, listIds: toggleId(current.listIds, id) }
    : { ...current, excludeListIds: toggleId(current.excludeListIds, id) });
  const toggleTag = (id: string) => setSelection((current) => target === 'include'
    ? { ...current, tagIds: toggleId(current.tagIds, id) }
    : { ...current, excludeTagIds: toggleId(current.excludeTagIds, id) });

  const matches = (name: string) => !query.trim() || name.toLocaleLowerCase('vi-VN').includes(query.trim().toLocaleLowerCase('vi-VN'));
  const checkedFor = (id: string) => target === 'include'
    ? (mode === 'lists' ? selection.listIds : selection.tagIds).includes(id)
    : (mode === 'lists' ? selection.excludeListIds : selection.excludeTagIds).includes(id);

  const apply = () => { onApply({ ...audience, ...selection }); onClose(); };

  return <div className="overlay-backdrop" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="recipient-picker-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
      <header>
        <div><h2 id="recipient-picker-title">Chọn người nhận</h2><p>Chọn nguồn người nhận và hoàn tất trong cùng một cửa sổ.</p></div>
        <button aria-label="Đóng cửa sổ" onClick={onClose}>×</button>
      </header>
      <div className="overlay-content">
        <div className="recipient-mode-tabs">
          <button className={mode === 'lists' ? 'active' : ''} onClick={() => setMode('lists')}><span>≡</span><b>Danh sách có sẵn</b></button>
          <button className={mode === 'tags' ? 'active' : ''} onClick={() => setMode('tags')}><span>#</span><b>Theo tag</b></button>
        </div>
        <div className="tag-logic">
          <span>Áp dụng lựa chọn như</span>
          <div>
            <button className={target === 'include' ? 'active' : ''} onClick={() => setTarget('include')}>Bao gồm</button>
            <button className={target === 'exclude' ? 'active' : ''} onClick={() => setTarget('exclude')}>Loại trừ</button>
          </div>
        </div>
        {loadError && <p className="login-error" role="alert">{loadError}</p>}
        <div className="recipient-mode-content">
          <div className="overlay-search">⌕ <input placeholder={mode === 'lists' ? 'Tìm danh sách người nhận' : 'Tìm tag người nhận'} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          {mode === 'lists'
            ? <div className="choice-list compact">
                {(lists ?? []).filter((list) => matches(list.name)).map((list) => (
                  <label key={list.id}>
                    <input type="checkbox" checked={checkedFor(list.id)} onChange={() => toggleList(list.id)} />
                    <span className="list-count">{list.memberCount}</span>
                    <div><b>{list.name}</b><small>{list.memberCount} người</small></div>
                  </label>
                ))}
                {lists !== null && lists.length === 0 && <p className="compose-variable-state">Chưa có danh sách người nhận nào.</p>}
              </div>
            : <div className="tag-picker-grid compact-tags">
                {(tags ?? []).filter((tag) => matches(tag.name)).map((tag) => (
                  <label key={tag.id}>
                    <input type="checkbox" checked={checkedFor(tag.id)} onChange={() => toggleTag(tag.id)} />
                    <span style={{ color: tag.color }}>#</span>
                    <div><b>{tag.name}</b><small>{tag.memberCount} người nhận</small></div>
                  </label>
                ))}
                {tags !== null && tags.length === 0 && <p className="compose-variable-state">Chưa có tag nào.</p>}
              </div>}
        </div>
        <div className="recipient-selection-summary">
          <span>Đã chọn</span>
          <b>{previewError ? previewError : preview ? `${preview.actionable} / ${preview.totalUnique} người đủ điều kiện` : 'Đang tính…'}</b>
        </div>
        {preview && preview.skippedByReason.length > 0 && (
          <div className="tag-result">
            <div><span>Bị loại</span><b>{preview.skipped} người</b></div>
            <small>{preview.skippedByReason.map((entry) => `${SKIP_REASON_LABELS[entry.reason]}: ${entry.count}`).join(' · ')}</small>
          </div>
        )}
      </div>
      <footer>
        <button className="secondary-button" onClick={onClose}>Hủy</button>
        <button className="primary-button" disabled={!preview} onClick={apply}>
          Áp dụng {preview ? `${preview.actionable} người` : ''}
        </button>
      </footer>
    </section>
  </div>;
}
