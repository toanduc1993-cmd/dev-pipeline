import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useNotifStore } from '../../store/notifStore';

const typeEmoji = {
  gate_waiting: '🔐', gate_approved: '✅', gate_rejected: '❌',
  task_escalated: '🚨', sprint_complete: '🎉', sprint_failed: '💥',
};

export default function NotificationBell() {
  const { notifications, unreadCount, isOpen, setOpen, fetchNotifications, markAllRead } = useNotifStore();
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => { fetchNotifications().catch(() => {}); }, []);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!isOpen)} className="relative p-1.5 rounded-lg hover:bg-gray-100">
        <Bell size={18} className="text-gray-500" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-10 w-80 bg-white rounded-xl shadow-xl border border-gray-200 z-50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-500">Thông báo</span>
            {unreadCount > 0 && (
              <button onClick={() => markAllRead()} className="text-[10px] text-blue-600 hover:underline">Đọc tất cả</button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {notifications.slice(0, 5).map((n) => (
              <div key={n.id} className={`px-3 py-2 border-b border-gray-50 text-xs ${n.read ? '' : 'bg-blue-50/40'}`}>
                <div className="font-medium text-gray-700">{typeEmoji[n.type] || '📌'} {n.title}</div>
                <div className="text-gray-500 mt-0.5 truncate">{n.message}</div>
              </div>
            ))}
            {notifications.length === 0 && <div className="px-3 py-4 text-xs text-gray-400 text-center">Chưa có thông báo</div>}
          </div>
          <button onClick={() => { setOpen(false); navigate('/notifications'); }}
            className="w-full px-3 py-2 text-xs text-blue-600 hover:bg-gray-50 border-t border-gray-100 text-center">
            Xem tất cả
          </button>
        </div>
      )}
    </div>
  );
}
