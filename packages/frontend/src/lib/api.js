import axios from 'axios';

const API_SECRET = import.meta.env.VITE_API_SECRET || '';

const api = axios.create({
  baseURL: (import.meta.env.VITE_API_URL || '') + '/api',
  timeout: 30000,
  headers: API_SECRET ? { Authorization: `Bearer ${API_SECRET}` } : {},
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = err.response?.data?.error || err.response?.data?.message || err.message;
    return Promise.reject(new Error(msg));
  }
);

export default api;
