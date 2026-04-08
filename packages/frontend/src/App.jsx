import { Routes, Route } from 'react-router-dom';
import Sidebar from './components/layout/Sidebar';
import Header from './components/layout/Header';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import Pipeline from './pages/Pipeline';
import Agents from './pages/Agents';
import Notifications from './pages/Notifications';
import Settings from './pages/Settings';

export default function App() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6 bg-gray-50">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/projects/:id/sprints/:sprintId" element={<Pipeline />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
