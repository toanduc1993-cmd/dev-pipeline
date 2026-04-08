import { create } from 'zustand';
import api from '../lib/api';
import { socket } from '../lib/socket';

export const useNotifStore = create((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isOpen: false,

  fetchNotifications: async () => {
    const { data } = await api.get('/notifications');
    const list = data.notifications || data;
    set({
      notifications: list,
      unreadCount: list.filter((n) => !n.read).length,
    });
  },

  markRead: async (id) => {
    await api.post(`/notifications/${id}/read`);
    set((s) => ({
      notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
      unreadCount: Math.max(0, s.unreadCount - 1),
    }));
  },

  markAllRead: async () => {
    await api.post('/notifications/read-all');
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }));
  },

  addNotification: (notif) => {
    set((s) => ({
      notifications: [notif, ...s.notifications].slice(0, 50),
      unreadCount: s.unreadCount + 1,
    }));
  },

  setOpen: (val) => set({ isOpen: val }),
}));

socket.on('notification:new', (notif) => useNotifStore.getState().addNotification(notif));
