import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { describeUnsubscribe, redeemUnsubscribe, type UnsubscribeTarget } from '../../api/unsubscribe.js';

/**
 * ADR-049 -- the page a recipient lands on, and the only screen in this app
 * that is not for a user of it.
 *
 * Deliberately outside `RequireAuth` and outside `AppShell`: the person here
 * has no account, and showing them a nav rail for a workspace they cannot
 * enter would be nonsense. It is also why this screen brings its own minimal
 * styling rather than reaching for the shell's.
 *
 * **Nothing happens on load.** The page describes, and the recipient confirms.
 * Mail security scanners and link previewers issue GETs against every URL in a
 * message, so a page that unsubscribed on render would unsubscribe people whose
 * mail server merely scanned their mail. The API enforces the same split --
 * GET describes, POST acts.
 *
 * An invalid token and a deleted recipient look identical here, because the API
 * answers identically: a page that distinguished them would tell an attacker
 * which recipient ids are real.
 */
type Phase = 'loading' | 'ready' | 'done' | 'invalid' | 'failed';

export function UnsubscribeScreen() {
  const { token = '' } = useParams<{ token: string }>();
  const [phase, setPhase] = useState<Phase>('loading');
  const [target, setTarget] = useState<UnsubscribeTarget | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    describeUnsubscribe(token)
      .then((found) => {
        if (!alive) return;
        setTarget(found);
        setPhase(found.alreadyUnsubscribed ? 'done' : 'ready');
      })
      .catch(() => { if (alive) setPhase('invalid'); });
    return () => { alive = false; };
  }, [token]);

  const confirm = () => {
    setSubmitting(true);
    redeemUnsubscribe(token)
      .then((result) => { setTarget(result); setPhase('done'); })
      .catch(() => setPhase('failed'))
      .finally(() => setSubmitting(false));
  };

  return (
    <main className="unsubscribe-page">
      <div className="unsubscribe-card">
        <h1>Hủy đăng ký nhận email</h1>

        {phase === 'loading' && <p>Đang kiểm tra liên kết…</p>}

        {phase === 'invalid' && <>
          <p className="unsubscribe-bad">Liên kết này không hợp lệ hoặc đã hết hiệu lực.</p>
          <p className="unsubscribe-help">Nếu bạn vẫn muốn ngừng nhận email, hãy trả lời trực tiếp email bạn đã nhận để chúng tôi xử lý giúp bạn.</p>
        </>}

        {phase === 'ready' && target && <>
          <p>Bạn sẽ không nhận thêm email nào gửi tới <b>{target.email}</b>.</p>
          {/* The confirm step is what the scanner cannot press. */}
          <button type="button" className="unsubscribe-confirm" disabled={submitting} onClick={confirm}>
            {submitting ? 'Đang xử lý…' : 'Xác nhận hủy đăng ký'}
          </button>
          <p className="unsubscribe-help">Bấm nhầm? Đóng trang này là xong — chúng tôi chưa thay đổi gì cả.</p>
        </>}

        {phase === 'done' && target && <>
          <p className="unsubscribe-ok">Đã hủy đăng ký cho <b>{target.email}</b>.</p>
          <p className="unsubscribe-help">
            {target.alreadyUnsubscribed
              ? 'Địa chỉ này đã được hủy đăng ký từ trước, nên không có gì thay đổi thêm.'
              : 'Bạn sẽ không nhận thêm email nào từ chúng tôi nữa. Có thể mất vài phút để các email đang gửi dở dừng lại.'}
          </p>
        </>}

        {phase === 'failed' && <>
          <p className="unsubscribe-bad">Không xử lý được yêu cầu lúc này.</p>
          <p className="unsubscribe-help">Vui lòng thử lại sau ít phút, hoặc trả lời trực tiếp email bạn đã nhận.</p>
        </>}
      </div>
    </main>
  );
}
