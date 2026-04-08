import { io } from 'socket.io-client';

export const socket = io(import.meta.env.VITE_API_URL || 'http://localhost:3001', {
  autoConnect: true,
  reconnectionDelay: 1000,
  auth: { token: import.meta.env.VITE_API_SECRET || '' },
});
