import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle, XCircle, RotateCcw, Pause } from 'lucide-react';
import { usePipelineStore } from '../store/pipelineStore';
import PipelineFlow from '../components/pipeline/PipelineFlow';
import GateCard from '../components/pipeline/GateCard';
import AgentStatusCard from '../components/pipeline/AgentStatusCard';
import toast from 'react-hot-toast';

export default function Pipeline() {
  const { sprintId } = useParams();
  const { sprint, gates, tasks, isLoading, fetchPipeline, resumeSprint, handleError, pausePipeline, lastError } = usePipelineStore();
  const [pausing, setPausing] = useState(false);

  useEffect(() => { if (sprintId) fetchPipeline(sprintId).catch(() => {}); }, [sprintId]);

  if (isLoading || !sprint) return <div className="text-sm text-gray-400">Đang tải pipeline...</div>;

  const pass = tasks.filter((t) => t.status === 'pass').length;
  const running = tasks.filter((t) => ['running', 'validating', 'reviewing'].includes(t.status)).length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const escalated = tasks.filter((t) => t.status === 'escalated').length;

  // Determine which task to show per agent slot — prefer active, then most recent
  const agentTasks = {};
  for (const t of tasks) {
    const slot = t.agentSlot || 1;
    const isActive = ['running', 'validating', 'reviewing'].includes(t.status);
    const current = agentTasks[slot];
    if (!current || isActive || (!['running', 'validating', 'reviewing'].includes(current.status) && t.updatedAt > current.updatedAt)) {
      agentTasks[slot] = t;
    }
  }

  // Count tasks per slot for display
  const slotCounts = {};
  for (const t of tasks) {
    const slot = t.agentSlot || 1;
    slotCounts[slot] = (slotCounts[slot] || 0) + 1;
  }

  return (
    <div className="max-w-[1600px] mx-auto">
      {sprint.status === 'waiting_human' && (
        <div className="bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={16} className="text-orange-500" />
            <span className="flex-1 text-sm font-medium text-orange-700">
              {escalated > 0
                ? `${escalated} tác vụ cần can thiệp`
                : 'Pipeline gặp lỗi'}
            </span>
            <div className="flex gap-1.5">
              <button onClick={async () => {
                try { const r = await handleError(sprint.id, 'retry'); toast.success(r.message || 'Đang thử lại...'); fetchPipeline(sprintId); }
                catch (err) { toast.error(err.message); }
              }} className="text-[10px] font-medium text-orange-700 bg-orange-100 hover:bg-orange-200 px-2.5 py-1 rounded-lg">
                🔄 Thử lại
              </button>
              <button onClick={async () => {
                try { const r = await handleError(sprint.id, 'skip'); toast.success(r.message || 'Đã bỏ qua'); fetchPipeline(sprintId); }
                catch (err) { toast.error(err.message); }
              }} className="text-[10px] font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 px-2.5 py-1 rounded-lg">
                ⏭ Bỏ qua
              </button>
              <button onClick={async () => {
                try { await handleError(sprint.id, 'stop'); toast.success('Đã dừng pipeline'); fetchPipeline(sprintId); }
                catch (err) { toast.error(err.message); }
              }} className="text-[10px] font-medium text-red-600 bg-red-100 hover:bg-red-200 px-2.5 py-1 rounded-lg">
                🛑 Dừng
              </button>
            </div>
          </div>
          {lastError && (
            <div className="bg-white rounded-lg border border-orange-200 p-3 mt-1">
              <div className="text-xs font-medium text-orange-800 mb-1">Nguyên nhân:</div>
              <div className="text-xs text-orange-700 whitespace-pre-wrap">{lastError.message}</div>
              <div className="text-xs text-gray-500 mt-2 border-t border-orange-100 pt-2">
                <span className="font-medium">Giải pháp:</span>
                {lastError.message?.includes('Merge conflict') && ' Merge conflict giữa các tasks. Nhấn "Thử lại" để merge lại hoặc "Bỏ qua" để skip tasks bị conflict.'}
                {lastError.message?.includes('TIMEOUT') && ' Claude hết thời gian xử lý. Nhấn "Thử lại" với timeout dài hơn.'}
                {lastError.message?.includes('escalat') && ' Một số tasks không pass sau 3 lần thử. Xem chi tiết bên dưới và Override hoặc Retry.'}
                {!lastError.message?.includes('Merge conflict') && !lastError.message?.includes('TIMEOUT') && !lastError.message?.includes('escalat') && ' Nhấn "Thử lại" để chạy lại bước bị lỗi, hoặc "Bỏ qua" để tiếp tục.'}
              </div>
            </div>
          )}
        </div>
      )}
      {sprint.status === 'completed' && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-xl px-4 py-3 mb-4">
          <CheckCircle size={16} className="text-green-500" />
          <span className="text-sm text-green-700">Sprint hoàn thành! Toàn bộ code đã merge vào main.</span>
        </div>
      )}
      {sprint.status === 'failed' && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-4">
          <XCircle size={16} className="text-red-500" />
          <span className="flex-1 text-sm text-red-700">Sprint thất bại. Kiểm tra thông báo để biết chi tiết.</span>
          <button onClick={async () => {
            try {
              const r = await resumeSprint(sprint.id);
              toast.success(r.message || 'Đang tiếp tục...');
              fetchPipeline(sprintId);
            } catch (err) { toast.error(err.message); }
          }} className="flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 hover:bg-red-200 px-3 py-1.5 rounded-lg">
            <RotateCcw size={12} /> Chạy lại
          </button>
        </div>
      )}

      {/* Paused state: not processing, not completed/failed, not waiting for gate approval */}
      {!sprint.isProcessing && !['completed', 'failed', 'pending', 'waiting_human'].includes(sprint.status) && sprint.status === 'running_step' && (
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 mb-4">
          <Pause size={16} className="text-blue-500" />
          <span className="flex-1 text-sm text-blue-700">Pipeline đã tạm dừng tại bước {sprint.currentStep}.</span>
          <button onClick={async () => {
            try {
              const r = await resumeSprint(sprint.id);
              toast.success(r.message || 'Đang tiếp tục...');
              fetchPipeline(sprintId);
            } catch (err) { toast.error(err.message); }
          }} className="flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-100 hover:bg-blue-200 px-3 py-1.5 rounded-lg">
            <RotateCcw size={12} /> Tiếp tục
          </button>
        </div>
      )}

      {sprint.isProcessing && (
        <div className="flex justify-end mb-2">
          <button onClick={async () => {
            setPausing(true);
            try {
              await pausePipeline();
              toast.success('Pipeline đã tạm dừng');
              fetchPipeline(sprintId);
            } catch (err) { toast.error(err.message); }
            finally { setPausing(false); }
          }} disabled={pausing}
            className="flex items-center gap-1.5 text-xs font-medium text-red-600 bg-red-50 border border-red-200 hover:bg-red-100 px-3 py-1.5 rounded-lg disabled:opacity-50">
            <Pause size={13} /> {pausing ? 'Đang dừng...' : 'Tạm dừng Pipeline'}
          </button>
        </div>
      )}

      <PipelineFlow sprint={sprint} gates={gates} />

      {tasks.length > 0 && (
        <div className="grid grid-cols-4 gap-3 mb-5">
          <div className="bg-white rounded-xl border p-4 text-center"><div className="text-2xl font-bold text-green-600">{pass}</div><div className="text-xs text-gray-500 mt-1">Đạt</div></div>
          <div className="bg-white rounded-xl border p-4 text-center"><div className="text-2xl font-bold text-blue-600">{running}</div><div className="text-xs text-gray-500 mt-1">Đang chạy</div></div>
          <div className="bg-white rounded-xl border p-4 text-center"><div className="text-2xl font-bold text-gray-500">{pending}</div><div className="text-xs text-gray-500 mt-1">Chờ</div></div>
          <div className="bg-white rounded-xl border p-4 text-center"><div className="text-2xl font-bold text-orange-500">{escalated}</div><div className="text-xs text-gray-500 mt-1">Leo thang</div></div>
        </div>
      )}

      <div className="grid grid-cols-12 gap-5">
        <div className="col-span-7 space-y-0">
          {gates.map((g) => (
            <GateCard key={g.id} gate={g} sprintIsProcessing={sprint.isProcessing} sprintId={sprint.id} />
          ))}
        </div>

        <div className="col-span-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Tác nhân AI</h3>

          {/* All agents in unified list */}
          {[
            { name: 'Reception', icon: '📋', step: 0, task: 'Phân tích yêu cầu PO', phases: ['Đọc requirement', 'Tìm gaps & conflicts', 'Tạo Reception Report'] },
            { name: 'Architect', icon: '🏛️', step: 1, task: 'Thiết kế kiến trúc hệ thống', phases: ['Phân tích yêu cầu', 'Thiết kế components', 'Tạo zone classification'] },
            { name: 'Spec Writer', icon: '📝', step: 2, task: 'Viết Feature Specifications', phases: ['Đọc kiến trúc', 'Viết specs chi tiết', 'Định nghĩa test cases'] },
            { name: 'Task Planner', icon: '⚡', step: 3, task: 'Chia Atomic Tasks', phases: ['Phân tích specs', 'Chia tasks ≤3 files', 'Kiểm tra conflicts'] },
          ].map(({ name, icon, step, task, phases }) => {
            const isDone = sprint.currentStep > step || (sprint.currentStep === step && !sprint.isProcessing && gates.find(g => g.gateNumber === step)?.status === 'approved');
            const isActive = sprint.currentStep === step && sprint.isProcessing;
            return (
              <div key={name} className={`rounded-xl border overflow-hidden ${isActive ? 'bg-blue-50 border-blue-200' : isDone ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className="flex items-center gap-3 p-4">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${isActive ? 'bg-blue-100' : isDone ? 'bg-green-100' : 'bg-gray-100'}`}>
                    {icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-gray-800">{name}</div>
                    <div className="text-xs text-gray-500">{task}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-blue-500 animate-pulse' : isDone ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className={`text-xs font-bold ${isActive ? 'text-blue-600' : isDone ? 'text-green-600' : 'text-gray-400'}`}>
                      {isActive ? 'ĐANG CHẠY' : isDone ? 'ĐẠT' : 'CHỜ'}
                    </span>
                  </div>
                </div>
                {isActive && (
                  <div className="px-4 pb-3">
                    <div className="flex gap-1.5">
                      {phases.map((_, i) => (
                        <div key={i} className="h-1.5 flex-1 rounded-full bg-blue-300 animate-pulse" />
                      ))}
                    </div>
                    <div className="text-xs text-blue-500 mt-1.5 animate-pulse">Claude đang xử lý...</div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Developer Agents */}
          {[...new Set([1, 2, 3, ...Object.keys(agentTasks).map(Number)])].sort((a, b) => a - b).map((slot) => {
            const task = agentTasks[slot];
            if (!task && sprint.currentStep < 4) return null; // Hide if step 4 hasn't started
            return (
              <div key={slot}>
                <AgentStatusCard slot={slot} task={task || null} />
                {slotCounts[slot] > 1 && (
                  <div className="text-[10px] text-gray-400 text-center -mt-1 mb-2">
                    +{slotCounts[slot] - 1} tác vụ khác
                  </div>
                )}
              </div>
            );
          })}

          {/* Reviewer + QA + Merger */}
          {[
            { name: 'Reviewer', icon: '🔍', step: 4, task: 'Review code độc lập', activeWhen: () => tasks.some(t => t.status === 'reviewing') },
            { name: 'QA Engineer', icon: '🛡️', step: 5, task: 'Kiểm tra chất lượng 3 lớp' },
            { name: 'Merger', icon: '🔀', step: 6, task: 'Merge code vào main' },
          ].map(({ name, icon, step, task, activeWhen }) => {
            const isDone = sprint.currentStep > step || (step === 6 && sprint.status === 'completed');
            const isActive = activeWhen ? activeWhen() : (sprint.currentStep === step && sprint.isProcessing);
            if (!isDone && !isActive && sprint.currentStep < step - 1) return null;
            return (
              <div key={name} className={`rounded-xl border overflow-hidden ${isActive ? 'bg-blue-50 border-blue-200' : isDone ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}>
                <div className="flex items-center gap-3 p-4">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${isActive ? 'bg-blue-100' : isDone ? 'bg-green-100' : 'bg-gray-100'}`}>
                    {icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-gray-800">{name}</div>
                    <div className="text-xs text-gray-500">{task}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-blue-500 animate-pulse' : isDone ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className={`text-xs font-bold ${isActive ? 'text-blue-600' : isDone ? 'text-green-600' : 'text-gray-400'}`}>
                      {isActive ? 'ĐANG CHẠY' : isDone ? 'ĐẠT' : 'CHỜ'}
                    </span>
                  </div>
                </div>
                {isActive && (
                  <div className="px-4 pb-3">
                    <div className="text-xs text-blue-500 animate-pulse">Claude đang xử lý...</div>
                  </div>
                )}
              </div>
            );
          })}

          {tasks.length > 0 && (
            <>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mt-4">Tác vụ</h3>
              <div className="space-y-1.5">
                {[...tasks].sort((a, b) => {
                  const order = { escalated: 0, running: 1, validating: 1, reviewing: 1, pending: 2, pass: 3, fail: 3 };
                  return (order[a.status] ?? 4) - (order[b.status] ?? 4);
                }).map((t) => (
                  <div key={t.id} className={`bg-white rounded-lg border p-2 flex items-center gap-2 ${t.status === 'escalated' ? 'border-orange-300 bg-orange-50' : ''}`}>
                    <span className="font-mono text-[10px] text-gray-500 w-14">{t.taskId}</span>
                    <span className="flex-1 text-xs text-gray-700 truncate">{t.title}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      t.status === 'pass' ? 'bg-green-100 text-green-700'
                      : t.status === 'escalated' ? 'bg-orange-100 text-orange-700'
                      : ['running', 'validating', 'reviewing'].includes(t.status) ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-500'
                    }`}>{t.status}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
