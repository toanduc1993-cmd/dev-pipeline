import { create } from 'zustand';
import api from '../lib/api';
import { socket } from '../lib/socket';

export const usePipelineStore = create((set) => ({
  sprint: null,
  gates: [],
  tasks: [],
  agentChunks: {},
  qaFixProgress: null,
  lastError: null, // { message, type }
  isLoading: false,

  fetchPipeline: async (sprintId) => {
    set({ isLoading: true });
    const { data } = await api.get(`/sprints/${sprintId}/pipeline`);
    set({
      sprint: data,
      gates: data.gates || [],
      tasks: data.tasks || [],
      isLoading: false,
    });
    socket.emit('subscribe:sprint', { sprintId });
    // Load last error if sprint is in error state
    if (data.status === 'waiting_human' || data.status === 'failed') {
      try {
        const { data: notifs } = await api.get('/notifications?limit=5');
        const list = notifs.notifications || notifs;
        const err = list.find((n) => n.sprintId === sprintId && ['pipeline_error', 'sprint_failed'].includes(n.type));
        if (err) set({ lastError: { message: err.message, type: err.type, title: err.title } });
      } catch { /* ok */ }
    } else {
      set({ lastError: null });
    }
  },

  approveGate: async (gateId, comment) => {
    await api.post(`/gates/${gateId}/approve`, { comment });
    // Auto-refetch after 1.5s to show next step running
    const sprintId = usePipelineStore.getState().sprint?.id;
    if (sprintId) setTimeout(() => usePipelineStore.getState().fetchPipeline(sprintId), 1500);
  },

  rejectGate: async (gateId, reason) => {
    await api.post(`/gates/${gateId}/reject`, { reason });
    const sprintId = usePipelineStore.getState().sprint?.id;
    if (sprintId) setTimeout(() => usePipelineStore.getState().fetchPipeline(sprintId), 1000);
  },

  overrideTask: async (taskId) => {
    await api.post(`/tasks/${taskId}/override-pass`);
  },

  retryTask: async (taskId) => {
    await api.post(`/tasks/${taskId}/retry`);
  },

  pausePipeline: async () => {
    const { data } = await api.post('/pipeline/pause');
    return data;
  },

  resumeSprint: async (sprintId) => {
    const { data } = await api.post(`/sprints/${sprintId}/resume`);
    return data;
  },

  handleError: async (sprintId, action) => {
    const { data } = await api.post('/pipeline/error-action', { sprintId, action });
    return data;
  },

  runQAFix: async (sprintId, fixAll = false) => {
    const { data } = await api.post('/pipeline/qa-fix', { sprintId, fixAll });
    return data;
  },

  onSprintUpdate: (data) => {
    set((s) => {
      const updated = { ...s.sprint, ...data };
      return {
        sprint: updated,
        gates: data.gates || s.gates,
        tasks: data.tasks || s.tasks,
      };
    });
  },

  onGateUpdate: (data) => {
    set((s) => ({
      gates: s.gates.map((g) =>
        g.id === data.gateId || g.gateNumber === data.gateNumber
          ? { ...g, ...data }
          : g
      ),
    }));
  },

  onTaskUpdate: (data) => {
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === data.taskId ? { ...t, ...data } : t
      ),
    }));
  },

  onAgentChunk: ({ agentSlot, chunk }) => {
    set((s) => ({
      agentChunks: {
        ...s.agentChunks,
        [agentSlot]: (s.agentChunks[agentSlot] || '') + chunk,
      },
    }));
  },

  clearChunk: (slot) => {
    set((s) => ({
      agentChunks: { ...s.agentChunks, [slot]: '' },
    }));
  },
}));

// Socket listeners — refetch full state on sprint/gate changes for accurate UI
let _refetchDebounce = null;
function _debouncedRefetch() {
  clearTimeout(_refetchDebounce);
  _refetchDebounce = setTimeout(() => {
    const sprintId = usePipelineStore.getState().sprint?.id;
    if (sprintId) usePipelineStore.getState().fetchPipeline(sprintId);
  }, 1000);
}

socket.on('sprint:updated', (d) => { usePipelineStore.getState().onSprintUpdate(d); _debouncedRefetch(); });
socket.on('gate:updated', (d) => { usePipelineStore.getState().onGateUpdate(d); _debouncedRefetch(); });
socket.on('task:updated', (d) => usePipelineStore.getState().onTaskUpdate(d));
socket.on('agent:chunk', (d) => usePipelineStore.getState().onAgentChunk(d));
socket.on('qa:fix_progress', (d) => usePipelineStore.setState({ qaFixProgress: d }));
socket.on('sprint:error', (d) => usePipelineStore.setState({ lastError: { message: d.error, type: 'pipeline_error' } }));
