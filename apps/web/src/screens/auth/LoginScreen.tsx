import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { UiIcon } from '../../app/ui-icons.js';
import { useTheme } from '../../app/use-theme.js';
import { useInvalidateSession } from '../../auth/use-session.js';
import { ApiError, forgotPassword, login } from '../../api/auth.js';

/**
 * Ported verbatim (DOM structure + class names) from
 * design-reference/ui-handoff-v2/source/app/page.tsx L80-109's LoginScreen.
 * Only the internals change: theme is self-managed (this is now its own
 * route, not a child of a single-page Home component), and submit calls the
 * real POST /auth/login instead of a setTimeout-simulated mock.
 */
export default function LoginScreen() {
  const { theme, darkActive, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const invalidateSession = useInvalidateSession();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password.trim()) {
      setNotice('');
      setError('Vui lòng nhập đầy đủ email và mật khẩu.');
      return;
    }
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      await login({ email: email.trim(), password, remember });
      await invalidateSession();
      // The campaign list, not the composer: /campaigns/new creates a draft as
      // a side effect of being visited, so landing there would mint an empty
      // draft on every single sign-in.
      const redirectTo = location.state?.from && location.state.from !== '/login' ? location.state.from : '/campaigns';
      navigate(redirectTo, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 429) {
        setError('Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ít phút.');
      } else if (cause instanceof ApiError && cause.status === 401) {
        // BR-AUTH-001: invalid credentials always show the same generic message.
        setError('Email hoặc mật khẩu không đúng.');
      } else {
        // A backend outage or network failure is not "wrong password" -- telling the
        // user their credentials are wrong when the real cause is a system error is
        // both misleading and, for BR-AUTH-001's intent, a different failure class.
        setError('Không thể kết nối tới máy chủ. Vui lòng thử lại sau.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async () => {
    setError('');
    if (!email.trim()) {
      setNotice('');
      setError('Nhập email của bạn trước, sau đó bấm "Quên mật khẩu?" để nhận hướng dẫn khôi phục.');
      return;
    }
    try {
      await forgotPassword(email.trim());
    } finally {
      // BR-AUTH-001: identical response whether or not the address is registered.
      setNotice('Đã gửi hướng dẫn khôi phục mật khẩu tới email của bạn.');
    }
  };

  return (
    <main className={`login-shell theme-${theme} ${darkActive ? 'theme-dark' : ''}`}>
      <header className="login-topbar">
        <a className="login-brand logo-only" aria-label="MailSpace">
          <img src={darkActive ? '/mailspace-mark-dark.svg' : '/mailspace-mark.svg'} alt="MailSpace logo" />
        </a>
        <div className="login-theme" role="group" aria-label="Chọn giao diện">
          {(['light', 'system', 'dark'] as const).map((value) => (
            <button
              key={value}
              className={theme === value ? 'active' : ''}
              onClick={() => setTheme(value)}
              aria-label={value === 'light' ? 'Giao diện sáng' : value === 'dark' ? 'Giao diện tối' : 'Theo hệ thống'}
              title={value === 'light' ? 'Sáng' : value === 'dark' ? 'Tối' : 'Hệ thống'}
            >
              {value === 'light' ? '☀' : value === 'dark' ? '☾' : '◐'}
            </button>
          ))}
        </div>
      </header>
      <section className="login-layout">
        <div className="login-story">
          <div className="login-story-copy">
            <span className="login-eyebrow">
              <i /> Email operations workspace
            </span>
            <h1>
              Soạn nội dung chuẩn.
              <br />
              <em>Gửi đúng người.</em>
            </h1>
            <p>Một không gian tập trung để quản lý người nhận, template HTML và cấu hình gửi email.</p>
          </div>
          <div className="login-product-preview" aria-hidden="true">
            <div className="login-preview-head">
              <span>
                <i />
                <i />
                <i />
              </span>
              <b>email-content.html</b>
              <em>Đã sẵn sàng</em>
            </div>
            <div className="login-preview-body">
              <aside>
                <i />
                <i />
                <i />
                <i />
              </aside>
              <article>
                <span>EMAIL TEMPLATE</span>
                <h3>Chào {'{{first_name}}'},</h3>
                <p />
                <p className="short" />
                {/* Decorative only (parent is aria-hidden); tabIndex=-1 keeps it out of the tab order and off assistive tech (axe: focusable-disabled). */}
                <button tabIndex={-1}>
                  Gửi email <UiIcon name="arrowRight" size={14} />
                </button>
              </article>
              <div className="login-preview-meta">
                <span>
                  <b>128</b>
                  <small>Người nhận</small>
                </span>
                <span>
                  <b>12/12</b>
                  <small>Biến đã map</small>
                </span>
                <span>
                  <b>HTML</b>
                  <small>Template</small>
                </span>
              </div>
            </div>
          </div>
          <div className="login-trust">
            <span>
              <UiIcon name="check" size={14} /> Dữ liệu được bảo vệ
            </span>
            <span>
              <UiIcon name="check" size={14} /> Kiểm soát cấu hình gửi
            </span>
          </div>
        </div>
        <div className="login-panel">
          <form className="login-card" onSubmit={submit} noValidate>
            <header>
              <span>ĐĂNG NHẬP</span>
              <h2>Chào mừng bạn trở lại</h2>
              <p>Sử dụng tài khoản MailSpace để tiếp tục.</p>
            </header>
            <div className="login-fields">
              <label>
                <span>Email</span>
                <div className={error && !email ? 'login-input invalid' : 'login-input'}>
                  <UiIcon name="mail" size={18} />
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="name@mailspace.vn"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setError('');
                      setNotice('');
                    }}
                    autoFocus
                  />
                </div>
              </label>
              <label>
                <span>Mật khẩu</span>
                <div className={error && !password ? 'login-input invalid' : 'login-input'}>
                  <UiIcon name="lock" size={18} />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Nhập mật khẩu"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setError('');
                      setNotice('');
                    }}
                  />
                  <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}>
                    <UiIcon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
                  </button>
                </div>
              </label>
              {error && (
                <p className="login-error" role="alert">
                  <span>!</span>
                  {error}
                </p>
              )}
              {notice && (
                <p className="login-notice" role="status">
                  <span>✓</span>
                  {notice}
                </p>
              )}
              <div className="login-options">
                <label>
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                  <span>Ghi nhớ đăng nhập</span>
                </label>
                <button type="button" onClick={handleForgotPassword}>
                  Quên mật khẩu?
                </button>
              </div>
              <button className="login-submit" type="submit" disabled={submitting}>
                {submitting ? (
                  <>
                    <i className="login-spinner" /> Đang đăng nhập...
                  </>
                ) : (
                  <>
                    Đăng nhập <UiIcon name="arrowRight" size={17} />
                  </>
                )}
              </button>
            </div>
            <footer>
              <span>Chỉ dành cho người dùng được cấp quyền.</span>
              <p>
                Cần hỗ trợ? <button type="button">Liên hệ quản trị viên</button>
              </p>
            </footer>
          </form>
        </div>
      </section>
      <footer className="login-footer">
        <span>© 2026 MailSpace. All rights reserved.</span>
        <nav>
          <a>Bảo mật</a>
          <a>Điều khoản sử dụng</a>
        </nav>
      </footer>
    </main>
  );
}
