import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, GitBranch, Bot, Bell, Settings, Folder } from 'lucide-react';
import { useProjectStore } from '../../store/projectStore';

const nav = [
  { to: '/agents', icon: Bot, label: 'Tác nhân' },
  { to: '/notifications', icon: Bell, label: 'Thông báo' },
  { to: '/settings', icon: Settings, label: 'Cài đặt' },
];

export default function Sidebar() {
  const { projects, fetchProjects } = useProjectStore();

  useEffect(() => { fetchProjects().catch(() => {}); }, []);

  return (
    <aside className="w-56 bg-white border-r border-gray-200 flex flex-col h-full shrink-0">
      <NavLink to="/" className="p-4 border-b border-gray-100">
        <div className="text-sm font-bold tracking-wider text-gray-800">AI DEV PIPELINE</div>
        <div className="text-[10px] text-gray-400 mt-0.5">v5.0 · Claude-Native</div>
      </NavLink>

      <div className="flex-1 overflow-y-auto py-3">
        <div className="px-3 mb-1">
          <NavLink to="/" className={({ isActive }) =>
            `flex items-center gap-2 px-2 py-1.5 rounded text-sm ${isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`
          }>
            <LayoutDashboard size={15} /> Tổng quan
          </NavLink>
        </div>

        <div className="px-3 mt-4 mb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Dự án</div>
        <div className="px-3 space-y-0.5">
          {projects.slice(0, 8).map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`} className={({ isActive }) =>
              `flex items-center gap-2 px-2 py-1.5 rounded text-sm truncate ${isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`
            }>
              <Folder size={14} className="shrink-0" />
              <span className="truncate">{p.name}</span>
            </NavLink>
          ))}
        </div>

        <div className="px-3 mt-4 mb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Điều hướng</div>
        <div className="px-3 space-y-0.5">
          {nav.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} className={({ isActive }) =>
              `flex items-center gap-2 px-2 py-1.5 rounded text-sm ${isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`
            }>
              <Icon size={15} /> {label}
            </NavLink>
          ))}
        </div>
      </div>

      <div className="p-3 border-t border-gray-100 text-[10px] text-gray-400">
        <GitBranch size={10} className="inline mr-1" /> Pipeline tuần tự
      </div>
    </aside>
  );
}
