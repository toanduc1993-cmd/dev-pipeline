import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Folder, ChevronRight, Github, HardDrive } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import api from '../lib/api';
import toast from 'react-hot-toast';

export default function Dashboard() {
  const { projects, isLoading, fetchProjects, createProject } = useProjectStore();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', repoUrl: '', language: '' });
  const [mode, setMode] = useState('github'); // 'github' | 'local' | 'browse'
  const [creating, setCreating] = useState(false);
  const [localRepos, setLocalRepos] = useState([]);
  const navigate = useNavigate();

  useEffect(() => { fetchProjects().catch(() => {}); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    const input = mode === 'github' ? form.repoUrl : form.repoUrl;
    if (!form.name || !input) return toast.error('Tên và nguồn repo là bắt buộc');

    setCreating(true);
    try {
      const body = {
        name: form.name,
        description: form.description,
        ...(mode === 'github' ? { repoUrl: input } : { repoPath: input }),
        ...(form.language && { language: form.language }),
      };
      const p = await createProject(body);
      setShowForm(false);
      setForm({ name: '', description: '', repoUrl: '', language: '' });
      toast.success('Đã tạo dự án');
      navigate(`/projects/${p.id}`);
    } catch (err) { toast.error(err.message); }
    finally { setCreating(false); }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-800">Tổng quan</h1>
        <button onClick={() => setShowForm(true)} className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-blue-700">
          <Plus size={15} /> Tạo dự án
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-800">{projects.length}</div>
          <div className="text-xs text-gray-500 mt-0.5">Dự án</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-2xl font-bold text-blue-600">{projects.reduce((a, p) => a + (p._count?.sprints || 0), 0)}</div>
          <div className="text-xs text-gray-500 mt-0.5">Tổng Sprint</div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4">
          <div className="text-2xl font-bold text-green-600">{projects.filter(p => p.status === 'active').length}</div>
          <div className="text-xs text-gray-500 mt-0.5">Đang hoạt động</div>
        </div>
      </div>

      {isLoading && <div className="text-sm text-gray-400">Đang tải...</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((p) => (
          <div key={p.id} onClick={() => navigate(`/projects/${p.id}`)}
            className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:border-blue-300 hover:shadow-sm transition-all">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <Folder size={16} className="text-blue-500" />
                <span className="font-medium text-sm text-gray-800">{p.name}</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">{p.language}</span>
            </div>
            {p.description && <p className="text-xs text-gray-500 mt-2 line-clamp-2">{p.description}</p>}
            <div className="flex items-center justify-between mt-3">
              <span className="text-[10px] text-gray-400">{p._count?.sprints || 0} sprint</span>
              <ChevronRight size={14} className="text-gray-300" />
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowForm(false)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}
            className="bg-white rounded-xl shadow-xl p-5 w-full max-w-md space-y-3">
            <h2 className="font-bold text-gray-800">Tạo dự án mới</h2>

            <input placeholder="Tên dự án" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />

            {/* Mode toggle */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              <button type="button" onClick={() => setMode('github')}
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md transition-all ${mode === 'github' ? 'bg-white shadow text-gray-800 font-medium' : 'text-gray-500'}`}>
                <Github size={13} /> GitHub URL
              </button>
              <button type="button" onClick={() => {
                setMode('browse');
                api.get('/projects/scan-repos').then(({ data }) => setLocalRepos(data)).catch(() => {});
              }}
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md transition-all ${mode === 'browse' ? 'bg-white shadow text-gray-800 font-medium' : 'text-gray-500'}`}>
                <Folder size={13} /> Chọn từ máy
              </button>
              <button type="button" onClick={() => setMode('local')}
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs py-1.5 rounded-md transition-all ${mode === 'local' ? 'bg-white shadow text-gray-800 font-medium' : 'text-gray-500'}`}>
                <HardDrive size={13} /> Nhập path
              </button>
            </div>

            {mode === 'github' ? (
              <div>
                <input placeholder="https://github.com/user/repo" value={form.repoUrl}
                  onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />
                <p className="text-[10px] text-gray-400 mt-1">Hệ thống sẽ tự động clone repo về máy</p>
              </div>
            ) : mode === 'browse' ? (
              <div>
                <div className="border border-gray-300 rounded-lg max-h-48 overflow-y-auto">
                  {localRepos.length === 0 && (
                    <div className="text-xs text-gray-400 text-center py-4">Đang quét thư mục...</div>
                  )}
                  {localRepos.map((repo) => (
                    <button key={repo.path} type="button"
                      onClick={() => { setForm({ ...form, repoUrl: repo.path, name: form.name || repo.name }); }}
                      className={`w-full text-left px-3 py-2 text-xs border-b border-gray-100 hover:bg-blue-50 transition-all ${form.repoUrl === repo.path ? 'bg-blue-50 text-blue-700' : 'text-gray-700'}`}>
                      <div className="font-medium">{repo.name}</div>
                      <div className="text-[10px] text-gray-400 truncate">{repo.path}</div>
                    </button>
                  ))}
                </div>
                {form.repoUrl && mode === 'browse' && (
                  <p className="text-[10px] text-blue-500 mt-1">Đã chọn: {form.repoUrl}</p>
                )}
              </div>
            ) : (
              <div>
                <input placeholder="/Users/.../my-project" value={form.repoUrl}
                  onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                  className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />
                <p className="text-[10px] text-gray-400 mt-1">Đường dẫn tuyệt đối đến git repo trên máy</p>
              </div>
            )}

            <input placeholder="Mô tả (tuỳ chọn)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />

            <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2">
              <option value="">Tự phát hiện</option>
              <option value="javascript">JavaScript</option>
              <option value="typescript">TypeScript</option>
              <option value="python">Python</option>
            </select>

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={creating}
                className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {creating ? 'Đang tạo...' : mode === 'github' ? 'Clone & Tạo' : 'Tạo'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">Huỷ</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
