import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationRealtimePatch,
  resolveNotificationDeepLink,
  updateNotificationActionState,
  type Notification,
} from '../api/notifications.js';
import { shouldRefetchOnReconnect, useRealtimeStatus, type RealtimeStatus } from '../api/realtime-status.js';

export function NotificationPopover({ onClose, onUnreadChange }: { onClose: () => void; onUnreadChange: (count: number) => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<'all'|'unread'>('all');
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [unread, setUnread] = useState(0);
  const [safeState, setSafeState] = useState<string | null>(null);
  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const result = await listNotifications(filter === 'unread');
      setItems(result.items);
      setUnread(result.unread);
      if (filter === 'all') setTotalCount(result.items.length);
      onUnreadChange(result.unread);
    } catch {
      setSafeState('Không thể đồng bộ thông báo. Vui lòng thử lại.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [filter, onUnreadChange]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const reconcile = (event: Event) => {
      const patch = notificationRealtimePatch((event as CustomEvent<unknown>).detail);
      if (patch?.actionState) {
        setItems((current) => current.map((item) => item.id === patch.notificationId ? { ...item, actionState: patch.actionState! } : item));
      }
      void refresh(true);
    };
    window.addEventListener('eow:notification-reconcile', reconcile);
    return () => window.removeEventListener('eow:notification-reconcile', reconcile);
  }, [refresh]);

  const realtimeStatus = useRealtimeStatus();
  const previousStatus = useRef<RealtimeStatus | null>(null);
  useEffect(() => {
    if (shouldRefetchOnReconnect(previousStatus.current, realtimeStatus)) void refresh(true);
    previousStatus.current = realtimeStatus;
  }, [realtimeStatus, refresh]);

  const visible = useMemo(() => filter === 'unread' ? items.filter((item) => !item.readAt) : items, [filter, items]);
  const readOne = async (item: Notification) => {
    if (!item.readAt) {
      await markNotificationRead(item.id);
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
      setUnread((current) => { const next = Math.max(0, current - 1); onUnreadChange(next); return next; });
    }
    if (!item.deepLinkRoute) return;
    const target = await resolveNotificationDeepLink(item.id);
    if (target.state === 'available') { onClose(); navigate(target.route); return; }
    setSafeState(target.reason === 'permission_revoked' ? 'Bạn không còn quyền truy cập nội dung này.' : 'Nội dung được thông báo không còn khả dụng.');
  };
  const readAll = async () => {
    await markAllNotificationsRead();
    setItems((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })));
    setUnread(0);
    onUnreadChange(0);
  };
  const changeActionState = async (item: Notification) => {
    const nextState = item.actionState === 'resolved' ? 'open' : 'resolved';
    setActionBusyId(item.id);
    setSafeState(null);
    try {
      await updateNotificationActionState(item.id, nextState);
      setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, actionState: nextState } : entry));
    } catch {
      setSafeState('Không thể cập nhật trạng thái hành động. Vui lòng thử lại.');
    } finally {
      setActionBusyId(null);
    }
  };

  return <div className="overlay-backdrop notification-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="action-overlay notification-popover" aria-label="Trung tâm thông báo">
      <header><div><h2>Thông báo</h2><p>Cập nhật mới nhất cho không gian làm việc</p></div><button onClick={onClose} aria-label="Đóng thông báo">×</button></header>
      <div className="overlay-content"><div className="notification-center">
        {realtimeStatus === 'reconnecting' && <p className="login-error" role="status">Đang kết nối lại…</p>}
        <div className="notification-toolbar"><div role="tablist" aria-label="Lọc thông báo"><button className={filter === 'all' ? 'active' : ''} onClick={() => { setSafeState(null); setFilter('all'); }}>Tất cả <span>{totalCount}</span></button><button className={filter === 'unread' ? 'active' : ''} onClick={() => { setSafeState(null); setFilter('unread'); }}>Chưa đọc <span>{unread}</span></button></div><button className="mark-read-button" disabled={!unread} onClick={() => void readAll()}>Đánh dấu đã đọc</button></div>
        {safeState && <p className="notification-inline-error" role="alert">{safeState}</p>}
        <div className="notification-list">{loading ? <div className="notification-empty"><b>Đang tải thông báo…</b></div> : visible.length ? visible.map((item) => <article className={`notification-card ${item.readAt ? 'is-read' : 'is-unread'}`} key={item.id}>
          <button className="notification-open-button" onClick={() => void readOne(item)}>
            <span className={`notification-icon ${item.severity}`} aria-hidden="true">{item.severity === 'critical' ? '!' : item.severity === 'success' ? '✓' : '•'}</span>
            <span className="notification-copy"><span><b>{item.title}</b>{!item.readAt && <i aria-label="Chưa đọc" />}</span><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString('vi-VN')}</small></span><em>›</em>
          </button>
          <footer><span className={`notification-action-state ${item.actionState}`}>{item.actionState === 'resolved' ? 'Đã xử lý' : item.actionState === 'expired' ? 'Đã hết hạn' : 'Cần xử lý'}</span>{item.actionState !== 'expired' && <button className="text-button" disabled={actionBusyId === item.id} onClick={() => void changeActionState(item)}>{actionBusyId === item.id ? 'Đang cập nhật…' : item.actionState === 'resolved' ? 'Mở lại' : 'Đánh dấu đã xử lý'}</button>}</footer>
        </article>) : <div className="notification-empty"><span>✓</span><b>{filter === 'unread' ? 'Không còn thông báo chưa đọc' : 'Chưa có thông báo nào'}</b><p>Các cập nhật mới sẽ xuất hiện tại đây.</p></div>}</div>
      </div></div>
    </section>
  </div>;
}
