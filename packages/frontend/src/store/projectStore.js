import { create } from 'zustand';
import api from '../lib/api';

export const useProjectStore = create((set) => ({
  projects: [],
  activeProject: null,
  isLoading: false,

  fetchProjects: async () => {
    set({ isLoading: true });
    const { data } = await api.get('/projects');
    set({ projects: data, isLoading: false });
  },

  fetchProject: async (id) => {
    set({ isLoading: true });
    const { data } = await api.get(`/projects/${id}`);
    set({ activeProject: data, isLoading: false });
  },

  createProject: async (body) => {
    const { data } = await api.post('/projects', body);
    const { data: all } = await api.get('/projects');
    set({ projects: all });
    return data;
  },

  setActiveProject: (project) => set({ activeProject: project }),
}));
