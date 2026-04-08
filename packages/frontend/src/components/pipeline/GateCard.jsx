import { useState } from 'react';
import { CheckCircle, XCircle, Clock, ChevronDown, ChevronUp, AlertTriangle, Wrench } from 'lucide-react';
import { usePipelineStore } from '../../store/pipelineStore';
import toast from 'react-hot-toast';

const cfg = {
  pending:          { Icon: Clock,       border: 'border-gray-200', bg: 'bg-gray-50',   color: 'text-gray-400' },
  waiting_approval: { Icon: Clock,       border: 'border-amber-300', bg: 'bg-amber-50',  color: 'text-amber-600' },
  approved:         { Icon: CheckCircle, border: 'border-green-200', bg: 'bg-green-50',  color: 'text-green-600' },
  rejected:         { Icon: XCircle,     border: 'border-red-200',   bg: 'bg-red-50',    color: 'text-red-600' },
};

function stripJsonBlock(text) {
  return (text || '').replace(/```json[\s\S]*?```/g, '').trim();
}

function notesHaveIssues(notes) {
  if (!notes) return false;
  return /minor|major|critical|issue|fix|violation|fail/i.test(notes);
}

export default function GateCard({ gate, sprintIsProcessing, sprintId }) {
  const [expanded, setExpanded] = useState(gate.status === 'waiting_approval');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const { approveGate, rejectGate, runQAFix, fetchPipeline } = usePipelineStore();

  const qaFixProgress = usePipelineStore((s) => s.qaFixProgress);
  const sprint = usePipelineStore((s) => s.sprint);

  const st = cfg[gate.status] || cfg.pending;
  const isWaiting = gate.status === 'waiting_approval';
  const isQAGate = gate.gateNumber === 5;
  const hasIssues = isQAGate && notesHaveIssues(gate.notes);
  // Detect auto-fix in progress: sprint is processing at step 5, or socket says fixing
  const autoFixRunning = isQAGate && (
    (sprint?.isProcessing && sprint?.currentStep === 5) ||
    (qaFixProgress && !['done', 'failed'].includes(qaFixProgress.phase))
  );

  const handleApprove = async () => {
    setBusy(true);
    try { await approveGate(gate.id, comment); toast.success(`Cổng ${gate.gateNumber} đã duyệt`); }
    catch (err) { toast.error(err.message); }
    finally { setBusy(false); }
  };

  const handleFixAndRerun = async (fixAll = false) => {
    if (!sprintId) return toast.error('Không tìm thấy sprint');
    setFixing(true);
    try {
      await runQAFix(sprintId, fixAll);
      toast.success('Auto-fix started — fixing all issues, QA will re-run automatically (max 5 rounds)');
    } catch (err) { toast.error(err.message); }
    finally { setFixing(false); }
  };

  const handleRejectClick = () => {
    setRejectReason('');
    setShowRejectModal(true);
  };

  const handleRejectConfirm = async () => {
    if (!rejectReason.trim()) return;
    setShowRejectModal(false);
    try { await rejectGate(gate.id, rejectReason.trim()); toast.success('Đã từ chối cổng'); }
    catch (err) { toast.error(err.message); }
  };

  return (
    <>
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 mx-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={18} className="text-red-500" />
              <h3 className="font-semibold text-gray-800">Từ chối Cổng {gate.gateNumber}</h3>
            </div>
            <p className="text-sm text-gray-500 mb-3">Nêu lý do để AI hiểu cần sửa gì.</p>
            <textarea
              className="w-full border border-gray-200 rounded-lg p-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-red-300"
              rows={3}
              placeholder="VD: Phạm vi tính năng quá rộng, chia thành tasks nhỏ hơn..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
                onClick={() => setShowRejectModal(false)}>Huỷ</button>
              <button className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
                onClick={handleRejectConfirm} disabled={!rejectReason.trim()}>Từ chối</button>
            </div>
          </div>
        </div>
      )}

      <div className={`rounded-xl border-2 ${st.border} ${st.bg} overflow-hidden transition-all mb-3`}>
        <div className="flex items-center gap-3 px-5 py-4 cursor-pointer" onClick={() => gate.notes && setExpanded(!expanded)}>
          <span className="font-mono text-xs font-bold text-gray-500 bg-white rounded px-2 py-1">G{gate.gateNumber}</span>
          <st.Icon size={16} className={st.color} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-gray-800">{gate.title}</div>
          </div>
          <span className={`text-[10px] font-semibold ${st.color}`}>{gate.status?.replace('_', ' ')}</span>
          {gate.notes && (expanded ? <ChevronUp size={15} className="text-gray-400" /> : <ChevronDown size={15} className="text-gray-400" />)}
        </div>

        {expanded && gate.notes && (
          <div className="px-4 pb-3">
            <div className="bg-white rounded-lg border border-gray-200 p-3 max-h-72 overflow-y-auto">
              <pre className="text-xs text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">{stripJsonBlock(gate.notes)}</pre>
            </div>
          </div>
        )}

        {isWaiting && (
          <div className="px-4 pb-3 space-y-2">
            <textarea value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Nhận xét (tuỳ chọn)..." className="w-full text-xs border border-gray-300 rounded-lg p-2 resize-none" rows={2} />
            <div className="flex gap-2">
              <button onClick={handleApprove} disabled={busy || fixing || sprintIsProcessing}
                className="flex-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-semibold rounded-lg px-3 py-1.5 text-xs">
                {busy ? '...' : 'Duyệt'}
              </button>

              {isQAGate && hasIssues && !autoFixRunning && !fixing && (
                <button onClick={() => handleFixAndRerun(true)} disabled={busy || sprintIsProcessing}
                  className="flex-1 bg-purple-500 hover:bg-purple-600 disabled:opacity-50 text-white font-semibold rounded-lg px-3 py-1.5 text-xs flex items-center justify-center gap-1">
                  <Wrench size={12} /> Auto-fix & Re-QA
                </button>
              )}
              {isQAGate && (fixing || autoFixRunning) && (
                <div className="flex-1 bg-purple-100 text-purple-700 font-semibold rounded-lg px-3 py-2 text-xs text-center">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" />
                    <span>{qaFixProgress?.message || 'Auto-fixing all issues & re-running QA...'}</span>
                  </div>
                </div>
              )}

              <button onClick={handleRejectClick} disabled={busy || fixing || sprintIsProcessing}
                className="flex-1 bg-white hover:bg-red-50 disabled:opacity-50 text-red-600 border border-red-300 font-semibold rounded-lg px-3 py-1.5 text-xs">
                Từ chối
              </button>
            </div>
          </div>
        )}

        {gate.status === 'approved' && gate.approvedAt && (
          <div className="px-4 pb-2 text-[10px] text-green-600">
            Đã duyệt {new Date(gate.approvedAt).toLocaleString('vi-VN')} qua {gate.approvedBy}
          </div>
        )}
        {gate.status === 'rejected' && gate.poComment && (
          <div className="px-4 pb-2 text-[10px] text-red-600">Từ chối: {gate.poComment}</div>
        )}
      </div>
    </>
  );
}
