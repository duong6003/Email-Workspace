import { useState, type Dispatch, type SetStateAction } from 'react';
import type { RecipientStatus } from '../api/recipients.js';
import type { RecipientList, Tag } from '../api/segments.js';

export type RecipientFilterState = { status: RecipientStatus[]; listIds: string[]; tagIds: string[] };

const statusOptions: { value: RecipientStatus; label: string }[] = [
  { value: 'active', label: 'Hợp lệ' },
  { value: 'paused', label: 'Tạm dừng' },
  { value: 'unsubscribed', label: 'Đã hủy đăng ký' },
  { value: 'bounced', label: 'Không gửi được' },
];

/**
 * Ported from the handoff's "recipientFilter" overlay (.filter-panel,
 * .filter-option-grid). BR-REC-008: status filter supports multiple
 * values (match-any -- selecting more than one status is a union, matching
 * "match any tra hop"). BR-SEG-007 adds list and tag membership filters
 * backed by the same tenant-scoped master-data endpoints as the form/table.
 */
export function RecipientFilterOverlay({
  value,
  lists,
  tags,
  onClose,
  onApply,
}: {
  value: RecipientFilterState;
  lists: RecipientList[];
  tags: Tag[];
  onClose: () => void;
  onApply: (next: RecipientFilterState) => void;
}) {
  const [status, setStatus] = useState<RecipientStatus[]>(value.status);
  const [listIds, setListIds] = useState<string[]>(value.listIds);
  const [tagIds, setTagIds] = useState<string[]>(value.tagIds);

  const toggle = (option: RecipientStatus) => {
    setStatus((current) => (current.includes(option) ? current.filter((item) => item !== option) : [...current, option]));
  };
  const toggleId = (id: string, setValue: Dispatch<SetStateAction<string[]>>) => {
    setValue((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="overlay-title" className="action-overlay modal-medium" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="overlay-title">Bộ lọc người nhận</h2>
            <p>Thu hẹp danh sách theo trạng thái, danh sách và tag.</p>
          </div>
          <button aria-label="Đóng cửa sổ" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="overlay-content">
          <div className="filter-panel">
            <section>
              <header>
                <b>Trạng thái nhận email</b>
              </header>
              <div className="filter-option-grid">
                {statusOptions.map((option) => (
                  <label key={option.value}>
                    <input type="checkbox" checked={status.includes(option.value)} onChange={() => toggle(option.value)} />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </section>
            {lists.length > 0 && (
              <section>
                <header><b>Thuộc danh sách</b></header>
                <div className="filter-option-grid">
                  {lists.map((list) => (
                    <label key={list.id}>
                      <input type="checkbox" checked={listIds.includes(list.id)} onChange={() => toggleId(list.id, setListIds)} />
                      <span>{list.name}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}
            {tags.length > 0 && (
              <section>
                <header><b>Có tag</b></header>
                <div className="filter-option-grid">
                  {tags.map((tag) => (
                    <label key={tag.id}>
                      <input type="checkbox" checked={tagIds.includes(tag.id)} onChange={() => toggleId(tag.id, setTagIds)} />
                      <span><i className="tag-filter-dot" style={{ background: tag.color }} />{tag.name}</span>
                    </label>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
        <footer>
          <button className="text-button" onClick={() => { setStatus([]); setListIds([]); setTagIds([]); }}>
            Đặt lại
          </button>
          <span className="footer-spacer" />
          <button className="secondary-button" onClick={onClose}>
            Hủy
          </button>
          <button className="primary-button" onClick={() => onApply({ status, listIds, tagIds })}>
            Áp dụng bộ lọc
          </button>
        </footer>
      </section>
    </div>
  );
}
