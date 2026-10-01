import { useState } from 'react';
import { ApiError } from '../api/problem.js';
import { createRecipientList, createTag, deleteRecipientList, deleteTag, tagColors, updateRecipientList, updateTag, type RecipientList, type Tag, type TagColor } from '../api/segments.js';

type ListSegment = { kind: 'list'; item?: RecipientList };
type TagSegment = { kind: 'tag'; item?: Tag };
type Segment = ListSegment | TagSegment;
type Props = { segment: Segment; onClose: () => void; onChanged: (message: string) => void };

/** Shared list/tag dialog using the approved action-overlay vocabulary. */
export function ManageSegmentOverlay({ segment, onClose, onChanged }: Props) {
  const item = segment.item;
  const listItem: RecipientList | undefined = segment.kind === 'list' ? segment.item : undefined;
  const tagItem: Tag | undefined = segment.kind === 'tag' ? segment.item : undefined;
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(listItem?.description ?? '');
  const [color, setColor] = useState<TagColor>(tagItem?.color ?? tagColors[0]);
  const [mode, setMode] = useState<'form' | 'confirm-delete'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = Boolean(item);
  const title = segment.kind === 'list' ? (isEdit ? 'Chỉnh sửa danh sách' : 'Tạo danh sách') : (isEdit ? 'Chỉnh sửa tag' : 'Tạo tag');

  const save = async () => {
    if (!name.trim()) { setError('Tên là bắt buộc.'); return; }
    setBusy(true); setError(null);
    try {
      if (segment.kind === 'list') {
        if (listItem) await updateRecipientList(listItem.id, { name, description });
        else await createRecipientList({ name, description });
      } else if (tagItem) await updateTag(tagItem.id, { name, color });
      else await createTag({ name, color });
      onChanged(isEdit ? 'Đã lưu thay đổi.' : 'Đã tạo mới.');
      onClose();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Không thể lưu thay đổi.');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    if (!item) return;
    setBusy(true); setError(null);
    try {
      if (segment.kind === 'list') await deleteRecipientList(listItem!.id); else await deleteTag(tagItem!.id);
      onChanged(segment.kind === 'list' ? 'Đã xóa danh sách; người nhận vẫn được giữ nguyên.' : 'Đã xóa tag và gỡ tag khỏi các người nhận.');
      onClose();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setError('Danh sách đang được dùng trong chiến dịch đã lên lịch nên chưa thể xóa.');
      else setError(cause instanceof ApiError ? cause.message : 'Không thể xóa.');
    } finally { setBusy(false); }
  };

  return <div className="overlay-backdrop" onMouseDown={onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="segment-overlay-title" className="action-overlay modal-small" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="segment-overlay-title">{mode === 'confirm-delete' ? `Xóa ${segment.kind === 'list' ? 'danh sách' : 'tag'}` : title}</h2><p>{mode === 'confirm-delete' ? 'Người nhận và dữ liệu tùy chỉnh không bị xóa.' : segment.kind === 'list' ? 'Nhóm người nhận được lưu để tái sử dụng.' : 'Nhãn linh động để phân loại người nhận.'}</p></div><button aria-label="Đóng cửa sổ" onClick={onClose}>×</button></header>
      <div className="overlay-content">
        {mode === 'confirm-delete' ? <p>Bạn có chắc muốn xóa <b>{item?.name}</b>? {segment.kind === 'list' && 'Nếu danh sách đang dùng bởi chiến dịch đã lên lịch, hệ thống sẽ từ chối thao tác.'}</p> : <div className="create-list-form"><label className="modal-field"><span>Tên *</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={160} /></label>{segment.kind === 'list' ? <label className="modal-field"><span>Mô tả</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></label> : <section><header><div><b>Màu tag</b><small>Màu chỉ phục vụ hiển thị.</small></div></header><div className="segment-color-picker">{tagColors.map((candidate) => <button key={candidate} type="button" aria-label={`Chọn màu ${candidate}`} aria-pressed={color === candidate} className={color === candidate ? 'active' : ''} style={{ background: candidate }} onClick={() => setColor(candidate)}>✓</button>)}</div></section>}</div>}
        {error && <p className="login-error" role="alert">{error}</p>}
      </div>
      <footer>{mode === 'confirm-delete' ? <><button className="secondary-button" onClick={() => setMode('form')}>Hủy</button><button className="danger-button" disabled={busy} onClick={() => void remove()}>{busy ? 'Đang xóa…' : 'Xóa'}</button></> : <>{isEdit && <button className="text-button danger-text" onClick={() => setMode('confirm-delete')}>Xóa</button>}<span className="footer-spacer" /><button className="secondary-button" onClick={onClose}>Hủy</button><button className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu'}</button></>}</footer>
    </section>
  </div>;
}
