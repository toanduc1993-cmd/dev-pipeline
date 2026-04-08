import { useEffect, useState } from 'react';
import { useAgentStore } from '../store/agentStore';
import { usePipelineStore } from '../store/pipelineStore';
import AgentStatusCard from '../components/pipeline/AgentStatusCard';
import api from '../lib/api';

const AI_ROLES = [
  { group: 'Phân tích & Thiết kế', agents: [
    { name: 'Reception', icon: '📋', desc: 'Phân tích yêu cầu PO', step: 0, tools: 'Không có — chỉ suy nghĩ' },
    { name: 'Architect', icon: '🏛️', desc: 'Thiết kế kiến trúc hệ thống', step: 1, tools: 'Không có — chỉ suy nghĩ' },
    { name: 'Spec Writer', icon: '📝', desc: 'Viết Feature Specifications', step: 2, tools: 'Không có — chỉ suy nghĩ' },
    { name: 'Task Planner', icon: '⚡', desc: 'Chia Atomic Tasks', step: 3, tools: 'Không có — chỉ suy nghĩ' },
  ]},
  { group: 'Lập trình', agents: [
    { name: 'DEV-1', icon: '💻', desc: 'Developer Agent slot 1', step: 4, slot: 1, tools: 'Read, Write, Bash' },
    { name: 'DEV-2', icon: '💻', desc: 'Developer Agent slot 2', step: 4, slot: 2, tools: 'Read, Write, Bash' },
    { name: 'DEV-3', icon: '💻', desc: 'Developer Agent slot 3', step: 4, slot: 3, tools: 'Read, Write, Bash' },
  ]},
  { group: 'Kiểm tra & Review', agents: [
    { name: 'Reviewer', icon: '🔍', desc: 'Review code độc lập — KHÔNG thấy dev report', step: 4, tools: 'Không có — chỉ đọc diff' },
    { name: 'QA Engineer', icon: '🛡️', desc: 'Kiểm tra chất lượng 3 lớp', step: 5, tools: 'Không có — chỉ suy nghĩ' },
    { name: 'Merger', icon: '🔀', desc: 'Merge code vào main', step: 6, tools: 'Git operations' },
  ]},
  { group: 'Bugfix (khi báo lỗi)', agents: [
    { name: 'Diagnostician', icon: '🔬', desc: 'Chẩn đoán lỗi — CHỈ đọc, KHÔNG sửa', tools: 'Read, Bash' },
    { name: 'Fixer', icon: '🔧', desc: 'Sửa code theo fix plan', tools: 'Read, Write, Bash' },
    { name: 'Verifier', icon: '✅', desc: 'Kiểm tra fix hoạt động — KHÔNG sửa code', tools: 'Read, Bash' },
  ]},
];

export default function Agents() {
  const { agents, fetchAgents } = useAgentStore();
  const sprint = usePipelineStore((s) => s.sprint);
  const [selectedSlot, setSelectedSlot] = useState(1);
  const [logs, setLogs] = useState([]);

  useEffect(() => { fetchAgents().catch(() => {}); }, []);
  useEffect(() => {
    api.get(`/agents/${selectedSlot}/logs`).then(({ data }) => setLogs(data)).catch(() => {});
  }, [selectedSlot]);

  const getAgentStatus = (agent) => {
    if (!sprint) return 'idle';
    if (agent.step !== undefined) {
      if (sprint.currentStep === agent.step && sprint.isProcessing) return 'running';
      if (sprint.currentStep > agent.step) return 'done';
    }
    return 'idle';
  };

  const statusStyle = {
    running: { dot: 'bg-blue-500 animate-pulse', text: 'text-blue-600', label: 'ĐANG CHẠY', bg: 'bg-blue-50 border-blue-200' },
    done: { dot: 'bg-green-500', text: 'text-green-600', label: 'XONG', bg: 'bg-green-50 border-green-200' },
    idle: { dot: 'bg-gray-300', text: 'text-gray-400', label: 'CHỜ', bg: 'bg-gray-50 border-gray-200' },
  };

  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-gray-800 mb-4">Tất cả tác nhân AI</h1>

      {AI_ROLES.map(({ group, agents: roleAgents }) => (
        <div key={group} className="mb-6">
          <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">{group}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {roleAgents.map((agent) => {
              // For DEV slots, use AgentStatusCard
              if (agent.slot) {
                const devAgent = agents.find((a) => a.slot === agent.slot);
                return <AgentStatusCard key={agent.name} slot={agent.slot} task={devAgent?.currentTask || null} />;
              }

              // For other roles, show unified card
              const st = statusStyle[getAgentStatus(agent)];
              return (
                <div key={agent.name} className={`rounded-xl border overflow-hidden ${st.bg}`}>
                  <div className="flex items-center gap-2.5 p-3">
                    <div className="w-8 h-8 rounded-full bg-white border border-gray-200 flex items-center justify-center text-base">
                      {agent.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-bold text-gray-800">{agent.name}</div>
                      <div className="text-[10px] text-gray-500">{agent.desc}</div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full ${st.dot}`} />
                      <span className={`text-[10px] font-bold ${st.text}`}>{st.label}</span>
                    </div>
                  </div>
                  <div className="px-3 pb-2">
                    <div className="text-[9px] text-gray-400">Tools: {agent.tools}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Agent Logs */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm font-semibold text-gray-700">Nhật ký tác nhân</span>
          {[1, 2, 3].map((s) => (
            <button key={s} onClick={() => setSelectedSlot(s)}
              className={`text-xs px-2 py-0.5 rounded ${selectedSlot === s ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
              DEV-{s}
            </button>
          ))}
        </div>
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {logs.map((task) => (
            <div key={task.id} className="border border-gray-100 rounded-lg p-2">
              <div className="text-xs font-medium text-gray-700">{task.taskId} — {task.title}</div>
              <div className="text-[10px] text-gray-400">Status: {task.status} · Round {task.currentRound}</div>
              {(task.logs || []).map((log) => (
                <details key={log.id} className="mt-1">
                  <summary className="text-[10px] text-gray-500 cursor-pointer">
                    {log.phase} R{log.round} — {log.success ? '✓' : '✗'} {log.durationMs ? `${(log.durationMs / 1000).toFixed(0)}s` : ''}
                  </summary>
                  <pre className="text-[10px] text-gray-600 bg-gray-50 rounded p-1.5 mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap">
                    {(log.rawOutput || '').substring(0, 500)}
                  </pre>
                </details>
              ))}
            </div>
          ))}
          {logs.length === 0 && <div className="text-xs text-gray-400 text-center py-4">Chưa có nhật ký cho DEV-{selectedSlot}</div>}
        </div>
      </div>
    </div>
  );
}
