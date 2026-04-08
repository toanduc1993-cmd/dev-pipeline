import { useState, useEffect, useRef } from 'react';
import { Loader, Wifi, WifiOff, Activity } from 'lucide-react';
import { usePipelineStore } from '../../store/pipelineStore';
import { socket } from '../../lib/socket';
import NotificationBell from './NotificationBell';

const statusLabels = {
  pending: { cls: 'bg-gray-100 text-gray-600', label: 'Chờ xử lý' },
  waiting_gate: { cls: 'bg-amber-100 text-amber-700', label: 'Chờ duyệt' },
  running_step: { cls: 'bg-blue-100 text-blue-700', label: 'Đang chạy' },
  waiting_human: { cls: 'bg-orange-100 text-orange-700', label: 'Cần can thiệp' },
  completed: { cls: 'bg-green-100 text-green-700', label: 'Hoàn thành' },
  failed: { cls: 'bg-red-100 text-red-700', label: 'Thất bại' },
};

const stepNames = {
  0: 'Reception Report',
  1: 'Kiến trúc',
  2: 'Đặc tả',
  3: 'Tạo tác vụ',
  4: 'Lập trình',
  5: 'QA Review',
  6: 'Merge',
};

function useElapsed(isRunning) {
  const startRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRunning) { setElapsed(0); startRef.current = Date.now(); return; }
    startRef.current = Date.now();
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [isRunning]);

  if (!isRunning) return '';
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return m > 0 ? `${m}p${s.toString().padStart(2, '0')}s` : `${s}s`;
}

function useHeartbeat() {
  const [lastEvent, setLastEvent] = useState(Date.now());
  const [eventCount, setEventCount] = useState(0);

  useEffect(() => {
    const onAny = () => {
      setLastEvent(Date.now());
      setEventCount((c) => c + 1);
    };
    socket.onAny(onAny);
    return () => socket.offAny(onAny);
  }, []);

  const secondsSinceLastEvent = Math.floor((Date.now() - lastEvent) / 1000);
  return { lastEvent, eventCount, secondsSinceLastEvent };
}

export default function Header() {
  const sprint = usePipelineStore((s) => s.sprint);
  const agentChunks = usePipelineStore((s) => s.agentChunks);
  const qaFixProgress = usePipelineStore((s) => s.qaFixProgress);
  const { connected } = useSocketStatus();
  const heartbeat = useHeartbeat();

  // True "processing" = isProcessing AND not in error/waiting state
  const isActuallyRunning = sprint?.isProcessing && sprint?.status === 'running_step';
  const elapsed = useElapsed(isActuallyRunning);
  const hasChunkActivity = Object.values(agentChunks || {}).some((c) => c?.length > 0);

  // Heartbeat: detect stale (no events for 120s while supposedly running)
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);
  const staleSeconds = Math.floor((now - heartbeat.lastEvent) / 1000);
  const isStale = isActuallyRunning && staleSeconds > 120;

  // Determine activity detail
  const isPlanningInProgress = qaFixProgress && qaFixProgress.phase !== 'done' && qaFixProgress.sprintId === null;
  let activityDetail = 'Claude đang xử lý';
  if (isPlanningInProgress) {
    activityDetail = qaFixProgress.message;
  } else if (qaFixProgress && qaFixProgress.phase !== 'done' && sprint?.currentStep === 5) {
    activityDetail = qaFixProgress.message;
  } else if (sprint?.currentStep === 4 && hasChunkActivity) {
    activityDetail = 'Claude đang viết code';
  } else if (sprint?.currentStep === 4) {
    activityDetail = 'Claude đang lập trình';
  }

  return (
    <header className="h-13 bg-white border-b border-gray-200 flex items-center px-4 gap-4 shrink-0">
      <div className="flex-1 flex items-center gap-3">
        {sprint?.project && (
          <span className="text-sm font-medium text-gray-700">{sprint.project.name}</span>
        )}
        {sprint && (
          <>
            <span className="text-xs text-gray-400">Sprint #{sprint.number}</span>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${(statusLabels[sprint.status] || statusLabels.pending).cls}`}>
              {(statusLabels[sprint.status] || statusLabels.pending).label}
            </span>

            {isActuallyRunning && (
              <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-1">
                <Loader size={12} className="text-blue-500 animate-spin" />
                <span className="text-[10px] text-blue-700 font-medium">
                  {stepNames[sprint.currentStep] || `Bước ${sprint.currentStep}`}
                </span>
                {elapsed && <span className="text-[10px] text-blue-400 font-mono">{elapsed}</span>}
                <span className="text-[10px] text-blue-400">{activityDetail}</span>
              </div>
            )}

            {isActuallyRunning && (
              <div className="flex items-center gap-1" title={`Sự kiện cuối: ${staleSeconds}s trước`}>
                <Activity size={11} className={isStale ? 'text-red-400' : 'text-green-400'} />
                <span className={`text-[9px] ${isStale ? 'text-red-400' : 'text-green-400'}`}>
                  {isStale ? `Không phản hồi ${staleSeconds}s` : `${staleSeconds}s`}
                </span>
              </div>
            )}
          </>
        )}
        {isPlanningInProgress && (
          <div className="flex items-center gap-2 bg-purple-50 border border-purple-200 rounded-lg px-2.5 py-1">
            <Loader size={12} className="text-purple-500 animate-spin" />
            <span className="text-[10px] text-purple-700 font-medium">Sprint Planning</span>
            <span className="text-[10px] text-purple-500">{activityDetail}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {connected ? (
          <Wifi size={13} className="text-green-400" title="Kết nối realtime OK" />
        ) : (
          <WifiOff size={13} className="text-red-400" title="Mất kết nối realtime" />
        )}
        <NotificationBell />
      </div>
    </header>
  );
}

function useSocketStatus() {
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); };
  }, []);

  return { connected };
}
