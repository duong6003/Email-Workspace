"use client";

import { useEffect, useState } from "react";
import ActionOverlay, { type OverlayType } from "./action-overlays";
import { UiIcon } from "./ui-icons";
import { recipientImports, recipientLists, recipientTags } from "./recipient-data";

type View = "compose" | "recipients" | "templates" | "settings" | "history";
type Theme = "light" | "dark" | "system";

const navGroups: { label?: string; items: { id: View; label: string; icon: "compose" | "drafts" | "recipients" | "templates" | "settings" | "history" }[] }[] = [
  { items: [{ id: "compose", label: "Email", icon: "compose" }] },
  { label: "QUẢN LÝ", items: [
    { id: "recipients", label: "Người nhận", icon: "recipients" },
    { id: "templates", label: "Email template", icon: "templates" },
  ] },
  { label: "HỆ THỐNG", items: [
    { id: "settings", label: "Cấu hình email", icon: "settings" },
    { id: "history", label: "Lịch sử gửi", icon: "history" },
  ] },
];

const pageMeta: Record<View, { title: string; description: string }> = {
  compose: { title: "Email", description: "Soạn nội dung mới hoặc tiếp tục các email đang lưu." },
  recipients: { title: "Người nhận", description: "Quản lý danh sách liên hệ hoặc nhập dữ liệu từ Excel." },
  templates: { title: "Email template", description: "Quản lý, chỉnh sửa và xem trước các template HTML." },
  settings: { title: "Cấu hình email", description: "Thiết lập máy chủ gửi và địa chỉ người gửi mặc định." },
  history: { title: "Lịch sử gửi", description: "Theo dõi trạng thái và kết quả của các email đã gửi." },
};

