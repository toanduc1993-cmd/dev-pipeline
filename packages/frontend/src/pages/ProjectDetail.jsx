import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, ArrowRight, Rocket, Monitor, Globe, Upload, FileText, Image, X, Bug } from 'lucide-react';
import { useProjectStore } from '../store/projectStore';
import { usePipelineStore } from '../store/pipelineStore';
import api from '../lib/api';
import toast from 'react-hot-toast';

const statusLabels = {
  pending: { cls: 'bg-gray-100 text-gray-600', label: 'Chờ' },
  waiting_gate: { cls: 'bg-amber-100 text-amber-700', label: 'Chờ duyệt' },
  running_step: { cls: 'bg-blue-100 text-blue-700', label: 'Đang chạy' },
  waiting_human: { cls: 'bg-orange-100 text-orange-700', label: 'Cần can thiệp' },
  completed: { cls: 'bg-green-100 text-green-700', label: 'Hoàn thành' },
  failed: { cls: 'bg-red-100 text-red-700', label: 'Thất bại' },
};

export default function ProjectDetail() {
  const { id } = useParams();
  const { activeProject, fetchProject } = useProjectStore();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', requirementText: '' });
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [deploy, setDeploy] = useState(null);
  const [deploySaving, setDeploySaving] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);
  const [deployRunning, setDeployRunning] = useState(false);
  const [setupResult, setSetupResult] = useState(null);
  const [deployResult, setDeployResult] = useState(null);
  const [showBugfix, setShowBugfix] = useState(false);
  const [bugDesc, setBugDesc] = useState('');
  const [bugfixRunning, setBugfixRunning] = useState(false);
  const [showPlanner, setShowPlanner] = useState(false);
  const [planReq, setPlanReq] = useState('');
  const [planFiles, setPlanFiles] = useState([]);
  const [planning, setPlanning] = useState(false);
  const planFileRef = useRef(null);
  const navigate = useNavigate();
  const qaFixProgress = usePipelineStore((s) => s.qaFixProgress);
  const isPlanningFromSocket = qaFixProgress && qaFixProgress.sprintId === null && qaFixProgress.phase !== 'done';
  const isPlanningFromDB = activeProject?.status === 'planning';
  const isPlanningInProgress = isPlanningFromSocket || isPlanningFromDB;

  useEffect(() => { fetchProject(id).catch(() => {}); }, [id]);
  // Poll project status while planning is in progress
  useEffect(() => {
    if (!isPlanningInProgress) return;
    const poll = setInterval(() => fetchProject(id).catch(() => {}), 5000);
    return () => clearInterval(poll);
  }, [isPlanningInProgress, id]);
  useEffect(() => {
    if (id) api.get(`/projects/${id}/deploy-config`).then(({ data }) => setDeploy(data)).catch(() => {});
  }, [id]);

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        const { data } = await api.post('/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        setUploadedFiles((prev) => [...prev, {
          name: file.name,
          filePath: data.filePath,
          extractedText: data.extractedText,
          size: file.size,
        }]);
        toast.success(`Đã tải: ${file.name}`);
      } catch (err) {
        toast.error(`Lỗi tải ${file.name}: ${err.message}`);
      }
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeFile = (index) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name) return toast.error('Tên sprint là bắt buộc');
    if (!form.requirementText && uploadedFiles.length === 0) {
      return toast.error('Nhập yêu cầu hoặc tải tài liệu lên');
    }

    setCreating(true);
    try {
      // Combine manual text + extracted text from files
      let fullRequirement = form.requirementText || '';
      for (const f of uploadedFiles) {
        fullRequirement += `\n\n--- Tài liệu: ${f.name} ---\n${f.extractedText}`;
      }

      const body = {
        name: form.name,
        requirementText: fullRequirement,
        requirementFile: uploadedFiles[0]?.filePath || null,
      };

      const { data } = await api.post(`/projects/${id}/sprints`, body);
      setShowForm(false);
      setForm({ name: '', requirementText: '' });
      setUploadedFiles([]);
      toast.success('Đã tạo sprint');
      navigate(`/projects/${id}/sprints/${data.id}`);
    } catch (err) { toast.error(err.message); }
    finally { setCreating(false); }
  };

  const saveDeploy = async () => {
    setDeploySaving(true);
    try {
      const { data } = await api.put(`/projects/${id}/deploy-config`, deploy);
      setDeploy(data);
      toast.success('Đã lưu cấu hình deploy');
    } catch (err) { toast.error(err.message); }
    finally { setDeploySaving(false); }
  };

  const runLocalSetup = async () => {
    setSetupRunning(true);
    setSetupResult(null);
    try {
      const { data } = await api.post(`/projects/${id}/local-setup`);
      setSetupResult(data);
      toast.success(data.success ? 'Local setup thành công!' : 'Local setup có lỗi');
    } catch (err) { toast.error(err.message); setSetupResult({ success: false, steps: [{ step: 'Error', status: 'error', output: err.message }] }); }
    finally { setSetupRunning(false); }
  };

  const runUATDeploy = async () => {
    setDeployRunning(true);
    setDeployResult(null);
    try {
      const { data } = await api.post(`/projects/${id}/uat-deploy`);
      setDeployResult(data);
      toast.success(data.success ? `Deploy thành công! ${data.uatUrl || ''}` : 'Deploy có lỗi');
    } catch (err) { toast.error(err.message); setDeployResult({ success: false, steps: [{ step: 'Error', status: 'error', output: err.message }] }); }
    finally { setDeployRunning(false); }
  };

  if (!activeProject) return <div className="text-sm text-gray-400">Đang tải...</div>;

  const Field = ({ label, field, type = 'text', placeholder }) => (
    <div>
      <label className="text-xs text-gray-500">{label}</label>
      <input type={type} placeholder={placeholder} value={deploy?.[field] || ''}
        onChange={(e) => setDeploy({ ...deploy, [field]: e.target.value })}
        className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 mt-0.5" />
    </div>
  );

  const StepResult = ({ result }) => result && (
    <div className="mt-2 space-y-1">
      {result.steps?.map((s, i) => (
        <div key={i} className={`text-xs px-2 py-1 rounded ${s.status === 'ok' ? 'bg-green-50 text-green-700' : s.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-gray-50 text-gray-600'}`}>
          <span className="font-medium">{s.step}:</span> {s.status} {s.output ? `— ${s.output.substring(0, 100)}` : ''}
        </div>
      ))}
      {result.localUrl && <div className="text-xs text-blue-600 font-medium">URL: {result.localUrl}</div>}
      {result.uatUrl && <div className="text-xs text-blue-600 font-medium">URL: {result.uatUrl}</div>}
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-800">{activeProject.name}</h1>
          {activeProject.description && <p className="text-sm text-gray-500 mt-0.5">{activeProject.description}</p>}
          <div className="flex gap-2 mt-1">
            <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 rounded text-gray-500">{activeProject.language}</span>
            <span className="text-[10px] text-gray-400 font-mono">{activeProject.repoPath}</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowPlanner(!showPlanner)}
            className="flex items-center gap-1.5 text-purple-600 text-sm font-medium px-3 py-1.5 rounded-lg border border-purple-200 hover:bg-purple-50">
            <FileText size={15} /> Lên kế hoạch
          </button>
          <button onClick={() => setShowBugfix(!showBugfix)}
            className="flex items-center gap-1.5 text-red-600 text-sm font-medium px-3 py-1.5 rounded-lg border border-red-200 hover:bg-red-50">
            <Bug size={15} /> Báo lỗi
          </button>
          <button onClick={() => setShowDeploy(!showDeploy)}
            className="flex items-center gap-1.5 text-gray-600 text-sm font-medium px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
            <Rocket size={15} /> Deploy
          </button>
          <button onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 bg-blue-600 text-white text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-blue-700">
            <Plus size={15} /> Tạo Sprint
          </button>
        </div>
      </div>

      {/* Sprint Planner Panel */}
      {showPlanner && (
        <div className="bg-purple-50 rounded-xl border border-purple-200 p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <FileText size={16} className="text-purple-500" />
            <h2 className="text-sm font-semibold text-gray-700">Lên kế hoạch Sprint</h2>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Upload tài liệu yêu cầu lớn — AI sẽ đọc và tự chia thành nhiều sprints vừa sức. Mỗi sprint sẽ được tạo tự động.
          </p>
          <textarea value={planReq} onChange={(e) => setPlanReq(e.target.value)}
            placeholder="Mô tả tổng thể dự án (hoặc upload file bên dưới)"
            className="w-full text-sm border border-purple-200 rounded-lg p-3 resize-none" rows={3} />
          <div className="mt-2">
            <input ref={planFileRef} type="file" accept=".pdf,.docx,.md,.txt,.png,.jpg" className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const formData = new FormData();
                formData.append('file', file);
                try {
                  const { data } = await api.post('/upload', formData, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 300000 });
                  setPlanFiles([...planFiles, { name: file.name, text: data.extractedText }]);
                  toast.success(`Đã tải: ${file.name} (${data.extractedText.length} ký tự)`);
                } catch (err) { toast.error(err.message); }
                if (planFileRef.current) planFileRef.current.value = '';
              }} />
            <button type="button" onClick={() => planFileRef.current?.click()}
              className="text-xs text-purple-600 border border-purple-200 px-3 py-1.5 rounded-lg hover:bg-purple-100">
              <Upload size={12} className="inline mr-1" /> Upload tài liệu (PDF, Word, Ảnh)
            </button>
          </div>
          {planFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-2 mt-2 bg-white rounded-lg px-3 py-1.5 border border-purple-100">
              <FileText size={12} className="text-purple-400" />
              <span className="text-xs text-gray-700">{f.name}</span>
              <span className="text-[10px] text-gray-400">{f.text.length} ký tự</span>
              <button onClick={() => setPlanFiles(planFiles.filter((_, j) => j !== i))} className="ml-auto text-gray-400 hover:text-red-500"><X size={12} /></button>
            </div>
          ))}
          <div className="flex gap-2 mt-3">
            <button onClick={async () => {
              const fullReq = [planReq, ...planFiles.map((f) => `--- ${f.name} ---\n${f.text}`)].filter(Boolean).join('\n\n');
              if (!fullReq.trim()) return toast.error('Nhập yêu cầu hoặc upload tài liệu');
              setPlanning(true);
              try {
                await api.post(`/projects/${id}/plan-sprints`, { requirement: fullReq });
                toast.success('Sprint Planner đang phân tích...');
                setPlanReq('');
                setPlanFiles([]);
                setShowPlanner(false);
                // Poll for sprints creation
                const poll = setInterval(async () => {
                  try {
                    await fetchProject(id);
                    const updated = useProjectStore.getState().activeProject;
                    if (updated?.sprints?.length > 0) {
                      clearInterval(poll);
                      toast.success(`Đã tạo ${updated.sprints.length} sprints!`);
                    }
                  } catch {}
                }, 10000);
                // Stop polling after 5 min
                setTimeout(() => clearInterval(poll), 300000);
              } catch (err) { toast.error(err.message); }
              finally { setPlanning(false); }
            }} disabled={planning}
              className="bg-purple-600 text-white text-sm font-medium px-4 py-1.5 rounded-lg hover:bg-purple-700 disabled:opacity-50">
              {planning ? 'Đang phân tích...' : 'Lên kế hoạch Sprint'}
            </button>
            <button onClick={() => setShowPlanner(false)} className="text-sm text-gray-500 hover:text-gray-700">Đóng</button>
          </div>
        </div>
      )}

      {/* Sprint Planning Progress */}
      {isPlanningInProgress && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-4 flex items-center gap-3">
          <div className="w-3 h-3 bg-purple-500 rounded-full animate-bounce shrink-0" />
          <div>
            <div className="text-sm font-medium text-purple-800">Sprint Planning đang chạy...</div>
            <div className="text-xs text-purple-600 mt-0.5">
              {isPlanningFromSocket ? qaFixProgress.message : 'Claude đang phân tích requirement và chia sprints — vui lòng chờ...'}
            </div>
          </div>
        </div>
      )}

      {/* Deploy Status Bar — always visible when deployed */}
      {(deploy?.localUrl || deploy?.uatUrl) && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 mb-4 flex items-center gap-4">
          {deploy.localUrl && (
            <div className="flex items-center gap-2">
              <Monitor size={14} className="text-green-500" />
              <span className="text-xs text-gray-500">Local:</span>
              <a href={deploy.localUrl} target="_blank" rel="noreferrer"
                className="text-xs font-medium text-blue-600 hover:underline">
                {deploy.localUrl}
              </a>
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" title="Đang chạy" />
            </div>
          )}
          {deploy.uatUrl && (
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-purple-500" />
              <span className="text-xs text-gray-500">Production:</span>
              <a href={deploy.uatUrl} target="_blank" rel="noreferrer"
                className="text-xs font-medium text-purple-600 hover:underline">
                {deploy.uatUrl}
              </a>
            </div>
          )}
          {!deploy.localUrl && !deploy.uatUrl && null}
          <div className="ml-auto flex gap-2">
            {deploy.localUrl && (
              <button onClick={runLocalSetup} disabled={setupRunning}
                className="text-[10px] text-gray-500 hover:text-gray-700 border border-gray-200 px-2 py-0.5 rounded">
                {setupRunning ? '...' : 'Restart'}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Bugfix Panel */}
      {showBugfix && (
        <div className="bg-red-50 rounded-xl border border-red-200 p-5 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Bug size={16} className="text-red-500" />
            <h2 className="text-sm font-semibold text-gray-700">Báo lỗi & Tự động fix</h2>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            Mô tả lỗi bạn gặp — hệ thống sẽ tự rà soát code, tìm nguyên nhân, fix và khởi động lại app.
          </p>
          <textarea
            value={bugDesc}
            onChange={(e) => setBugDesc(e.target.value)}
            placeholder="VD: App bị lỗi ImportError khi start. Hoặc: API trả về 500 khi gọi /api/reading. Hoặc: Trang web trắng không hiện gì."
            className="w-full text-sm border border-red-200 rounded-lg p-3 resize-none focus:outline-none focus:ring-2 focus:ring-red-300"
            rows={3}
          />
          <div className="flex gap-2 mt-3">
            <button
              onClick={async () => {
                if (!bugDesc.trim()) return toast.error('Mô tả lỗi trước');
                setBugfixRunning(true);
                try {
                  await api.post(`/projects/${id}/bugfix`, { errorDescription: bugDesc });
                  toast.success('Claude đang chẩn đoán và fix... Theo dõi trên Telegram.');
                  setBugDesc('');
                } catch (err) { toast.error(err.message); }
                finally { setBugfixRunning(false); }
              }}
              disabled={bugfixRunning || !bugDesc.trim()}
              className="bg-red-500 text-white text-sm font-medium px-4 py-1.5 rounded-lg hover:bg-red-600 disabled:opacity-50"
            >
              {bugfixRunning ? 'Đang chẩn đoán...' : '🔧 Chẩn đoán & Fix'}
            </button>
            <button onClick={() => setShowBugfix(false)}
              className="text-sm text-gray-500 hover:text-gray-700">Đóng</button>
          </div>
        </div>
      )}

      {/* Deploy Config Panel */}
      {showDeploy && (
        <div className="bg-white rounded-xl border border-gray-200 p-5 mb-6 space-y-4">
          <div className="flex items-center gap-2 mb-2">
            <Rocket size={16} className="text-blue-500" />
            <h2 className="text-sm font-semibold text-gray-700">Cấu hình Deploy</h2>
          </div>

          {/* Local Setup */}
          <div className="border border-gray-100 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Monitor size={14} className="text-green-500" />
                <span className="text-sm font-medium text-gray-700">Local Setup</span>
                {deploy?.localSetupDone && <span className="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded">Đã chạy</span>}
              </div>
              <button onClick={runLocalSetup} disabled={setupRunning}
                className="text-xs bg-green-600 text-white px-3 py-1 rounded-lg hover:bg-green-700 disabled:opacity-50">
                {setupRunning ? 'Đang chạy...' : 'Chạy Setup'}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Port" field="localPort" type="number" placeholder="3000" />
              <Field label="Lệnh setup tuỳ chỉnh" field="localSetupCmd" placeholder="npm install && npm run build" />
              <Field label="Lệnh khởi động" field="localStartCmd" placeholder="npm run dev" />
            </div>
            {deploy?.localUrl && <div className="text-xs text-green-600 mt-2">Đang chạy: {deploy.localUrl}</div>}
            <StepResult result={setupResult} />
          </div>

          {/* UAT Deploy */}
          <div className="border border-gray-100 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Globe size={14} className="text-purple-500" />
                <span className="text-sm font-medium text-gray-700">UAT Deploy (Internet)</span>
                {deploy?.uatDeployDone && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">Đã deploy</span>}
              </div>
              <button onClick={runUATDeploy} disabled={deployRunning}
                className="text-xs bg-purple-600 text-white px-3 py-1 rounded-lg hover:bg-purple-700 disabled:opacity-50">
                {deployRunning ? 'Đang deploy...' : 'Deploy UAT'}
              </button>
            </div>

            <p className="text-[10px] text-gray-400 mb-3">Điền thông tin bên dưới để deploy lên môi trường UAT</p>

            <div className="space-y-3">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">Git Remote</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Git Remote URL" field="gitRemoteUrl" placeholder="https://github.com/user/repo" />
                <Field label="Git Token (PAT)" field="gitToken" type="password" placeholder="ghp_..." />
                <Field label="Branch" field="gitBranch" placeholder="main" />
              </div>

              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mt-3">Vercel</div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Vercel Token" field="vercelToken" type="password" placeholder="..." />
                <Field label="Vercel Team ID" field="vercelTeamId" placeholder="team_..." />
              </div>

              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mt-3">Database</div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500">Provider</label>
                  <select value={deploy?.uatDbProvider || ''} onChange={(e) => setDeploy({ ...deploy, uatDbProvider: e.target.value })}
                    className="w-full text-sm border border-gray-300 rounded-lg px-3 py-1.5 mt-0.5">
                    <option value="">Chọn...</option>
                    <option value="postgres">PostgreSQL</option>
                    <option value="mysql">MySQL</option>
                    <option value="mongodb">MongoDB</option>
                    <option value="supabase">Supabase</option>
                    <option value="planetscale">PlanetScale</option>
                  </select>
                </div>
                <Field label="Connection String" field="uatDbUrl" type="password" placeholder="postgresql://..." />
              </div>

              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mt-3">Tuỳ chỉnh</div>
              <Field label="Lệnh deploy tuỳ chỉnh" field="customDeployCmd" placeholder="docker build && docker push ..." />
            </div>

            {deploy?.uatUrl && <div className="text-xs text-purple-600 mt-2 font-medium">UAT URL: {deploy.uatUrl}</div>}
            <StepResult result={deployResult} />
          </div>

          <button onClick={saveDeploy} disabled={deploySaving}
            className="bg-blue-600 text-white text-sm font-medium px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {deploySaving ? 'Đang lưu...' : 'Lưu cấu hình'}
          </button>
        </div>
      )}

      {/* Sprint List — sorted by number ascending */}
      <div className="space-y-2">
        {[...(activeProject.sprints || [])].sort((a, b) => a.number - b.number).map((s) => {
          const st = statusLabels[s.status] || statusLabels.pending;
          const isPending = s.status === 'pending';
          const isActive = !['pending', 'completed', 'failed'].includes(s.status);
          return (
            <div key={s.id}
              onClick={() => !isPending && navigate(`/projects/${id}/sprints/${s.id}`)}
              className={`bg-white rounded-xl border p-4 flex items-center gap-4 transition-all ${
                isPending ? 'border-gray-200' : 'border-gray-200 cursor-pointer hover:border-blue-300 hover:shadow-sm'
              } ${isActive ? 'border-blue-300 bg-blue-50/30' : ''}`}>
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                s.status === 'completed' ? 'bg-green-100 text-green-600'
                : isActive ? 'bg-blue-100 text-blue-600'
                : 'bg-gray-100 text-gray-500'
              }`}>{s.number}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800">{s.name}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">
                  {isPending ? 'Chưa bắt đầu' : `Bước ${s.currentStep}/6 · Cổng ${s.currentGateNumber}`}
                </div>
              </div>
              {isPending ? (
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    try {
                      // Trigger Step 0 Reception by updating sprint status
                      await api.post(`/sprints/${s.id}/resume`);
                      toast.success('Đang bắt đầu sprint...');
                      navigate(`/projects/${id}/sprints/${s.id}`);
                    } catch (err) {
                      // If resume fails, navigate anyway to show pipeline
                      navigate(`/projects/${id}/sprints/${s.id}`);
                    }
                  }}
                  className="text-xs font-medium bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700">
                  Bắt đầu
                </button>
              ) : (
                <>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                  <ArrowRight size={14} className="text-gray-300" />
                </>
              )}
            </div>
          );
        })}
        {(activeProject.sprints || []).length === 0 && (
          <div className="text-sm text-gray-400 text-center py-8">Chưa có sprint. Tạo mới để bắt đầu.</div>
        )}
      </div>

      {/* Create Sprint Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowForm(false)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={handleCreate}
            className="bg-white rounded-xl shadow-xl p-5 w-full max-w-lg space-y-3">
            <h2 className="font-bold text-gray-800">Tạo Sprint mới</h2>

            <input placeholder="Tên sprint" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2" />

            <textarea placeholder="Mô tả yêu cầu (hoặc tải tài liệu bên dưới)" value={form.requirementText}
              onChange={(e) => setForm({ ...form, requirementText: e.target.value })}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 resize-none" rows={4} />

            {/* File Upload Area */}
            <div>
              <input ref={fileInputRef} type="file" multiple accept=".pdf,.docx,.doc,.md,.txt,.png,.jpg,.jpeg,.gif,.webp"
                onChange={handleFileUpload} className="hidden" />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}
                className="w-full border-2 border-dashed border-gray-300 rounded-lg py-4 px-3 text-center hover:border-blue-400 hover:bg-blue-50/30 transition-all disabled:opacity-50">
                <Upload size={20} className="mx-auto text-gray-400 mb-1" />
                <div className="text-xs text-gray-500">
                  {uploading ? 'Đang tải lên...' : 'Tải tài liệu yêu cầu'}
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5">PDF, Word, Markdown, Ảnh (PNG/JPG)</div>
              </button>
            </div>

            {/* Uploaded Files List */}
            {uploadedFiles.length > 0 && (
              <div className="space-y-1.5">
                {uploadedFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 bg-blue-50 rounded-lg px-3 py-2">
                    {f.name.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? <Image size={14} className="text-blue-500 shrink-0" /> : <FileText size={14} className="text-blue-500 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium text-gray-700 truncate">{f.name}</div>
                      <div className="text-[10px] text-gray-400">{f.extractedText ? `${f.extractedText.length} ký tự trích xuất` : 'Đang xử lý...'}</div>
                    </div>
                    <button type="button" onClick={() => removeFile(i)} className="text-gray-400 hover:text-red-500">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={creating}
                className="flex-1 bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {creating ? 'Đang tạo...' : 'Tạo Sprint'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setUploadedFiles([]); }}
                className="px-4 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">Huỷ</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
