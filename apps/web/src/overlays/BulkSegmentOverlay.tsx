import { useEffect, useState } from 'react';
import { createBulkJob } from '../api/bulk-jobs.js';
import { ApiError } from '../api/problem.js';
import { listRecipientLists, listTags, type RecipientList, type Tag } from '../api/segments.js';

type Props = { recipientIds: string[]; kind: 'tag' | 'list'; onClose: () => void; onCreated: () => void; onToast: (message: string) => void };

/** M2-S4 relation job launcher backed by M2-S2 master data. */
export function BulkSegmentOverlay({ recipientIds, kind, onClose, onCreated, onToast }: Props) {
  const [items, setItems] = useState<(RecipientList | Tag)[]>([]);
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void (kind === 'tag' ? listTags({ limit: 100 }) : listRecipientLists({ limit: 100 })).then((page) => setItems(page.items)).catch(() => setError('Không thể tải dữ liệu danh mục.')); }, [kind]);
  const submit = async () => {
    if (!id) { setError(`Hãy chọn ${kind === 'tag' ? 'tag' : 'danh sách'}.`); return; }
    setBusy(true); setError(null);
    try {
      const job = await createBulkJob({ action: kind === 'tag' ? 'add_tag' : 'add_list', actionPayload: kind === 'tag' ? { tagId: id } : { listId: id }, recipientIds });
      onToast(`Đã tạo job cho ${job.resolvedCount.toLocaleString('vi-VN')} người nhận.`); onCreated(); onClose();
    } catch (cause) { setError(cause instanceof ApiError ? cause.message : 'Không thể tạo job.'); } finally { setBusy(false); }
  };
  return <div className="overlay-backdrop" onMouseDown={onClose}><section role="dialog" aria-modal="true" aria-labelledby="bulk-segment-title" className="action-overlay modal-small" onMouseDown={(event) => event.stopPropagation()}><header><div><h2 id="bulk-segment-title">{kind === 'tag' ? 'Gắn tag' : 'Thêm vào danh sách'}</h2><p>Áp dụng bất đồng bộ cho {recipientIds.length.toLocaleString('vi-VN')} người nhận đã chọn.</p></div><button aria-label="Đóng cửa sổ" onClick={onClose}>×</button></header><div className="overlay-content"><label className="modal-field"><span>{kind === 'tag' ? 'Tag' : 'Danh sách'}</span><select value={id} onChange={(event) => setId(event.target.value)}><option value="">Chọn một mục</option>{items.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.memberCount} người nhận</option>)}</select></label>{items.length === 0 && !error && <p>Chưa có {kind === 'tag' ? 'tag' : 'danh sách'} nào.</p>}{error && <p className="login-error" role="alert">{error}</p>}</div><footer><button className="secondary-button" onClick={onClose}>Hủy</button><button className="primary-button" disabled={busy || !id} onClick={() => void submit()}>{busy ? 'Đang tạo job…' : 'Xác nhận'}</button></footer></section></div>;
}
