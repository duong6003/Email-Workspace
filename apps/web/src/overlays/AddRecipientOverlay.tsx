import { useEffect, useState } from 'react';
import { ApiError } from '../api/problem.js';
import { createRecipient } from '../api/recipients.js';
import { addRecipientListMembers, addTagMembers, listRecipientLists, listTags, type RecipientList, type Tag } from '../api/segments.js';
import { listCustomFields, type CustomField } from '../api/customFields.js';

/**
 * Ported (DOM/class names) from the handoff's "addRecipient" overlay
 * (design-reference/ui-handoff-v2/source/app/action-overlays.tsx, type ===
 * "addRecipient"): modal-large, .recipient-form-sections, .modal-field
 * grid. Field set trimmed to what the M2-S1 backend actually persists
 * (list/tag assignment is M2-S2 scope) plus, as of M2-S3, a real
 * "Trường tùy chỉnh" section rendering the tenant's admin-defined custom
 * fields (BR-CF-001/002) as real typed inputs wired to customData -- the
 * EXECPLAN §8 acceptance detail "appear in the recipient form".
 */
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

export function AddRecipientOverlay({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [department, setDepartment] = useState('');
  const [title, setTitle] = useState('');
  const [allowEmail, setAllowEmail] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [lists, setLists] = useState<RecipientList[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  useEffect(() => {
    void listCustomFields()
      .then((response) => setCustomFields(response.items))
      .catch(() => setCustomFields([])); // BR-CF-002 remains enforced server-side even if this best-effort load fails.
  }, []);

  useEffect(() => {
    void Promise.all([listRecipientLists({ limit: 100 }), listTags({ limit: 100 })]).then(([listPage, tagPage]) => { setLists(listPage.items); setTags(tagPage.items); }).catch(() => undefined);
  }, []);

  const submit = async () => {
    setFieldError(null);
    if (!email.trim()) {
      setFieldError('Email là bắt buộc.');
      return;
    }
    setSubmitting(true);
    try {
      const customData: Record<string, unknown> = {};
      for (const field of customFields) {
        const raw = customValues[field.key];
        if (raw === undefined || raw === '') continue;
        customData[field.key] = field.type === 'number' ? Number(raw) : field.type === 'boolean' ? raw === 'true' : raw;
      }

      const created = await createRecipient({
        email: email.trim(),
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        phone: phone || undefined,
        department: department || undefined,
        title: title || undefined,
        location: location || undefined,
        subscriptionStatus: allowEmail ? 'active' : 'paused',
        ...(Object.keys(customData).length > 0 ? { customData } : {}),
      });
      if (selectedListIds.length) await Promise.all(selectedListIds.map((id) => addRecipientListMembers(id, [created.id])));
      if (selectedTagIds.length) await Promise.all(selectedTagIds.map((id) => addTagMembers(id, [created.id])));
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFieldError('Email này đã tồn tại trong hệ thống.');
      } else if (err instanceof ApiError) {
        setFieldError(err.message);
      } else {
        setFieldError('Không thể thêm người nhận. Vui lòng thử lại.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <section role="dialog" aria-modal="true" aria-labelledby="overlay-title" className="action-overlay modal-large" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="overlay-title">Thêm người nhận</h2>
            <p>Các trường bổ sung có thể dùng làm biến trong email.</p>
          </div>
          <button aria-label="Đóng cửa sổ" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="overlay-content">
          <div className="recipient-form-sections">
            <section>
              <header>
                <span>1</span>
                <div>
                  <b>Thông tin cơ bản</b>
                  <small>Thông tin nhận diện và liên hệ của người nhận.</small>
                </div>
              </header>
              <div className="modal-form-grid">
                <label className="modal-field">
                  <span>Họ</span>
                  <input value={lastName} onChange={(event) => setLastName(event.target.value)} placeholder="Nguyễn" />
                </label>
                <label className="modal-field">
                  <span>Tên</span>
                  <input value={firstName} onChange={(event) => setFirstName(event.target.value)} placeholder="Minh An" />
                </label>
                <label className="modal-field full">
                  <span>Email *</span>
                  <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email@company.vn" required />
                </label>
                <label className="modal-field">
                  <span>Số điện thoại</span>
                  <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="(+84) 090 123 4567" />
                </label>
                <label className="modal-field">
                  <span>Địa điểm</span>
                  <input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Hà Nội" />
                </label>
              </div>
            </section>
            <section>
              <header>
                <span>2</span>
                <div>
                  <b>Công việc</b>
                  <small>Các trường có thể dùng để cá nhân hóa nội dung.</small>
                </div>
              </header>
              <div className="modal-form-grid">
                <label className="modal-field">
                  <span>Phòng ban</span>
                  <input value={department} onChange={(event) => setDepartment(event.target.value)} placeholder="Marketing" />
                </label>
                <label className="modal-field">
                  <span>Chức danh</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Marketing Specialist" />
                </label>
              </div>
            </section>
            {customFields.length > 0 && (
              <section>
                <header>
                  <span>3</span>
                  <div>
                    <b>Trường tùy chỉnh</b>
                    <small>Định nghĩa tại Cài đặt → Trường tùy chỉnh; dùng làm biến khi soạn email.</small>
                  </div>
                </header>
                <div className="modal-form-grid">
                  {customFields.map((field) => (
                    <label className="modal-field" key={field.id}>
                      <span>
                        {field.label} {field.required && '*'}
                      </span>
                      {customFieldInput(field, customValues[field.key] ?? '', (value) => setCustomValues((current) => ({ ...current, [field.key]: value })))}
                    </label>
                  ))}
                </div>
              </section>
            )}
            {(lists.length > 0 || tags.length > 0) && <section>
              <header><span>{customFields.length > 0 ? '4' : '3'}</span><div><b>Phân loại</b><small>Một người có thể thuộc nhiều danh sách và tag.</small></div></header>
              <div className="recipient-classification">
                {lists.length > 0 && <div className="classification-block"><span>Danh sách</span><div>{lists.map((list) => <label key={list.id}><input type="checkbox" checked={selectedListIds.includes(list.id)} onChange={(event) => setSelectedListIds((current) => event.target.checked ? [...current, list.id] : current.filter((id) => id !== list.id))} /><b>{list.name}</b></label>)}</div></div>}
                {tags.length > 0 && <div className="classification-block"><span>Tag</span><div>{tags.map((tag) => <label key={tag.id}><input type="checkbox" checked={selectedTagIds.includes(tag.id)} onChange={(event) => setSelectedTagIds((current) => event.target.checked ? [...current, tag.id] : current.filter((id) => id !== tag.id))} /><i style={{ background: tag.color }} /><b>{tag.name}</b></label>)}</div></div>}
              </div>
            </section>}
          </div>
          <label className="recipient-permission">
            <input type="checkbox" checked={allowEmail} onChange={(event) => setAllowEmail(event.target.checked)} />
            <span>
              <b>Cho phép nhận email</b>
              <small>Người nhận đang hoạt động và chưa hủy đăng ký.</small>
            </span>
          </label>
          {fieldError && (
            <p className="login-error" role="alert">
              {fieldError}
            </p>
          )}
        </div>
        <footer>
          <button className="secondary-button" onClick={onClose}>
            Hủy
          </button>
          <button className="primary-button" onClick={() => void submit()} disabled={submitting}>
            {submitting ? 'Đang lưu…' : 'Thêm người nhận'}
          </button>
        </footer>
      </section>
    </div>
  );
}
