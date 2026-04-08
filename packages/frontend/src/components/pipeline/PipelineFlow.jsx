import { CheckCircle, Clock, Loader, Lock, Shield } from 'lucide-react';

const steps = [
  { gate: 0, label: 'Yêu cầu' },
  { step: 1, label: 'Kiến trúc' },
  { gate: 1, label: 'Duyệt' },
  { step: 2, label: 'Đặc tả' },
  { gate: 2, label: 'Duyệt' },
  { step: 3, label: 'Tác vụ' },
  { gate: 3, label: 'Duyệt' },
  { step: 4, label: 'Lập trình' },
  { id: 'verify', label: 'Kiểm thử' },
  { gate: 4, label: 'Tự động' },
  { step: 5, label: 'QA' },
  { gate: 5, label: 'Duyệt' },
  { gate: 6, label: 'Merge' },
];

function getNodeStatus(node, sprint, gates) {
  // Special: integration verify node
  if (node.id === 'verify') {
    if (!sprint) return 'pending';
    const gate4 = gates.find((g) => g.gateNumber === 4);
    if (gate4?.status === 'approved') return 'done';
    // Step 4 done + processing = verify running
    if (sprint.currentStep === 4 && sprint.isProcessing) {
      const allTasksDone = !sprint.tasks?.some((t) => ['pending', 'running', 'validating', 'reviewing'].includes(t.status));
      if (allTasksDone) return 'running';
    }
    // Check if step > 4 means verify passed
    if (sprint.currentStep > 4) return 'done';
    return 'pending';
  }

  if (node.gate !== undefined) {
    const g = gates.find((g) => g.gateNumber === node.gate);
    if (!g) return 'pending';
    if (g.status === 'approved') return 'done';
    if (g.status === 'waiting_approval') return 'waiting';
    if (g.status === 'rejected') return 'rejected';
    return 'pending';
  }
  if (!sprint) return 'pending';
  if (sprint.currentStep > node.step) return 'done';
  if (sprint.currentStep === node.step && sprint.isProcessing) return 'running';
  return 'pending';
}

const statusStyle = {
  done:    { bg: 'bg-green-500', text: 'text-white', ring: 'ring-green-200', Icon: CheckCircle },
  running: { bg: 'bg-blue-500',  text: 'text-white', ring: 'ring-blue-200',  Icon: Loader, animate: true },
  waiting: { bg: 'bg-amber-500', text: 'text-white', ring: 'ring-amber-200', Icon: Clock },
  rejected:{ bg: 'bg-red-500',   text: 'text-white', ring: 'ring-red-200',   Icon: Lock },
  pending: { bg: 'bg-gray-200',  text: 'text-gray-500', ring: 'ring-gray-100', Icon: null },
};

export default function PipelineFlow({ sprint, gates }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mb-5">
      <div className="flex items-center justify-center gap-0 overflow-x-auto pb-2">
        {steps.map((node, i) => {
          const status = getNodeStatus(node, sprint, gates);
          const st = statusStyle[status];
          const isGate = node.gate !== undefined;
          const isVerify = node.id === 'verify';
          return (
            <div key={i} className="flex items-center">
              {i > 0 && (
                <div className={`w-6 h-0.5 ${status === 'pending' ? 'bg-gray-200' : 'bg-green-300'}`} />
              )}
              <div className="flex flex-col items-center min-w-[50px]" title={isVerify ? 'Integration Verification' : `${isGate ? 'Gate ' + node.gate : 'Step ' + node.step}: ${node.label}`}>
                <div className={`w-9 h-9 rounded-full ${st.bg} ${st.ring} ring-2 flex items-center justify-center ${st.animate ? 'animate-pulse' : ''}`}>
                  {isVerify ? <Shield size={15} className={st.text} />
                    : st.Icon ? <st.Icon size={15} className={st.text} />
                    : <span className={`text-[10px] font-bold ${st.text}`}>{isGate ? `G${node.gate}` : `S${node.step}`}</span>
                  }
                </div>
                <span className="text-[10px] text-gray-400 mt-1.5 whitespace-nowrap">{node.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
