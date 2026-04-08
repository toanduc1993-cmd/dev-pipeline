import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, Loader } from 'lucide-react';
import api from '../lib/api';
import toast from 'react-hot-toast';

export default function Settings() {
  const [config, setConfig] = useState(null);
  const [health, setHealth] = useState({});
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    api.get('/config').then(({ data }) => setConfig(data)).catch(() => {});
    runHealthCheck();
  }, []);

  const runHealthCheck = async () => {
    setChecking(true);
    const h = {};
    try { const { data } = await api.get('/pipeline/health'); h.backend = { ok: true, ...data }; } catch { h.backend = { ok: false }; }
    try { const { data } = await api.post('/config/verify-claude'); h.claude = data; } catch { h.claude = { ok: false }; }
    try { const { data } = await api.post('/config/verify-git'); h.git = data; } catch { h.git = { ok: false }; }
    setHealth(h);
    setChecking(false);
  };

  const saveConfig = async () => {
    try {
      const { data } = await api.put('/config', config);
      setConfig(data);
      toast.success('Đã lưu cấu hình');
    } catch (err) { toast.error(err.message); }
  };

  const StatusIcon = ({ ok }) => ok ? <CheckCircle size={14} className="text-green-500" /> : <XCircle size={14} className="text-red-500" />;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-xl font-bold text-gray-800">Cài đặt</h1>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Cấu hình Pipeline</h2>
        {config && (
          <div className="grid grid-cols-2 gap-3">
            {[
              { key: 'maxParallelAgents', label: 'Số tác nhân song song', type: 'number' },
              { key: 'maxRetryRounds', label: 'Số lần thử lại tối đa', type: 'number' },
              { key: 'taskTimeoutMins', label: 'Thời gian chờ tác vụ (phút)', type: 'number' },
              { key: 'qaChunkSize', label: 'Kích thước chunk QA', type: 'number' },
            ].map(({ key, label, type }) => (
              <div key={key}>
                <label className="text-xs text-gray-500">{label}</label>
                <input type={type} value={config[key] ?? ''} onChange={(e) => setConfig({ ...config, [key]: parseInt(e.target.value) || 0 })}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 mt-0.5" />
              </div>
            ))}
            <div className="col-span-2 flex items-center gap-2">
              <input type="checkbox" checked={config.telegramEnabled || false}
                onChange={(e) => setConfig({ ...config, telegramEnabled: e.target.checked })}
                className="rounded border-gray-300" />
              <span className="text-xs text-gray-600">Bật thông báo Telegram</span>
            </div>
            <div className="col-span-2">
              <button onClick={saveConfig} className="bg-blue-600 text-white text-sm font-medium px-4 py-1.5 rounded-lg hover:bg-blue-700">
                Lưu cấu hình
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">Kiểm tra sức khoẻ</h2>
          <button onClick={runHealthCheck} disabled={checking}
            className="text-xs text-blue-600 hover:underline flex items-center gap-1">
            {checking && <Loader size={12} className="animate-spin" />} Kiểm tra
          </button>
        </div>
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <StatusIcon ok={health.backend?.ok} /> Backend
            {health.backend?.activeSprints !== undefined && (
              <span className="text-xs text-gray-400">({health.backend.activeSprints} sprint đang chạy)</span>
            )}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <StatusIcon ok={health.claude?.ok} /> Claude CLI
            {health.claude?.output && <span className="text-xs text-gray-400 truncate max-w-xs">{health.claude.output.substring(0, 80)}</span>}
          </div>
          <div className="flex items-center gap-2 text-sm">
            <StatusIcon ok={health.git?.ok} /> Git Worktree
            {health.git?.gitVersion && <span className="text-xs text-gray-400">{health.git.gitVersion}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
