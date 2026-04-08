import { useEffect, useState } from 'react';
import { useNotifStore } from '../store/notifStore';

const typeEmoji = {
  gate_waiting: '🔐', gate_approved: '✅', gate_rejected: '❌',
  task_escalated: '🚨', sprint_complete: '🎉', sprint_failed: '💥', task_pass: '✓', task_fail: '✗',
};

const filters = [
  { key: 'all', label: 'Tất cả' },
  { key: 'unread', label: 'Chưa đọc' },
  { key: 'gate_waiting', label: 'Chờ duyệt' },
  { key: 'task_escalated', label: 'Leo thang' },
];

export default function Notifications() {
  const { notifications, fetchNotifications, markRead, markAllRead } = useNotifStore();
  const [filter, setFilter] = useState('all');

  useEffect(() => { fetchNotifications().catch(() => {}); }, []);

  const filtered = notifications.filter((n) => {
    if (filter === 'unread') return !n.read;
    if (filter === 'all') return true;
    return n.type === filter;
  });

  const filterLabel = (key) => filters.find((f) => f.key === key)?.label || key;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-gray-800">Thông báo</h1>
        <button onClick={() => markAllRead()} className="text-xs text-blue-600 hover:underline">Đọc tất cả</button>
      </div>
      <div className="flex gap-1 mb-4">
        {filters.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`text-xs px-2.5 py-1 rounded-lg ${filter === f.key ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        {filtered.map((n) => (
          <div key={n.id} onClick={() => !n.read && markRead(n.id)}
            className={`bg-white rounded-lg border p-3 cursor-pointer transition-all ${n.read ? 'border-gray-200' : 'border-blue-200 bg-blue-50/30'}`}>
            <div className="flex items-start gap-2">
              <span className="text-sm">{typeEmoji[n.type] || '📌'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800">{n.title}</div>
                <div className="text-xs text-gray-500 mt-0.5">{n.message}</div>
              </div>
              <span className="text-[10px] text-gray-400 whitespace-nowrap">
                {n.createdAt ? new Date(n.createdAt).toLocaleString() : ''}
              </span>
              {!n.read && <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 shrink-0" />}
            </div>
          </div>
        ))}
        {filtered.length === 0 && <div className="text-sm text-gray-400 text-center py-8">Chưa có thông báo</div>}
      </div>
    </div>
  );
}