function NavIcon({ name }: { name: "compose" | "drafts" | "recipients" | "templates" | "settings" | "history" }) {
  const paths = {
    compose: <><path d="M4 19.5 8.2 18l9.9-9.9a2.1 2.1 0 0 0-3-3L5.2 15 4 19.5Z"/><path d="m13.8 6.4 3 3"/></>,
    drafts: <><path d="M5 3.5h10l4 4v13H5z"/><path d="M15 3.5v4h4M8 12h8M8 16h6"/></>,
    recipients: <><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.3-3.7 2-5.5 5.5-5.5s5.2 1.8 5.5 5.5M16 7h4M18 5v4"/></>,
    templates: <><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 8h17M8 12h8M8 16h5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z"/></>,
    history: <><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3.5 2M4.5 5.5 2.5 8"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const people = [
  { name: "Nguyễn Minh An", email: "an.nguyen@acme.vn", department: "Marketing", location: "Hà Nội", tags: ["Nhân viên mới", "Marketing", "Hà Nội"] },
  { name: "Trần Thu Hà", email: "ha.tran@acme.vn", department: "Sales", location: "TP. HCM", tags: ["Quản lý", "Nội bộ"] },
  { name: "Lê Quốc Bảo", email: "bao.le@acme.vn", department: "Product", location: "Đà Nẵng", tags: ["Nội bộ", "Đã xác minh"] },
  { name: "Phạm Ngọc Linh", email: "linh.pham@acme.vn", department: "Customer Success", location: "Hà Nội", tags: ["Ưu tiên", "Hà Nội", "Đã xác minh"] },
];

const histories = [
  { title: "Welcome onboarding · Tháng 08", recipients: 128, time: "Đang gửi · bắt đầu 14:20", status: "Đang gửi", progress: 68, sent: 87, pending: 39, failed: 2, eta: "Còn khoảng 2 phút" },
  { title: "Nhắc lịch đào tạo bảo mật", recipients: 246, time: "11/08/2026 · 08:30", status: "Đã lên lịch", progress: 0, sent: 0, pending: 246, failed: 0, eta: "Bắt đầu sau 18 giờ" },
  { title: "Thông báo lịch nghỉ 02/09", recipients: 128, time: "06/08/2026 · 14:20", status: "Đã gửi", progress: 100, sent: 126, pending: 0, failed: 2, eta: "Hoàn tất trong 3 phút 44 giây" },
  { title: "Cập nhật chính sách nội bộ", recipients: 312, time: "02/08/2026 · 16:40", status: "Có lỗi", progress: 100, sent: 298, pending: 0, failed: 14, eta: "Đã kết thúc" },
];

const drafts = [
  { title: "Chào mừng nhân viên mới", template: "Welcome onboarding.html", recipients: "Danh sách nhân viên", updated: "Vừa xong", complete: 85 },
  { title: "Bản tin nội bộ tháng 08", template: "Bản tin tháng.html", recipients: "Chưa chọn người nhận", updated: "Hôm nay · 10:24", complete: 55 },
  { title: "Thông báo cập nhật sản phẩm", template: "Thông báo sự kiện.html", recipients: "Khách hàng ưu tiên", updated: "05/08/2026", complete: 70 },
];

function Field({ label, value, full = false }: { label: string; value: string; full?: boolean }) {
  return <label className={full ? "field full" : "field"}><span>{label}</span><input defaultValue={value} /></label>;
}

function SearchBox({ placeholder }: { placeholder: string }) {
  return <div className="search-box"><UiIcon name="search"/><input placeholder={placeholder}/></div>;
}

function FilterButton({ count = 0, onClick }: { count?: number; onClick: () => void }) {
  return <button className="filter-button" onClick={onClick}><span><UiIcon name="filter" size={15}/></span>Bộ lọc{count > 0 && <em>{count}</em>}</button>;
}

function ActiveFilters({ items, onClear }: { items: string[]; onClear: () => void }) {
  if (!items.length) return null;
  return <div className="active-filter-row"><span>Đang lọc:</span>{items.map(item => <button key={item} onClick={onClear}>{item}<i>×</i></button>)}<button className="clear-filters" onClick={onClear}>Xóa tất cả</button></div>;
}

function LoginScreen({ theme, darkActive, setTheme, onLogin }: { theme: Theme; darkActive: boolean; setTheme: (theme: Theme) => void; onLogin: (remember: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      setNotice("");
      setError("Vui lòng nhập đầy đủ email và mật khẩu.");
      return;
    }
    setError("");
    setSubmitting(true);
    window.setTimeout(() => onLogin(remember), 650);
  };

  return <main className={`login-shell theme-${theme} ${darkActive ? "theme-dark" : ""}`}>
    <header className="login-topbar"><a className="login-brand logo-only" aria-label="Altasoftware"><img src="/alta-logo.png" alt="Altasoftware logo"/></a><div className="login-theme" role="group" aria-label="Chọn giao diện">{(["light","system","dark"] as const).map(value => <button key={value} className={theme === value ? "active" : ""} onClick={() => {setTheme(value);window.localStorage.setItem("ecs-theme",value);}} aria-label={value === "light" ? "Giao diện sáng" : value === "dark" ? "Giao diện tối" : "Theo hệ thống"} title={value === "light" ? "Sáng" : value === "dark" ? "Tối" : "Hệ thống"}>{value === "light" ? "☀" : value === "dark" ? "☾" : "◐"}</button>)}</div></header>
    <section className="login-layout">
      <div className="login-story"><div className="login-story-copy"><span className="login-eyebrow"><i/> Email operations workspace</span><h1>Soạn nội dung chuẩn.<br/><em>Gửi đúng người.</em></h1><p>Một không gian tập trung để quản lý người nhận, template HTML và cấu hình gửi email.</p></div><div className="login-product-preview" aria-hidden="true"><div className="login-preview-head"><span><i/><i/><i/></span><b>email-content.html</b><em>Đã sẵn sàng</em></div><div className="login-preview-body"><aside><i/><i/><i/><i/></aside><article><span>EMAIL TEMPLATE</span><h3>Chào {"{{first_name}}"},</h3><p/><p className="short"/><button>Gửi email <UiIcon name="arrowRight" size={14}/></button></article><div className="login-preview-meta"><span><b>128</b><small>Người nhận</small></span><span><b>12/12</b><small>Biến đã map</small></span><span><b>HTML</b><small>Template</small></span></div></div></div><div className="login-trust"><span><UiIcon name="check" size={14}/> Dữ liệu được bảo vệ</span><span><UiIcon name="check" size={14}/> Kiểm soát cấu hình gửi</span></div></div>
      <div className="login-panel"><form className="login-card" onSubmit={submit} noValidate><header><span>ĐĂNG NHẬP</span><h2>Chào mừng bạn trở lại</h2><p>Sử dụng tài khoản Altasoftware để tiếp tục.</p></header><div className="login-fields"><label><span>Email</span><div className={error && !email ? "login-input invalid" : "login-input"}><UiIcon name="mail" size={18}/><input type="email" autoComplete="email" placeholder="name@altasoftware.vn" value={email} onChange={event => {setEmail(event.target.value);setError("");setNotice("");}} autoFocus/></div></label><label><span>Mật khẩu</span><div className={error && !password ? "login-input invalid" : "login-input"}><UiIcon name="lock" size={18}/><input type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Nhập mật khẩu" value={password} onChange={event => {setPassword(event.target.value);setError("");setNotice("");}}/><button type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}><UiIcon name={showPassword ? "eyeOff" : "eye"} size={18}/></button></div></label>{error && <p className="login-error" role="alert"><span>!</span>{error}</p>}{notice && <p className="login-notice" role="status"><span>✓</span>{notice}</p>}<div className="login-options"><label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)}/><span>Ghi nhớ đăng nhập</span></label><button type="button" onClick={() => {setError("");setNotice("Đã gửi hướng dẫn khôi phục mật khẩu tới email của bạn.");}}>Quên mật khẩu?</button></div><button className="login-submit" type="submit" disabled={submitting}>{submitting ? <><i className="login-spinner"/> Đang đăng nhập...</> : <>Đăng nhập <UiIcon name="arrowRight" size={17}/></>}</button></div><footer><span>Chỉ dành cho người dùng được cấp quyền.</span><p>Cần hỗ trợ? <button type="button">Liên hệ quản trị viên</button></p></footer></form></div>
    </section>
    <footer className="login-footer"><span>© 2026 Altasoftware. All rights reserved.</span><nav><a>Bảo mật</a><a>Điều khoản sử dụng</a></nav></footer>
  </main>;
}

function Composer({ open }: { open: (type: OverlayType) => void }) {
  const [mode, setMode] = useState<"visual" | "html">("visual");
  const [panel, setPanel] = useState<"variables" | "preview">("variables");

  return <div className="compose-grid">
    <section className="compose-card">
      <div className="compose-fields">
        <label className="select-field"><span>Cấu hình gửi</span><button onClick={() => open("sender")}><span className="sender-dot">A</span><b>Acme People Team</b><small>people@acme.vn</small><i><UiIcon name="chevronDown" size={16}/></i></button></label>
        <label className="select-field recipient-field"><span>Người nhận</span><button onClick={() => open("recipientPicker")}><span className="list-dot">128</span><b>Danh sách nhân viên</b><small>Danh sách · 128 địa chỉ hợp lệ</small><i><UiIcon name="chevronDown" size={16}/></i></button></label>
        <Field label="CC" value="hr-leads@acme.vn" />
        <Field label="BCC" value="" />
        <Field label="Tiêu đề" value="Chào mừng {{first_name}} đến với {{company_name}}" full />
      </div>

      <div className="template-row"><div><span>HTML TEMPLATE</span><b>Welcome onboarding.html</b><small>42 KB · Đã map 12 biến</small></div><button className="secondary-button" onClick={() => open("templatePicker")}>Đổi template</button><button className="icon-action" aria-label="Import HTML" title="Import HTML" onClick={() => open("importHtml")}><UiIcon name="upload" size={17}/></button></div>

      <div className="editor-shell">
        <div className="editor-head"><div className="view-switch"><button className={mode === "visual" ? "active" : ""} onClick={() => setMode("visual")}>Trình soạn thảo</button><button className={mode === "html" ? "active" : ""} onClick={() => setMode("html")}>&lt;/&gt; HTML</button></div><span>Tự động lưu · vừa xong</span></div>
        <div className="editor-toolbar"><button><b>B</b></button><button><i>I</i></button><button><u>U</u></button><em/><button>☷</button><button>↗</button><button>▧</button><em/><button className="insert-variable">＋ Chèn biến</button><button className="toolbar-end">↶</button><button>↷</button></div>
        {mode === "html" ? <pre className="code-editor">{`<!doctype html>\n<html lang="vi">\n  <body style="font-family: Arial, sans-serif">\n    <h1>Chào {{first_name}}!</h1>\n    <p>Chào mừng bạn đến với {{company_name}}.</p>\n    <a href="{{onboarding_url}}">Bắt đầu onboarding</a>\n  </body>\n</html>`}</pre> : <div className="email-canvas"><span className="email-brand">ACME</span><h2>Chào {"{{first_name}}"}! 👋</h2><p>Chúng tôi rất vui khi bạn chính thức gia nhập <mark>{"{{company_name}}"}</mark> với vai trò <mark>{"{{job_title}}"}</mark>.</p><p>Ngày bắt đầu của bạn là <mark>{"{{start_date}}"}</mark>. Hãy xem cẩm nang để chuẩn bị cho ngày đầu tiên.</p><button>Bắt đầu onboarding →</button><small>Nếu cần hỗ trợ, vui lòng liên hệ {"{{manager_email}}"}.</small></div>}
      </div>
    </section>

    <aside className="context-panel">
      <div className="panel-switch"><button className={panel === "variables" ? "active" : ""} onClick={() => setPanel("variables")}>Biến dữ liệu</button><button className={panel === "preview" ? "active" : ""} onClick={() => setPanel("preview")}>Xem trước</button></div>
      {panel === "variables" ? <>
        <div className="panel-search"><UiIcon name="search" size={16}/><input placeholder="Tìm biến dữ liệu" /></div>
        <div className="variable-group"><span>NGƯỜI NHẬN</span>{[["Họ", "{{last_name}}"],["Tên", "{{first_name}}"],["Email", "{{email}}"],["Phòng ban", "{{department}}"],["Chức danh", "{{job_title}}"]].map(v => <button key={v[1]}><div><b>{v[0]}</b><code>{v[1]}</code></div><i>＋</i></button>)}</div>
        <div className="variable-group"><span>PHỔ THÔNG</span>{[["Tên công ty", "{{company_name}}"],["Ngày hiện tại", "{{current_date}}"],["Link hủy đăng ký", "{{unsubscribe_url}}"]].map(v => <button key={v[1]}><div><b>{v[0]}</b><code>{v[1]}</code></div><i>＋</i></button>)}</div>
        <button className="custom-variable" onClick={() => open("customVariableBuilder")}>＋ Tạo biến tùy chỉnh</button>
        <div className="mapping-status"><span>✓</span><div><b>12 / 12 biến đã map</b><small>Dữ liệu mẫu: Nguyễn Minh An</small></div></div>
      </> : <div className="mini-preview"><div className="preview-person"><span>NA</span><div><b>Nguyễn Minh An</b><small>an.nguyen@acme.vn</small></div><button aria-label="Đổi dữ liệu mẫu"><UiIcon name="chevronDown" size={16}/></button></div><div className="preview-subject"><small>TIÊU ĐỀ</small><b>Chào mừng An đến với ACME</b></div><div className="preview-content"><span className="email-brand">ACME</span><h3>Chào An! 👋</h3><p>Chúng tôi rất vui khi bạn chính thức gia nhập <b>ACME</b> với vai trò <b>Marketing Specialist</b>.</p><p>Ngày bắt đầu của bạn là <b>10/08/2026</b>.</p><button>Bắt đầu onboarding →</button><small>Nếu cần hỗ trợ, vui lòng liên hệ lan.hr@acme.vn.</small></div><button className="full-preview-button" onClick={() => open("composePreview")}><UiIcon name="expand" size={16}/> Mở bản xem trước đầy đủ</button></div>}
    </aside>
  </div>;
}

function Drafts({ open, toast, openComposer }: { open: (type: OverlayType) => void; toast: (message: string) => void; openComposer: () => void }) {
  const continueDraft = (title: string) => {toast(`Đã mở bản nháp “${title}”`);openComposer();};
  return <div className="module-card drafts-card"><div className="module-toolbar"><SearchBox placeholder="Tìm theo tiêu đề, template hoặc người nhận"/></div><div className="draft-summary"><div><b>3</b><span>Bản nháp đang lưu</span></div><p>Tất cả thay đổi được tự động lưu. Chọn một bản nháp để tiếp tục soạn.</p></div><div className="draft-list">{drafts.map((draft,index) => <article key={draft.title}><div className="draft-icon"><NavIcon name="drafts"/></div><div className="draft-main"><div><b>{draft.title}</b><span>{index === 0 && "Vừa chỉnh sửa"}</span></div><small>{draft.template} · {draft.recipients}</small><div className="draft-progress"><i style={{width:`${draft.complete}%`}}/><span>{draft.complete}% hoàn tất</span></div></div><time>{draft.updated}</time><button className="secondary-button" onClick={() => continueDraft(draft.title)}>Tiếp tục soạn</button><button className="row-menu" aria-label="Tùy chọn bản nháp" onClick={() => open("draftActions")}><UiIcon name="more" size={17}/></button></article>)}</div></div>;
}

function Recipients({ open, toast }: { open: (type: OverlayType) => void; toast: (message: string) => void }) {
  const [recipientView, setRecipientView] = useState<"all" | "lists" | "tags" | "imports">("all");
  const [selectedEmails, setSelectedEmails] = useState<string[]>([]);
  const viewLabels = { all: "Tất cả người nhận", lists: "Danh sách", tags: "Tag", imports: "Import" } as const;
  const searchPlaceholders = { all: "Tìm theo tên, email, phòng ban hoặc tag", lists: "Tìm danh sách người nhận", tags: "Tìm tag", imports: "Tìm theo tên file import" } as const;
  return <section className="workspace-module-frame standard-module-frame recipients-module">
    <header className="recipient-section-nav"><div role="tablist" aria-label="Quản lý người nhận">{(Object.keys(viewLabels) as (keyof typeof viewLabels)[]).map(key => <button role="tab" aria-selected={recipientView === key} className={recipientView === key ? "active" : ""} key={key} onClick={() => {setRecipientView(key);setSelectedEmails([]);}}>{viewLabels[key]}{key === "lists" && <span>{recipientLists.length}</span>}{key === "tags" && <span>{recipientTags.length}</span>}{key === "imports" && <span>{recipientImports.length}</span>}</button>)}</div><small>{recipientView === "lists" ? "Nhóm người nhận được lưu để tái sử dụng khi gửi email." : recipientView === "tags" ? "Nhãn linh động có thể gắn cho nhiều người nhận." : recipientView === "imports" ? "Theo dõi file, mapping và chất lượng dữ liệu đã nhập." : "Nguồn dữ liệu người nhận dùng chung của hệ thống."}</small></header>
    <header className="module-frame-toolbar standard-filter-bar"><SearchBox placeholder={searchPlaceholders[recipientView]}/>{recipientView === "all" && <><FilterButton count={1} onClick={() => open("recipientFilter")}/><button className="secondary-button" onClick={() => open("importExcel")}><UiIcon name="upload" size={16}/> Import Excel</button><button className="primary-button" onClick={() => open("addRecipient")}><UiIcon name="plus" size={16}/> Thêm người nhận</button></>}{recipientView === "lists" && <button className="primary-button" onClick={() => open("createList")}><UiIcon name="plus" size={16}/> Tạo danh sách</button>}{recipientView === "tags" && <button className="primary-button" onClick={() => open("manageTags")}><UiIcon name="plus" size={16}/> Quản lý tag</button>}{recipientView === "imports" && <button className="primary-button" onClick={() => open("importExcel")}><UiIcon name="upload" size={16}/> Import file mới</button>}</header>
    <div className="module-frame-body">
      {recipientView === "all" && <><ActiveFilters items={["Trạng thái: Hợp lệ"]} onClear={() => toast("Đã xóa bộ lọc người nhận")}/><div className="data-summary"><span><b>1.248</b> người nhận</span><span><i className="green-dot"/>1.236 hợp lệ</span><span><i className="red-dot"/>12 cần kiểm tra</span><span><b>{recipientTags.length}</b> tag đang dùng</span></div>{selectedEmails.length > 0 && <div className="recipient-bulk-bar"><span><b>{selectedEmails.length}</b> người nhận đã chọn</span><div><button onClick={() => open("manageTags")}>Gắn tag</button><button onClick={() => open("createList")}>Thêm vào danh sách</button><button onClick={() => open("bulkCustomData")}>Cập nhật dữ liệu</button><button onClick={() => toast("Đã chuẩn bị file xuất dữ liệu")}>Xuất dữ liệu</button><button className="danger-text" onClick={() => toast("Thao tác xóa cần được xác nhận")}>Xóa</button></div><button aria-label="Bỏ chọn tất cả" onClick={() => setSelectedEmails([])}>×</button></div>}<div className="table-wrap"><table><thead><tr><th><input type="checkbox" checked={selectedEmails.length === people.length} onChange={event => setSelectedEmails(event.target.checked ? people.map(person => person.email) : [])}/></th><th>HỌ TÊN</th><th>EMAIL</th><th>PHÒNG BAN</th><th>TAG</th><th>TRẠNG THÁI</th><th/></tr></thead><tbody>{people.map(person => <tr className={selectedEmails.includes(person.email) ? "is-selected" : ""} key={person.email}><td><input type="checkbox" checked={selectedEmails.includes(person.email)} onChange={event => setSelectedEmails(current => event.target.checked ? [...current,person.email] : current.filter(email => email !== person.email))}/></td><td><span className="person-avatar">{person.name.split(" ").slice(-2).map(x => x[0]).join("")}</span><b>{person.name}</b></td><td>{person.email}</td><td>{person.department}<small className="cell-subtitle">{person.location}</small></td><td><div className="recipient-tags-cell">{person.tags.slice(0,2).map(tag => <span className="recipient-tag" key={tag}># {tag}</span>)}{person.tags.length > 2 && <em>+{person.tags.length - 2}</em>}</div></td><td><span className="status success">Hợp lệ</span></td><td><button className="row-menu" aria-label={`Tùy chọn ${person.name}`} onClick={() => open("recipientActions")}><UiIcon name="more" size={17}/></button></td></tr>)}</tbody></table></div><div className="pagination"><span>Hiển thị 1–25 trong 1.248</span><div><button>‹</button><button className="active">1</button><button>2</button><button>3</button><button>›</button></div></div></>}
      {recipientView === "lists" && <div className="recipient-list-grid">{recipientLists.map((list,index) => <article key={list.name}><header><span className={`recipient-list-icon tone-${index}`}>≡</span><button className="row-menu" aria-label={`Tùy chọn ${list.name}`}><UiIcon name="more" size={17}/></button></header><h3>{list.name}</h3><p>{list.source}</p><div><span><b>{list.count}</b><small>Người nhận</small></span><span><b>{list.valid}</b><small>Hợp lệ</small></span></div><footer><small>Cập nhật {list.updated}</small><button onClick={() => {setRecipientView("all");toast(`Đang hiển thị ${list.name}`);}}>Xem thành viên <UiIcon name="arrowRight" size={14}/></button></footer></article>)}</div>}
      {recipientView === "tags" && <div className="recipient-tag-directory"><div className="tag-directory-summary"><div><b>{recipientTags.length}</b><span>Tag đang hoạt động</span></div><p>Tag là nhãn linh động. Một người có thể có nhiều tag và vẫn thuộc nhiều danh sách.</p></div><div className="tag-directory-grid">{recipientTags.map(tag => <article key={tag.name}><span style={{background:tag.color}}>#</span><div><b>{tag.name}</b><small>{tag.count} người nhận</small></div><button className="row-menu" aria-label={`Tùy chọn tag ${tag.name}`}><UiIcon name="more" size={17}/></button></article>)}</div></div>}
      {recipientView === "imports" && <div className="recipient-import-history"><div className="import-guidance"><span><UiIcon name="upload" size={18}/></span><div><b>Import có kiểm tra và mapping dữ liệu</b><small>Hỗ trợ email, thông tin cơ bản, danh sách, tag và trường tùy chỉnh.</small></div><button className="secondary-button" onClick={() => open("importExcel")}>Tải file mẫu</button></div><div className="table-wrap"><table><thead><tr><th>TÊN FILE</th><th>TỔNG DÒNG</th><th>HỢP LỆ</th><th>CẦN KIỂM TRA</th><th>THỜI GIAN</th><th>TRẠNG THÁI</th><th/></tr></thead><tbody>{recipientImports.map(item => <tr key={item.file}><td><b>{item.file}</b><small className="cell-subtitle">Excel import</small></td><td>{item.rows}</td><td>{item.valid}</td><td>{item.invalid}</td><td>{item.date}</td><td><span className={item.status === "Hoàn tất" ? "status success" : "status warning"}>{item.status}</span></td><td><button className="row-menu" aria-label={`Tùy chọn ${item.file}`}><UiIcon name="more" size={17}/></button></td></tr>)}</tbody></table></div></div>}
    </div>
  </section>;
}

function Templates({ open, toast }: { open: (type: OverlayType) => void; toast: (message: string) => void }) {
  return <section className="workspace-module-frame standard-module-frame templates-module"><header className="module-frame-toolbar standard-filter-bar"><SearchBox placeholder="Tìm email template"/><div className="pill-filter quick-filter"><button className="active">Tất cả</button><button>Đã dùng</button><button>Của tôi</button></div><FilterButton count={1} onClick={() => open("templateFilter")}/><button className="primary-button" onClick={() => open("importHtml")}><UiIcon name="upload" size={16}/> Import HTML</button></header><div className="module-frame-body"><ActiveFilters items={["Loại: HTML"]} onClear={() => toast("Đã xóa bộ lọc template")}/><div className="template-grid">{["Welcome onboarding", "Thông báo sự kiện", "Bản tin tháng", "Thông báo nội bộ"].map((name,i) => <article className="template-card" key={name}><button className={`template-preview theme-${i}`} onClick={() => open("templateDetail")} aria-label={`Xem trước template ${name}`}><small className="template-sample-label">PREVIEW · NGUYỄN MINH AN</small><span className="template-preview-brand">ACME</span><h3>{name}</h3><p>Xin chào <b>An</b>,</p><i/><i/><span className="template-hover-layer"><span>◉</span><b>Xem trước template</b><small>Bấm để xem với dữ liệu mẫu</small></span></button><div className="template-meta"><div><b>{name}</b><small>HTML · 8 biến · cập nhật 2 ngày trước</small></div><button className="row-menu" aria-label={`Tùy chọn template ${name}`} onClick={() => open("templateActions")}><UiIcon name="more" size={17}/></button></div></article>)}</div><button className="drop-zone" onClick={() => open("importHtml")}><b>Kéo thả file HTML vào đây</b><span>Hệ thống sẽ kiểm tra cấu trúc và biến dữ liệu trước khi lưu.</span></button></div></section>;
}

function Settings({ open, toast }: { open: (type: OverlayType) => void; toast: (message: string) => void }) {
  const [settingsTab, setSettingsTab] = useState<"configs" | "policy">("configs");
  const [selectedEmail, setSelectedEmail] = useState("people@acme.vn");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({ "support@acme.vn": true });
  const [dirty, setDirty] = useState(false);
  const configs = [
    { name: "SMTP công ty", sender: "Acme People Team", email: "people@acme.vn", host: "smtp.office365.com", port: "587", security: "STARTTLS", session: "TLS 1.3", status: "Đã kết nối", initial: "AP", default: true },
    { name: "Hỗ trợ khách hàng", sender: "Acme Support", email: "support@acme.vn", host: "smtp.gmail.com", port: "587", security: "STARTTLS", session: "TLS 1.3", status: "Đã kết nối", initial: "AS", default: false },
    { name: "Thông báo hệ thống", sender: "System Notification", email: "no-reply@acme.vn", host: "smtp.sendgrid.net", port: "587", security: "STARTTLS", session: "Chưa xác thực", status: "Cần xác thực", initial: "SN", default: false },
  ];
  const selected = configs.find(config => config.email === selectedEmail) ?? configs[0];
  const hasOverride = Boolean(overrides[selected.email]);
  const markDirty = () => setDirty(true);
  return <div className="settings-workspace workspace-module-frame">
    <header className="settings-topbar workspace-module-topbar"><div className="settings-tabs workspace-tabs"><button className={settingsTab === "configs" ? "active" : ""} onClick={() => setSettingsTab("configs")}>Cấu hình gửi <span>{configs.length}</span></button><button className={settingsTab === "policy" ? "active" : ""} onClick={() => setSettingsTab("policy")}>Chính sách gửi mặc định</button></div>{settingsTab === "configs" && <button className="primary-button" onClick={() => open("mailConfigForm")}><UiIcon name="plus" size={16}/> Thêm cấu hình</button>}</header>
    {settingsTab === "configs" ? <section className="config-master-detail">
      <aside className="config-master"><div className="config-master-toolbar"><SearchBox placeholder="Tìm cấu hình gửi"/><select aria-label="Lọc trạng thái"><option>Tất cả trạng thái</option><option>Đã kết nối</option><option>Cần xác thực</option></select></div><div className="config-master-list">{configs.map(config => <button key={config.email} className={`${selected.email === config.email ? "selected" : ""} ${config.status !== "Đã kết nối" ? "needs-attention" : ""}`} onClick={() => {setSelectedEmail(config.email);setDirty(false);}}><span className="config-avatar">{config.initial}</span><span className="config-master-copy"><span><b>{config.name}</b>{config.default && <em>★ Mặc định</em>}</span><small>{config.email}</small><span className="config-row-meta"><i className={config.status === "Đã kết nối" ? "online" : "warning"}/>{config.status}<strong>·</strong>{overrides[config.email] ? "Thiết lập riêng" : "Kế thừa mặc định"}</span></span><i className="master-chevron">›</i></button>)}</div><footer><span><i/>2 cấu hình hoạt động</span><button onClick={() => open("configFilter")}>Bộ lọc nâng cao</button></footer></aside>
      <article className="config-detail-panel"><header><div className="config-detail-title"><span className="config-avatar large">{selected.initial}</span><div><div><h3>{selected.name}</h3>{selected.default && <em>★ Mặc định</em>}</div><p>{selected.sender} · {selected.email}</p></div></div><div className="config-detail-actions"><button className={selected.status === "Đã kết nối" ? "connection-state connected" : "connection-state attention"} onClick={() => selected.status === "Đã kết nối" ? open("testConnection") : open("editMailConfig")}><i/>{selected.status}</button><button className="secondary-button" onClick={() => open("editMailConfig")}>Chỉnh sửa</button><button className="more-action" aria-label="Tùy chọn cấu hình" onClick={() => open("configActions")}><UiIcon name="more" size={17}/></button></div></header>{selected.status !== "Đã kết nối" && <div className="reauth-banner"><div><b>Cấu hình cần được xác thực lại</b><span>Email sẽ không được gửi bằng cấu hình này cho đến khi kết nối hoạt động.</span></div><button onClick={() => open("editMailConfig")}>Xác thực lại</button></div>}<div className="config-detail-body">
        <section className="detail-section"><header><div><h4>Người gửi và phản hồi</h4><p>Thông tin xuất hiện trong email của người nhận.</p></div></header><div className="read-only-grid"><label><span>Tên người gửi</span><b>{selected.sender}</b></label><label><span>Email người gửi</span><b>{selected.email}</b></label><label><span>Reply-to</span><b>{selected.email}</b></label><label><span>Tên đăng nhập</span><b>{selected.email}</b></label></div></section>
        <section className="detail-section"><header><div><h4>Kết nối SMTP</h4><p>Thông tin máy chủ và phiên kết nối gần nhất.</p></div><button onClick={() => open("testConnection")}>Kiểm tra kết nối</button></header><div className="read-only-grid"><label><span>Máy chủ</span><b>{selected.host}</b></label><label><span>Cổng</span><b>{selected.port}</b></label><label><span>Bảo mật cấu hình</span><b>{selected.security}</b></label><label><span>Phiên gần nhất</span><b>{selected.session}</b></label></div></section>
        <section className="detail-section policy-detail"><header><div><h4>Chính sách gửi của cấu hình</h4><p>{hasOverride ? "Các giá trị riêng đang ghi đè chính sách mặc định." : "Đang kế thừa chính sách gửi mặc định của hệ thống."}</p></div><label className="compact-switch"><input type="checkbox" checked={hasOverride} onChange={event => {setOverrides(current => ({...current,[selected.email]:event.target.checked}));markDirty();}}/><i/><span>{hasOverride ? "Thiết lập riêng" : "Kế thừa"}</span></label></header>{hasOverride ? <div className="policy-input-grid"><label><span>Email mỗi lượt</span><div><input defaultValue="100" onChange={markDirty}/><em>email</em></div></label><label><span>Khoảng nghỉ</span><div><input defaultValue="30" onChange={markDirty}/><em>giây</em></div></label><label><span>Số lần gửi lại</span><div><input defaultValue="3" onChange={markDirty}/><em>lần</em></div></label></div> : <button className="inherited-policy" onClick={() => setSettingsTab("policy")}><div><span>50 email/lượt</span><span>Nghỉ 60 giây</span><span>Gửi lại tối đa 2 lần</span></div><b>Xem chính sách mặc định →</b></button>}</section>
      </div><footer className={dirty ? "detail-savebar visible" : "detail-savebar"}><span><i/>Có thay đổi chưa lưu</span><div><button className="secondary-button" onClick={() => setDirty(false)}>Hủy thay đổi</button><button className="primary-button" onClick={() => {setDirty(false);toast("Đã lưu thay đổi cho cấu hình gửi");}}>Lưu thay đổi</button></div></footer></article>
    </section> : <section className="default-policy-panel"><header><div><h3>Chính sách gửi mặc định</h3><p>Được áp dụng cho mọi cấu hình chưa bật thiết lập riêng.</p></div><span><i/>2 trong 3 cấu hình đang kế thừa</span></header><div className="policy-notice"><span>i</span><p><b>Thay đổi có hiệu lực với các lần gửi tiếp theo</b><small>Cấu hình có thiết lập riêng sẽ không bị ảnh hưởng.</small></p></div><div className="default-policy-grid"><label><div><b>Email mỗi lượt</b><small>Giới hạn số email xử lý trong một đợt.</small></div><span><input defaultValue="50"/><em>email</em></span></label><label><div><b>Khoảng nghỉ giữa hai lượt</b><small>Giảm nguy cơ máy chủ đánh dấu gửi quá nhanh.</small></div><span><input defaultValue="60"/><em>giây</em></span></label><label><div><b>Tự động gửi lại</b><small>Chỉ áp dụng cho lỗi kết nối tạm thời.</small></div><span><input defaultValue="2"/><em>lần</em></span><input className="policy-checkbox" type="checkbox" defaultChecked/></label></div><div className="policy-scope"><header><b>Phạm vi áp dụng</b><span>2 cấu hình</span></header>{configs.filter(config => !overrides[config.email]).map(config => <div key={config.email}><span className="config-avatar">{config.initial}</span><p><b>{config.name}</b><small>{config.email}</small></p><em>Kế thừa</em></div>)}</div><footer><span>Giá trị hiện tại: 50 email/lượt · nghỉ 60 giây · gửi lại 2 lần</span><button className="primary-button" onClick={() => open("settingsSaved")}>Lưu chính sách mặc định</button></footer></section>}
  </div>;
}

function History({ open, toast }: { open: (type: OverlayType) => void; toast: (message: string) => void }) {
  return (
    <section className="workspace-module-frame standard-module-frame history-module">
      <header className="module-frame-toolbar standard-filter-bar">
        <SearchBox placeholder="Tìm theo tiêu đề hoặc người gửi"/>
        <FilterButton count={1} onClick={() => open("historyFilter")}/>
      </header>
      <div className="module-frame-body">
        <ActiveFilters items={["Thời gian: 01/08–11/08/2026"]} onClear={() => toast("Đã xóa bộ lọc lịch sử gửi")}/>
        <div className="history-live-summary">
          <span><i/>1 chiến dịch đang gửi</span>
          <span>87 email đã gửi · 39 đang chờ · 2 lỗi</span>
          <button onClick={() => open("historyDetail")}>Xem tiến độ trực tiếp</button>
        </div>
        <div className="table-wrap">
          <table className="history-table">
            <thead><tr><th>TIÊU ĐỀ</th><th>NGƯỜI NHẬN</th><th>THỜI GIAN</th><th>TIẾN ĐỘ</th><th>TRẠNG THÁI</th><th>THAO TÁC</th></tr></thead>
            <tbody>{histories.map(row => (
              <tr key={row.title} onClick={() => open("historyDetail")}>
                <td><b>{row.title}</b><small className="cell-subtitle">people@acme.vn</small></td>
                <td>{row.recipients} địa chỉ</td>
                <td>{row.time}<small className="cell-subtitle">{row.eta}</small></td>
                <td><div className={`send-progress ${row.status === "Đã lên lịch" ? "scheduled" : ""}`}><div><i style={{width:`${row.progress}%`}}/></div><span>{row.status === "Đã lên lịch" ? "Chờ gửi" : `${row.progress}%`}</span><small>{row.sent} gửi · {row.pending} chờ · {row.failed} lỗi</small></div></td>
                <td><span className={`status ${row.status === "Đã gửi" ? "success" : row.status === "Đang gửi" ? "processing" : row.status === "Đã lên lịch" ? "scheduled" : "warning"}`}>{row.status}</span></td>
                <td>{row.status === "Có lỗi" ? <button className="row-resend" onClick={(event) => {event.stopPropagation();open("resendConfirm");}}><UiIcon name="refresh" size={15}/> Gửi lại</button> : <button className="row-menu" aria-label={`Xem chi tiết ${row.title}`} onClick={(event) => {event.stopPropagation();open("historyDetail");}}><UiIcon name="more" size={17}/></button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const [view, setView] = useState<View>("compose");
  const [emailTab, setEmailTab] = useState<"compose" | "drafts">("compose");
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");
  const [systemDark, setSystemDark] = useState(false);
  const [overlay, setOverlay] = useState<OverlayType | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const meta = pageMeta[view];

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setSystemDark(media.matches);
    const restorePreferences = () => {
      const savedTheme = window.localStorage.getItem("ecs-theme");
      if (savedTheme === "light" || savedTheme === "dark" || savedTheme === "system") setTheme(savedTheme);
      const savedSidebar = window.localStorage.getItem("ecs-sidebar");
      if (savedSidebar === "collapsed" || savedSidebar === "expanded") setCollapsed(savedSidebar === "collapsed");
      setAuthenticated(window.localStorage.getItem("ecs-auth") === "true");
      syncSystemTheme();
    };
    const animationFrame = window.requestAnimationFrame(restorePreferences);
    media.addEventListener("change", syncSystemTheme);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      media.removeEventListener("change", syncSystemTheme);
    };
  }, []);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2800);
  };

  const updateSidebar = (nextCollapsed: boolean) => {
    setCollapsed(nextCollapsed);
    window.localStorage.setItem("ecs-sidebar", nextCollapsed ? "collapsed" : "expanded");
  };

  const darkActive = theme === "dark" || (theme === "system" && systemDark);

  if (!authenticated) return <LoginScreen theme={theme} darkActive={darkActive} setTheme={setTheme} onLogin={(remember) => {if (remember) window.localStorage.setItem("ecs-auth","true");setAuthenticated(true);}}/>;

  return <main className={`${collapsed ? "app-shell collapsed" : "app-shell"} theme-${theme} ${darkActive ? "theme-dark" : ""}`}>
    <aside className="sidebar">
      <div className="brand logo-only"><img src="/alta-logo.png" alt="Altasoftware logo"/></div>
      <nav>{navGroups.map((group,index) => <div className="nav-group" key={group.label ?? index}>{group.label && <span className="nav-label">{group.label}</span>}{group.items.map(item => <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => {setView(item.id);if(item.id === "compose") setEmailTab("compose");}} title={collapsed ? item.label : undefined}><i><NavIcon name={item.icon}/></i><span>{item.label}</span>{view === item.id && <em/>}</button>)}</div>)}</nav>
      <div className="sidebar-footer"><img src="/alta-logo.png" alt=""/><p>© 2026 Altasoftware<br/><span>All rights reserved.</span></p></div>
    </aside>
    <button className="sidebar-edge-handle" aria-expanded={!collapsed} aria-label={collapsed ? "Mở rộng thanh điều hướng" : "Thu gọn thanh điều hướng"} title={collapsed ? "Mở rộng thanh điều hướng" : "Thu gọn thanh điều hướng"} onClick={() => updateSidebar(!collapsed)}><UiIcon name={collapsed ? "chevronRight" : "chevronLeft"} size={16}/></button>

    <header className="utility-bar"><button className="global-search" onClick={() => setOverlay("command")}><UiIcon name="search" size={17}/><span>Tìm kiếm trong ứng dụng</span><kbd>⌘ K</kbd></button><div className="utility-actions"><span className="save-state"><i/>{view === "compose" ? "Đã tự động lưu" : "Đã đồng bộ"}</span><button aria-label="Mở trợ giúp" title="Trợ giúp" onClick={() => setOverlay("help")}><UiIcon name="help" size={18}/></button><button className="notification-trigger" aria-label="Mở thông báo, có 3 thông báo chưa đọc" title="Thông báo" onClick={() => setOverlay("notifications")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 8h18c0-1-3-1-3-8Z"/><path d="M10 20h4"/></svg><em/></button><button className="profile" onClick={() => setOverlay("profile")}><span>DC</span><div><b>Developer C</b><small>Administrator</small></div><i><UiIcon name="chevronDown" size={15}/></i></button></div></header>

    <section className="workspace">
      <div className="page-header"><div><h1>{meta.title}</h1><p>{meta.description}</p></div>{view === "compose" && emailTab === "compose" && <div className="page-actions"><button className="soft-button" onClick={() => setOverlay("sendTest")}>Gửi thử</button><button className="secondary-button" onClick={() => setOverlay("scheduleSend")}>Hẹn giờ gửi</button><button className="primary-button" onClick={() => setOverlay("sendConfirm")}>Gửi ngay</button></div>}</div>
      <div className="content-stage">
        {view === "compose" && <section className="email-workspace-frame workspace-module-frame"><header className="workspace-module-topbar"><div className="email-workspace-tabs workspace-tabs"><button className={emailTab === "compose" ? "active" : ""} onClick={() => setEmailTab("compose")}><NavIcon name="compose"/><span>Soạn email</span></button><button className={emailTab === "drafts" ? "active" : ""} onClick={() => setEmailTab("drafts")}><NavIcon name="drafts"/><span>Bản nháp</span><em>{drafts.length}</em></button></div>{emailTab === "drafts" && <button className="primary-button" onClick={() => setEmailTab("compose")}><UiIcon name="plus" size={16}/> Soạn email mới</button>}</header><div className="email-workspace-body">{emailTab === "compose" ? <Composer open={setOverlay}/> : <Drafts open={setOverlay} toast={showToast} openComposer={() => setEmailTab("compose")}/>}</div></section>}
        {view === "recipients" && (
          <Recipients open={setOverlay} toast={showToast}/>
        )}
        {view === "templates" && (
          <Templates open={setOverlay} toast={showToast}/>
        )}
        {view === "settings" && <Settings open={setOverlay} toast={showToast}/>}
        {view === "history" && (
          <History open={setOverlay} toast={showToast}/>
        )}
      </div>
      <footer className="app-footer"><nav><a>Hướng dẫn</a><a>Bảo mật</a><a>Điều khoản</a></nav></footer>
    </section>
    {overlay && (
      <ActionOverlay type={overlay} close={() => setOverlay(null)} transition={setOverlay} toast={showToast} theme={theme} setTheme={(nextTheme) => {setTheme(nextTheme);window.localStorage.setItem("ecs-theme",nextTheme);}} sidebarMode={collapsed ? "collapsed" : "expanded"} setSidebarMode={(mode) => updateSidebar(mode === "collapsed")} openDrafts={() => {setView("compose");setEmailTab("drafts");setOverlay(null);}} logout={() => {window.localStorage.removeItem("ecs-auth");setOverlay(null);setAuthenticated(false);}}/>
    )}
    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </main>;
}
