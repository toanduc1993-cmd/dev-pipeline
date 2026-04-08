import { useEffect, useState, useRef } from 'react';
import { usePipelineStore } from '../../store/pipelineStore';
import toast from 'react-hot-toast';

const statusCfg = {
  idle:       { label: 'Rảnh',        dot: 'bg-gray-300', bg: 'bg-gray-50' },
  pending:    { label: 'Chờ',         dot: 'bg-gray-300', bg: 'bg-gray-50' },
  running:    { label: 'Đang chạy',   dot: 'bg-blue-500', bg: 'bg-blue-50',   pulse: true, phase: 'Đang code' },
  validating: { label: 'Kiểm tra',    dot: 'bg-purple-500', bg: 'bg-purple-50', pulse: true, phase: 'Đang kiểm tra' },
  reviewing:  { label: 'Review',      dot: 'bg-amber-500', bg: 'bg-amber-50',  pulse: true, phase: 'Đang review' },
  pass:       { label: 'ĐẠT',         dot: 'bg-green-500', bg: 'bg-green-50' },
  fail:       { label: 'LỖI',         dot: 'bg-red-500',  bg: 'bg-red-50' },
  escalated:  { label: 'LEO THANG',   dot: 'bg-orange-500', bg: 'bg-orange-50' },
};

export default function AgentStatusCard({ slot, task }) {
  const status = task?.status || 'idle';
  const st = statusCfg[status] || statusCfg.idle;
  const chunks = usePipelineStore((s) => s.agentChunks[slot] || '');
  const clearChunk = usePipelineStore((s) => s.clearChunk);
  const overrideTask = usePipelineStore((s) => s.overrideTask);
  const [expanded, setExpanded] = useState(false);
  const termRef = useRef(null);

  useEffect(() => {
    if (status === 'pass' || status === 'escalated') { clearChunk(slot); setExpanded(false); }
  }, [status]);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [chunks]);

  const handleOverride = async () => {
    try { await overrideTask(task.id); toast.success('Đã ghi đè tác vụ thành ĐẠT'); }
    catch (err) { toast.error(err.message); }
  };

  return (
    <div className={`rounded-xl border border-gray-200 ${st.bg} overflow-hidden`}>
      <div className="flex items-center gap-2.5 p-3 border-b border-white/50">
        <div className={`w-7 h-7 rounded-full bg-white border-2 border-gray-300 flex items-center justify-center text-xs font-bold text-gray-600`}>
          {slot}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-bold text-gray-800">DEV-{slot}</div>
          {task && <div className="text-[10px] text-gray-400 font-mono">{task.taskId}</div>}
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${st.dot} ${st.pulse ? 'animate-pulse' : ''}`} />
          <span className={`text-[10px] font-bold ${status === 'pass' ? 'text-green-600' : status === 'escalated' ? 'text-orange-600' : 'text-gray-500'}`}>
            {st.label}
          </span>
        </div>
      </div>

      {task && (
        <div className="p-3 space-y-2">
          <div className="text-xs text-gray-700 line-clamp-2">{task.title}</div>

          {st.phase && (
            <span className="inline-block text-[10px] px-1.5 py-0.5 bg-white rounded text-gray-500">
              {status === 'running' ? '💻' : status === 'validating' ? '🔍' : '📋'} {st.phase}
            </span>
          )}

          {task.currentRound > 0 && (
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((r) => (
                <div key={r} className={`h-1 flex-1 rounded-full ${r <= task.currentRound ? st.dot : 'bg-gray-200'}`} />
              ))}
              <span className="text-[10px] text-gray-400 ml-1">R{task.currentRound}/3</span>
            </div>
          )}

          {['running', 'validating', 'reviewing'].includes(status) && !chunks && (
            <div className="bg-[#0F172A] rounded-lg p-2.5">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-[#86EFAC] animate-pulse" />
                <span className="text-[11px] text-[#86EFAC] font-mono">
                  {status === 'running' ? 'Agent đang viết code...' : status === 'validating' ? 'Đang chạy syntax check...' : 'Reviewer đang phân tích diff...'}
                </span>
              </div>
            </div>
          )}

          {['running', 'validating', 'reviewing'].includes(status) && chunks && (
            <div>
              <div
                className={`bg-[#0F172A] rounded-lg p-2 overflow-y-auto cursor-pointer transition-all ${expanded ? 'max-h-[70vh] fixed inset-4 z-50 p-4 rounded-xl shadow-2xl' : 'max-h-28'}`}
                onClick={() => !expanded && setExpanded(true)}
                ref={termRef}
                title={expanded ? '' : 'Click để mở rộng'}
              >
                {expanded && (
                  <div className="flex justify-between items-center mb-2 border-b border-gray-700 pb-2">
                    <div className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full bg-red-500"></div>
                      <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                      <div className="w-3 h-3 rounded-full bg-green-500"></div>
                      <span className="text-[11px] text-gray-400 ml-2 font-mono">DEV-{slot} · {task.taskId} · {task.title}</span>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setExpanded(false); }} className="text-gray-400 hover:text-white text-xs px-2 py-1 rounded bg-gray-800 hover:bg-gray-700">
                      ✕ Đóng
                    </button>
                  </div>
                )}
                <pre className={`${expanded ? 'text-[13px]' : 'text-[10px]'} text-[#86EFAC] whitespace-pre-wrap font-mono leading-relaxed`}>
                  {expanded ? chunks.slice(-5000) : chunks.slice(-800)}
                </pre>
              </div>
              {expanded && <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setExpanded(false)} />}
            </div>
          )}

          {task.archVerdict && !['running', 'validating', 'reviewing'].includes(status) && (
            <span className={`inline-block text-[10px] font-bold px-1.5 py-0.5 rounded ${
              task.archVerdict === 'PASS' ? 'bg-green-100 text-green-700'
              : task.archVerdict === 'PASS_WITH_NOTES' ? 'bg-amber-100 text-amber-700'
              : 'bg-red-100 text-red-700'
            }`}>
              Architect: {task.archVerdict}
            </span>
          )}

          {status === 'escalated' && (
            <div className="space-y-1.5">
              {task.escalationReason && (
                <div className="text-[10px] text-orange-700 bg-orange-100 rounded p-1.5">{task.escalationReason}</div>
              )}
              <button onClick={handleOverride} className="w-full text-[10px] font-semibold bg-orange-500 text-white rounded-lg py-1 hover:bg-orange-600">
                Ép ĐẠT
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
