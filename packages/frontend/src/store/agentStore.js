import { create } from 'zustand';
import api from '../lib/api';
import { socket } from '../lib/socket';

export const useAgentStore = create((set) => ({
  agents: [
    { slot: 1, name: 'DEV-1', status: 'idle', currentTask: null },
    { slot: 2, name: 'DEV-2', status: 'idle', currentTask: null },
    { slot: 3, name: 'DEV-3', status: 'idle', currentTask: null },
  ],

  fetchAgents: async () => {
    const { data } = await api.get('/agents');
    set({ agents: data });
  },
}));

socket.on('task:updated', (d) => {
  useAgentStore.getState().fetchAgents();
});
