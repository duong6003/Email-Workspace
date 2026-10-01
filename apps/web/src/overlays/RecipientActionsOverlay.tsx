import { useEffect, useState } from 'react';
import { ApiError } from '../api/problem.js';
import { updateRecipient, type Recipient } from '../api/recipients.js';
import { listCustomFields, type CustomField } from '../api/customFields.js';
import { addRecipientListMembers, addTagMembers, getRecipientSegments, listRecipientLists, listTags, removeRecipientListMembers, removeTagMembers, type RecipientList, type Tag } from '../api/segments.js';
import { ModalFrame } from '../components/ModalFrame.js';

function customFieldInput(field: CustomField, value: string, onChange: (value: string) => void) {
  if (field.type === 'boolean') {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">(chưa đặt)</option>
        <option value="true">Đúng</option>
        <option value="false">Sai</option>
      </select>
    );
  }
  if (field.type === 'enum') {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">(chưa đặt)</option>
        {(field.enumOptions ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return <input type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} value={value} onChange={(event) => onChange(event.target.value)} />;
}

/**
 * Ported from the handoff's "recipientActions" overlay (small modal,
 * .action-list) plus an inline edit form reusing "addRecipient"'s field
 * vocabulary, since the handoff itself only mocks the action-list menu (no
 * real edit form exists behind "Chỉnh sửa thông tin" in the source --
 * ui_intake's mock inventory). A delete confirmation step is added because
 * BR-GEN-006 soft delete is an irreversible-from-the-UI action that the
 * handoff's own mock ("Thao tác xóa cần được xác nhận" toast on the bulk
 * bar) already signals should be confirmed.
 */
export function RecipientActionsOverlay({
  recipient,
  onClose,
  onUpdated,
}: {
  recipient: Recipient;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [firstName, setFirstName] = useState(recipient.firstName ?? '');
  const [lastName, setLastName] = useState(recipient.lastName ?? '');
  const [phone, setPhone] = useState(recipient.phone ?? '');
  const [department, setDepartment] = useState(recipient.department ?? '');
  const [title, setTitle] = useState(recipient.title ?? '');
  const [location, setLocation] = useState(recipient.location ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [lists, setLists] = useState<RecipientList[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [key, value] of Object.entries(recipient.customData ?? {})) {
      if (value !== null && value !== undefined) initial[key] = String(value);
    }
    return initial;
  });

  useEffect(() => {
    void listCustomFields()
      .then((response) => setCustomFields(response.items))
      .catch(() => setCustomFields([]));
  }, []);

  useEffect(() => {
    void Promise.all([listRecipientLists({ limit: 100 }), listTags({ limit: 100 }), getRecipientSegments(recipient.id)])
      .then(([listPage, tagPage, selected]) => {
        setLists(listPage.items);
        setTags(tagPage.items);
        setSelectedListIds(selected.lists.map((list) => list.id));
        setSelectedTagIds(selected.tags.map((tag) => tag.id));
      })
      .catch(() => undefined);
  }, [recipient.id]);

  const displayName = [recipient.firstName, recipient.lastName].filter(Boolean).join(' ').trim() || recipient.email;

  const saveEdit = async () => {
    setSubmitting(true);
    setFieldError(null);
    try {
      const customData: Record<string, unknown> = {};
      for (const field of customFields) {
        const raw = customValues[field.key];
        if (raw === undefined || raw === '') continue;
        customData[field.key] = field.type === 'number' ? Number(raw) : field.type === 'boolean' ? raw === 'true' : raw;
      }
      await updateRecipient(recipient.id, { firstName, lastName, phone, department, title, location, ...(customFields.length > 0 ? { customData } : {}) });
      const selected = await getRecipientSegments(recipient.id);
      const currentListIds = selected.lists.map((list) => list.id);
      const currentTagIds = selected.tags.map((tag) => tag.id);
      await Promise.all([
        ...selectedListIds.filter((id) => !currentListIds.includes(id)).map((id) => addRecipientListMembers(id, [recipient.id])),
        ...currentListIds.filter((id) => !selectedListIds.includes(id)).map((id) => removeRecipientListMembers(id, [recipient.id])),
        ...selectedTagIds.filter((id) => !currentTagIds.includes(id)).map((id) => addTagMembers(id, [recipient.id])),
        ...currentTagIds.filter((id) => !selectedTagIds.includes(id)).map((id) => removeTagMembers(id, [recipient.id])),
      ]);
      onUpdated();
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.message : 'Không thể lưu thay đổi.');
    } finally {
      setSubmitting(false);
    }
  };

  return <ModalFrame titleId="overlay-title" title={`Cập nhật ${displayName}`} description={recipient.email} size="medium" onClose={onClose} footer={<><button className="secondary-button" onClick={onClose}>Hủy</button><button className="primary-button" onClick={() => void saveEdit()} disabled={submitting}>{submitting ? 'Đang lưu…' : 'Xác nhận'}</button></>}>
            <div className="modal-form-grid">
              <label className="modal-field">
                <span>Họ</span>
                <input value={lastName} onChange={(event) => setLastName(event.target.value)} />
              </label>
              <label className="modal-field">
                <span>Tên</span>
                <input value={firstName} onChange={(event) => setFirstName(event.target.value)} />
              </label>
              <label className="modal-field">
                <span>Số điện thoại</span>
                <input value={phone} onChange={(event) => setPhone(event.target.value)} />
              </label>
              <label className="modal-field">
                <span>Địa điểm</span>
                <input value={location} onChange={(event) => setLocation(event.target.value)} />
              </label>
              <label className="modal-field">
                <span>Phòng ban</span>
                <input value={department} onChange={(event) => setDepartment(event.target.value)} />
              </label>
              <label className="modal-field">
                <span>Chức danh</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              {customFields.map((field) => (
                <label className="modal-field" key={field.id}>
                  <span>
                    {field.label} {field.required && <i className="required-mark">*</i>}
                  </span>
                  {customFieldInput(field, customValues[field.key] ?? '', (value) => setCustomValues((current) => ({ ...current, [field.key]: value })))}
                </label>
              ))}
              {(lists.length > 0 || tags.length > 0) && (
                <section className="full recipient-segment-editor">
                  <b>Phân loại</b>
                  <small>Danh sách và tag dùng chung dữ liệu quản trị với bộ lọc và bảng người nhận.</small>
                  <div className="recipient-classification">
                    {lists.length > 0 && <div className="classification-block"><span>Danh sách</span><div>{lists.map((list) => <label key={list.id}><input type="checkbox" checked={selectedListIds.includes(list.id)} onChange={(event) => setSelectedListIds((current) => event.target.checked ? [...current, list.id] : current.filter((id) => id !== list.id))} /><b>{list.name}</b></label>)}</div></div>}
                    {tags.length > 0 && <div className="classification-block"><span>Tag</span><div>{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={selectedTagIds.includes(tag.id)} onChange={(event) => setSelectedTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((id) => id !== tag.id))} /><i style={{ background: tag.color }} /><b>{tag.name}</b></label>)}</div></div>}
                  </div>
                </section>
              )}
              {fieldError && <p className="login-error" role="alert">{fieldError}</p>}
            </div>
  </ModalFrame>;
}
