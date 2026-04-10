import { useState, useEffect, useCallback, useRef } from 'react';

type Stack = {
  stackName: string; region: string; tenant: string; status: string;
  createdAt: string; updatedAt: string;
  parameters: { ParameterKey: string; ParameterValue: string }[];
  outputs: { OutputKey: string; OutputValue: string }[];
  tags: { Key: string; Value: string }[];
  envVars: Record<string, string>;
};
type DdbItem = Record<string, any>;
type DeployMode = 'new' | 'update' | 'destroy' | null;
type BuildInfo = {
  buildId: string;
  projectName: string;
  region: string;
  status: string;
  logs: string[];
  nextToken: string | null;
  mode: DeployMode;
  tenant: string;
};

const api = (path: string) => fetch(path).then((r) => r.json());
const post = (path: string, body: any) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

const BEDROCK_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-2',
  'ap-northeast-1', 'ap-northeast-2', 'ap-south-1',
  'ap-southeast-1', 'ap-southeast-2',
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3',
  'ca-central-1', 'sa-east-1',
];

export function App() {
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState('');
  const [accountId, setAccountId] = useState('');
  const [stacks, setStacks] = useState<Stack[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ddbItems, setDdbItems] = useState<DdbItem[]>([]);
  const [ddbTable, setDdbTable] = useState('');
  const [ddbRegion, setDdbRegion] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [ssmCache, setSsmCache] = useState<Record<string, any>>({});
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Deploy state
  const [deployMode, setDeployMode] = useState<DeployMode>(null);
  const [deployTarget, setDeployTarget] = useState<Stack | null>(null);
  const [deployForm, setDeployForm] = useState({ tenant: '', destination: 'slack', language: 'japanese', webhookUrl: '', deployRegion: '', skipSsm: false, ssmParamName: '' });
  const [existingSsmParams, setExistingSsmParams] = useState<{ name: string }[]>([]);
  const [configJson, setConfigJson] = useState('');
  const [configError, setConfigError] = useState('');
  const [editorTab, setEditorTab] = useState<'gui' | 'json'>('gui');
  const [bedrockModels, setBedrockModels] = useState<{ modelId: string; modelName: string; provider: string; type: string }[]>([]);
  const [modelsRegion, setModelsRegion] = useState('');

  // Structured config for GUI editor
  type NotifierConfig = { destination: string; summarizerName: string; webhookUrlParameterName: string; rssUrl: Record<string, string> };
  type SummarizerConfig = { outputLanguage: string; persona: string };
  const [guiConfig, setGuiConfig] = useState<{
    modelRegion: string; modelIds: string[];
    notifiers: Record<string, NotifierConfig>;
    summarizers: Record<string, SummarizerConfig>;
  }>({ modelRegion: '', modelIds: [], notifiers: {}, summarizers: {} });
  const [destroyConfirm, setDestroyConfirm] = useState('');
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [buildMinimized, setBuildMinimized] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [testingStack, setTestingStack] = useState('');
  const logEndRef = useRef<HTMLDivElement>(null);

  // Persist/restore buildInfo in localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('wnsn-build');
      if (saved) setBuildInfo(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    if (buildInfo) localStorage.setItem('wnsn-build', JSON.stringify(buildInfo));
    else localStorage.removeItem('wnsn-build');
  }, [buildInfo]);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 5000);
  };

  useEffect(() => { api('/api/profiles').then(setProfiles); }, []);

  const selectProfile = async (p: string) => {
    setProfile(p); setAccountId(''); setStacks([]); setDdbItems([]);
    setDdbTable(''); setDdbRegion(''); setTables([]); setExpanded(null);
    setSsmCache({}); setError('');
    if (!p) return;
    try {
      const { accountId: id, error: err } = await api(`/api/account?profile=${encodeURIComponent(p)}`);
      if (err) { setError(`Account lookup failed: ${err}`); return; }
      setAccountId(id ?? '');
    } catch { setAccountId('(error)'); }
    try {
      const cache = await api(`/api/cache-status?profile=${encodeURIComponent(p)}`);
      if (cache.valid) setStacks(cache.stacks);
    } catch { /* no cache */ }
  };

  const scan = useCallback(async () => {
    if (!profile) return;
    setLoading(true); setStacks([]); setDdbItems([]); setDdbTable(''); setError('');
    try {
      const data = await api(`/api/stacks?profile=${encodeURIComponent(profile)}&refresh=true`);
      if (data.error) setError(data.error); else setStacks(data);
    } catch (e) {
      setError(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLoading(false);
  }, [profile]);

  const loadTables = async (region: string) => {
    setDdbRegion(region); setDdbItems([]); setDdbTable('');
    const data = await api(`/api/ddb/tables?profile=${encodeURIComponent(profile)}&region=${region}`);
    setTables(data);
    if (data.length === 1) loadDdb(region, data[0]);
  };

  const loadDdb = async (region: string, table: string) => {
    setDdbTable(table);
    const data = await api(`/api/ddb?profile=${encodeURIComponent(profile)}&region=${region}&table=${table}`);
    setDdbItems(data.items ?? []);
  };

  const loadSsm = async (region: string, name: string) => {
    const key = `${region}:${name}`;
    if (ssmCache[key]) return;
    const data = await api(`/api/ssm?profile=${encodeURIComponent(profile)}&region=${region}&name=${encodeURIComponent(name)}`);
    setSsmCache((prev) => ({ ...prev, [key]: data }));
  };

  const cellVal = (v: any): string => v?.S ?? v?.N ?? v?.BOOL?.toString() ?? JSON.stringify(v);

  const exportTenant = async (stack: Stack) => {
    const env = stack.envVars ?? {};
    const tryParse = (v?: string) => { try { return JSON.parse(v ?? ''); } catch { return v; } };
    const notifiers = tryParse(env['NOTIFIERS']);
    const summarizers = tryParse(env['SUMMARIZERS']);
    const config: Record<string, unknown> = {
      _exportedFrom: { accountId, region: stack.region, stackName: stack.stackName, exportedAt: new Date().toISOString() },
    };
    if (stack.tenant !== '(default)') config.tenant = stack.tenant;
    if (env['MODEL_REGION']) config.modelRegion = env['MODEL_REGION'];
    const modelIds = tryParse(env['MODEL_IDS']);
    if (modelIds) config.modelIds = modelIds;
    else if (env['MODEL_ID']) config.modelIds = [env['MODEL_ID']];
    if (summarizers) config.summarizers = summarizers;
    if (notifiers) config.notifiers = notifiers;
    if (!notifiers && env['APP']) {
      config.notifiers = {
        default: { destination: env['APP'], summarizerName: 'default', webhookUrlParameterName: env['SSM_APP_URL_NAME'] ?? '/WhatsNew/URL', rssUrl: { "What's new": 'https://aws.amazon.com/about-aws/whats-new/recent/feed/' } },
      };
    }
    if (!summarizers && env['LANGUAGE']) {
      config.summarizers = { default: { outputLanguage: env['LANGUAGE'], persona: env['PERSONA'] ?? '' } };
    }
    try {
      const r = await post('/api/export-tenant', { tenant: stack.tenant === '(default)' ? 'default' : stack.tenant, region: stack.region, accountId, config });
      showToast(`Exported to ${r.path}`);
    } catch { showToast('Export failed', false); }
  };

  // ─── GUI ↔ JSON sync ───

  const guiToJson = (g: typeof guiConfig) => {
    const obj: Record<string, unknown> = {};
    if (g.modelRegion) obj.modelRegion = g.modelRegion;
    if (g.modelIds.length) obj.modelIds = g.modelIds;
    if (Object.keys(g.notifiers).length) obj.notifiers = g.notifiers;
    if (Object.keys(g.summarizers).length) obj.summarizers = g.summarizers;
    return JSON.stringify(obj, null, 2);
  };

  const jsonToGui = (json: string) => {
    try {
      const p = JSON.parse(json);
      setGuiConfig({
        modelRegion: p.modelRegion ?? '',
        modelIds: Array.isArray(p.modelIds) ? p.modelIds : p.modelIds ? [p.modelIds] : [],
        notifiers: p.notifiers ?? {},
        summarizers: p.summarizers ?? {},
      });
      setConfigError('');
    } catch { setConfigError('Invalid JSON'); }
  };

  const updateGui = (patch: Partial<typeof guiConfig>) => {
    const next = { ...guiConfig, ...patch };
    setGuiConfig(next);
    setConfigJson(guiToJson(next));
  };

  const loadBedrockModels = async (region: string) => {
    if (!profile || !region) return;
    setModelsRegion(region);
    setBedrockModels([]);
    try {
      const data = await api(`/api/bedrock/models?profile=${encodeURIComponent(profile)}&region=${encodeURIComponent(region)}`);
      if (Array.isArray(data)) setBedrockModels(data);
    } catch { /* ignore */ }
  };

  const loadSsmParams = async (region: string) => {
    if (!profile || !region) return;
    try {
      const data = await api(`/api/ssm/list?profile=${encodeURIComponent(profile)}&region=${encodeURIComponent(region)}`);
      if (Array.isArray(data)) setExistingSsmParams(data);
    } catch { setExistingSsmParams([]); }
  };

  // ─── Deploy actions ───

  const openDeploy = (mode: DeployMode, stack?: Stack) => {
    setDeployMode(mode);
    setDeployTarget(stack ?? null);
    setDestroyConfirm('');
    setConfigError('');
    setEditorTab('gui');
    if (mode === 'update' && stack) {
      const env = stack.envVars ?? {};
      const tryParse = (v?: string) => { try { return JSON.parse(v ?? ''); } catch { return null; } };
      const notifiers = tryParse(env['NOTIFIERS']);
      const summarizers = tryParse(env['SUMMARIZERS']);
      const firstNotifier = notifiers ? Object.values(notifiers)[0] as any : null;
      // Reconstruct config from envVars
      const config: Record<string, unknown> = {};
      if (stack.tenant !== '(default)') config.tenant = stack.tenant;
      const mr = env['MODEL_REGION'] ?? '';
      if (mr) config.modelRegion = mr;
      const modelIds = tryParse(env['MODEL_IDS']);
      const mids = modelIds ? modelIds : env['MODEL_ID'] ? [env['MODEL_ID']] : [];
      if (mids.length) config.modelIds = mids;
      if (notifiers) config.notifiers = notifiers;
      else if (env['APP']) {
        config.notifiers = { default: { destination: env['APP'], summarizerName: 'default', webhookUrlParameterName: env['SSM_APP_URL_NAME'] ?? '/WhatsNew/URL', rssUrl: { "What's new": 'https://aws.amazon.com/about-aws/whats-new/recent/feed/' } } };
      }
      if (summarizers) config.summarizers = summarizers;
      else if (env['LANGUAGE']) {
        config.summarizers = { default: { outputLanguage: env['LANGUAGE'], persona: env['PERSONA'] ?? '' } };
      }
      const json = JSON.stringify(config, null, 2);
      setConfigJson(json);
      jsonToGui(json);
      setDeployForm({
        tenant: stack.tenant === '(default)' ? '' : stack.tenant,
        destination: firstNotifier?.destination ?? env['APP'] ?? 'slack',
        language: env['LANGUAGE'] === 'english' ? 'english' : 'japanese',
        webhookUrl: '',
        deployRegion: stack.region,
        skipSsm: false,
        ssmParamName: '',
      });
      loadSsmParams(stack.region);
      if (mr) loadBedrockModels(mr);
    } else if (mode === 'new') {
      setDeployForm({ tenant: '', destination: 'slack', language: 'japanese', webhookUrl: '', deployRegion: '', skipSsm: false, ssmParamName: '' });
      setExistingSsmParams([]);
      setConfigJson('');
      setGuiConfig({ modelRegion: '', modelIds: [], notifiers: {}, summarizers: {} });
    }
  };

  const submitDeploy = async () => {
    setDeploying(true);
    // Parse config JSON if provided
    let cdkContext: any = undefined;
    if (configJson.trim()) {
      try {
        const parsed = JSON.parse(configJson);
        // Extract tenant/webhookUrl from JSON if present, rest goes to cdkContext
        const { tenant: _t, webhookUrl: _w, ...rest } = parsed;
        cdkContext = rest;
      } catch (e) {
        setConfigError('Invalid JSON');
        setDeploying(false);
        return;
      }
    }
    try {
      let result;
      if (deployMode === 'new') {
        result = await post('/api/deploy', { ...deployForm, cdkContext, profile, region: deployForm.deployRegion || undefined, skipSsm: deployForm.skipSsm, ssmParamName: deployForm.ssmParamName || undefined });
      } else if (deployMode === 'update' && deployTarget) {
        result = await post('/api/deploy/update', {
          ...deployForm,
          tenant: deployTarget.tenant === '(default)' ? '' : deployTarget.tenant,
          region: deployTarget.region,
          webhookUrl: deployForm.webhookUrl || undefined,
          skipSsm: deployForm.skipSsm,
          ssmParamName: deployForm.ssmParamName || undefined,
          cdkContext,
          profile,
        });
      } else if (deployMode === 'destroy' && deployTarget) {
        result = await post('/api/deploy/destroy', {
          tenant: deployTarget.tenant,
          region: deployTarget.region,
          profile,
          confirmTenant: destroyConfirm,
        });
      }
      if (result?.error) {
        showToast(result.error, false);
        setDeploying(false);
        return;
      }
      setBuildInfo({
        buildId: result.buildId,
        projectName: result.projectName,
        region: result.region,
        status: 'IN_PROGRESS',
        logs: [],
        nextToken: null,
        mode: deployMode,
        tenant: deployTarget?.tenant ?? deployForm.tenant ?? '',
      });
      setDeployMode(null);
    } catch (e: any) {
      showToast(e.message, false);
    }
    setDeploying(false);
  };

  const invokeCrawler = async (s: Stack) => {
    if (!confirm(`Invoke RSS crawler for "${s.tenant}" in ${s.region}?\nThis will trigger RSS fetch and notification immediately.`)) return;
    setTestingStack(s.stackName + s.region);
    try {
      const result = await post('/api/invoke-crawler', { stackName: s.stackName, region: s.region, profile });
      if (result.error) showToast(`Test failed: ${result.error}`, false);
      else showToast(`Crawler invoked: ${result.functionName} (${result.results.length} notifier(s))`);
    } catch (e: any) { showToast(e.message, false); }
    setTestingStack('');
  };

  // Poll build status & logs
  useEffect(() => {
    if (!buildInfo || buildInfo.status !== 'IN_PROGRESS') return;
    const interval = setInterval(async () => {
      try {
        const [statusRes, logsRes] = await Promise.all([
          api(`/api/deploy/status?buildId=${encodeURIComponent(buildInfo.buildId)}&profile=${encodeURIComponent(profile)}&region=${encodeURIComponent(buildInfo.region)}`),
          api(`/api/deploy/logs?buildId=${encodeURIComponent(buildInfo.buildId)}&profile=${encodeURIComponent(profile)}&region=${encodeURIComponent(buildInfo.region)}${buildInfo.nextToken ? `&nextToken=${encodeURIComponent(buildInfo.nextToken)}` : ''}`),
        ]);
        const newLogs = (logsRes.events ?? []).map((e: any) => e.message ?? '');
        setBuildInfo((prev) => prev ? {
          ...prev,
          status: statusRes.status ?? prev.status,
          logs: [...prev.logs, ...newLogs],
          nextToken: logsRes.nextToken ?? prev.nextToken,
        } : null);
        if (statusRes.status === 'SUCCEEDED') {
          showToast('Build succeeded!');
          scan();
          if (buildInfo.mode === 'destroy') {
            post('/api/deploy/cleanup', { tenant: buildInfo.tenant, profile, region: buildInfo.region });
          }
        } else if (statusRes.status === 'FAILED') {
          showToast('Build failed', false);
        }
      } catch { /* retry next interval */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [buildInfo?.buildId, buildInfo?.status, buildInfo?.nextToken, profile]);

  // Auto-scroll logs
  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [buildInfo?.logs.length]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">📰</span>
            <h1 className="text-lg font-semibold text-gray-900">Whats New Summary Notifier</h1>
            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Management Console</span>
          </div>
          <div className="flex items-center gap-2">
            {profile && (
              <button onClick={() => openDeploy('new')}
                className="px-3 py-1.5 bg-green-600 text-white text-sm rounded-md hover:bg-green-700">
                + Deploy New Tenant
              </button>
            )}
            <button onClick={() => setShowHelp(!showHelp)}
              className="w-8 h-8 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 text-sm font-bold">?</button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-6" style={buildInfo && !buildMinimized ? { paddingBottom: '340px' } : undefined}>
        <main className="w-full">
          {/* Profile selector */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium text-gray-700">AWS Profile</label>
              <select value={profile} onChange={(e) => selectProfile(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
                <option value="">-- select --</option>
                {profiles.map((p) => <option key={p}>{p}</option>)}
              </select>
              {accountId && (
                <span className="text-xs text-gray-500 font-mono bg-gray-100 px-2 py-1 rounded">
                  Account: {accountId}
                </span>
              )}
              <button onClick={scan} disabled={!profile || loading}
                className="ml-auto px-4 py-1.5 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {loading ? '⏳ Scanning...' : '🔍 Scan Regions'}
              </button>
            </div>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-6 flex items-center justify-between">
              <span className="text-sm text-red-700">⚠️ {error}</span>
              <button onClick={() => setError('')} className="text-red-400 hover:text-red-600 text-sm">✕</button>
            </div>
          )}

          {/* Stacks */}
          {stacks.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200 mb-6">
              <div className="px-4 py-3 border-b border-gray-200">
                <h2 className="text-sm font-semibold text-gray-900">
                  Deployed Stacks <span className="text-gray-400 font-normal">({stacks.length})</span>
                </h2>
              </div>
              <div className="divide-y divide-gray-100">
                {stacks.map((s) => (
                  <div key={s.stackName + s.region}>
                    <div className="px-4 py-3 flex items-center gap-4 hover:bg-gray-50">
                      <span className="text-xs font-mono bg-gray-100 text-gray-600 px-2 py-0.5 rounded w-32 text-center shrink-0">{s.region}</span>
                      <span className="text-sm font-medium text-gray-900 w-24 shrink-0">{s.tenant}</span>
                      <code className="text-xs text-gray-500 truncate flex-1">{s.stackName}</code>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${s.status.includes('COMPLETE') ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{s.status}</span>
                      <span className="text-xs text-gray-400 w-36 text-right shrink-0">
                        {s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '-'}
                      </span>
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => setExpanded(expanded === s.stackName + s.region ? null : s.stackName + s.region)}
                          className="px-2.5 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100">
                          {expanded === s.stackName + s.region ? '▲ Hide' : '▼ Details'}
                        </button>
                        <button onClick={() => loadTables(s.region)}
                          className="px-2.5 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100">📊 DDB</button>
                        <button onClick={() => exportTenant(s)}
                          className="px-2.5 py-1 text-xs border border-gray-300 rounded hover:bg-gray-100">📤 Export</button>
                        <button onClick={() => openDeploy('update', s)}
                          className="px-2.5 py-1 text-xs border border-blue-300 text-blue-700 rounded hover:bg-blue-50">🔄 Update</button>
                        <button onClick={() => invokeCrawler(s)} disabled={testingStack === s.stackName + s.region}
                          className="px-2.5 py-1 text-xs border border-green-300 text-green-700 rounded hover:bg-green-50 disabled:opacity-50">
                          {testingStack === s.stackName + s.region ? '⏳' : '▶️'} Test
                        </button>
                        <button onClick={() => openDeploy('destroy', s)}
                          className="px-2.5 py-1 text-xs border border-red-300 text-red-700 rounded hover:bg-red-50">🗑️ Destroy</button>
                      </div>
                    </div>
                    {expanded === s.stackName + s.region && (
                      <StackDetail stack={s} profile={profile} ssmCache={ssmCache} onLoadSsm={loadSsm} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {stacks.length === 0 && !loading && profile && (
            <div className="text-center py-12 text-gray-400 text-sm">
              No stacks found. Click "Scan Regions" to search across all regions.
            </div>
          )}

          {/* DDB Preview */}
          {tables.length > 0 && (
            <div className="bg-white rounded-lg border border-gray-200">
              <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-3">
                <h2 className="text-sm font-semibold text-gray-900">📊 DynamoDB</h2>
                <span className="text-xs text-gray-400 font-mono">{ddbRegion}</span>
                <div className="flex gap-1 ml-auto">
                  {tables.map((t) => (
                    <button key={t} onClick={() => loadDdb(ddbRegion, t)}
                      className={`px-3 py-1 text-xs rounded border ${t === ddbTable ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-gray-300 hover:bg-gray-50'}`}>{t}</button>
                  ))}
                </div>
              </div>
              {ddbItems.length > 0 && (
                <div className="p-4">
                  <p className="text-xs text-gray-500 mb-3">{ddbItems.length} items (max 50)</p>
                  <div className="space-y-2 max-h-[600px] overflow-auto">
                    {ddbItems
                      .sort((a, b) => (cellVal(b.pubtime) ?? '').localeCompare(cellVal(a.pubtime) ?? ''))
                      .map((item, i) => (
                      <div key={i} className="border border-gray-200 rounded-lg p-3 hover:border-gray-300 hover:shadow-sm transition-all">
                        <div className="flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <a href={cellVal(item.url)} target="_blank" rel="noopener noreferrer"
                              className="text-sm font-medium text-blue-700 hover:text-blue-900 hover:underline line-clamp-2">
                              {cellVal(item.title)}
                            </a>
                            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                              {item.pubtime && <span className="text-xs text-gray-500">🕐 {new Date(cellVal(item.pubtime)).toLocaleString()}</span>}
                              {item.category && <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{cellVal(item.category)}</span>}
                              {item.notifier_name && <span className="text-xs bg-purple-50 text-purple-600 px-2 py-0.5 rounded-full">{cellVal(item.notifier_name)}</span>}
                              {item.summary_status && <span className={`text-xs px-2 py-0.5 rounded-full ${cellVal(item.summary_status) === 'completed' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'}`}>{cellVal(item.summary_status)}</span>}
                              {item.model_id && <span className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full font-mono">{cellVal(item.model_id)}</span>}
                              {item.latency_sec && <span className="text-xs text-gray-500">⏱ {cellVal(item.latency_sec)}s</span>}
                              {item.input_tokens && <span className="text-xs text-gray-400">in:{cellVal(item.input_tokens)} out:{cellVal(item.output_tokens)}</span>}
                            </div>
                            {item.summary && (
                              <p className="text-xs text-gray-700 mt-2 bg-green-50 rounded p-2">{cellVal(item.summary)}</p>
                            )}
                            {item.detail && (
                              <details className="mt-1">
                                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">Detail</summary>
                                <pre className="text-xs text-gray-600 mt-1 whitespace-pre-wrap bg-gray-50 rounded p-2">{cellVal(item.detail)}</pre>
                              </details>
                            )}
                          </div>
                          <a href={cellVal(item.url)} target="_blank" rel="noopener noreferrer"
                            className="shrink-0 text-xs text-gray-400 hover:text-blue-600">↗</a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {ddbTable && ddbItems.length === 0 && (
                <div className="p-8 text-center text-sm text-gray-400">No items in table</div>
              )}
            </div>
          )}
        </main>
      </div>

      {/* Help drawer (right side) */}
      <div className={`fixed top-0 right-0 h-full w-80 bg-white border-l border-gray-200 shadow-xl z-50 transform transition-transform duration-200 ${showHelp ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-4 h-full overflow-auto">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900">ℹ️ About this tool</h3>
            <button onClick={() => setShowHelp(false)} className="text-gray-400 hover:text-gray-600">✕</button>
          </div>
          <div className="text-xs text-gray-600 space-y-3">
            <p><strong>Whats New Summary Notifier Management Console</strong> is a local dashboard for managing deployed stacks.</p>
            <div>
              <p className="font-semibold text-gray-700 mb-1">Features</p>
              <ul className="list-disc pl-4 space-y-1">
                <li>Select an AWS CLI profile to authenticate</li>
                <li>Scan all regions for deployed stacks</li>
                <li>View stack details: Summarizer/Notifier config, SSM parameters</li>
                <li>Preview DynamoDB RSS history table</li>
                <li>Deploy new tenants / Update / Destroy via CodeBuild</li>
              </ul>
            </div>
            <div>
              <p className="font-semibold text-gray-700 mb-1">How it works</p>
              <p>A local Express API server (port 3456) uses your AWS CLI credentials to call AWS APIs. The frontend (port 5173) proxies API requests to it. No data leaves your machine except AWS API calls.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Deploy Modal */}
      {deployMode && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => { setDeployMode(null); }}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className={`px-6 py-4 border-b rounded-t-xl shrink-0 ${deployMode === 'destroy' ? 'bg-red-50 border-red-200' : 'bg-blue-50 border-blue-200'}`}>
              <h3 className="text-base font-semibold">
                {deployMode === 'new' && '🚀 Deploy New Tenant'}
                {deployMode === 'update' && `🔄 Update: ${deployTarget?.tenant}`}
                {deployMode === 'destroy' && `🗑️ Destroy: ${deployTarget?.tenant}`}
              </h3>
            </div>
            <div className="px-6 py-4 space-y-4 overflow-auto flex-1">
              {deployMode === 'destroy' ? (
                <>
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
                    ⚠️ This will permanently destroy the stack <strong>{deployTarget?.stackName}</strong> in <strong>{deployTarget?.region}</strong>.
                    CodeBuild project, IAM role, and SSM parameter will also be cleaned up.
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Type "<strong>{deployTarget?.tenant === '(default)' ? 'default' : deployTarget?.tenant}</strong>" to confirm
                    </label>
                    <input value={destroyConfirm} onChange={(e) => setDestroyConfirm(e.target.value)}
                      className="w-full border border-red-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-red-500"
                      placeholder="Enter tenant name..." />
                  </div>
                </>
              ) : (
                <>
                  {/* Basic fields */}
                  <div className="space-y-3">
                    {deployMode === 'new' && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">Tenant Name</label>
                          <input value={deployForm.tenant} onChange={(e) => setDeployForm({ ...deployForm, tenant: e.target.value })}
                            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm" placeholder="(default)" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">Deploy Region</label>
                          <select value={deployForm.deployRegion} onChange={(e) => { setDeployForm({ ...deployForm, deployRegion: e.target.value }); loadSsmParams(e.target.value); }}
                            className="w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white">
                            <option value="">(profile default)</option>
                            {BEDROCK_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                      </div>
                    )}
                    {!deployForm.skipSsm && (
                      <div className="border border-gray-200 rounded-lg p-3 space-y-2">
                        <label className="block text-xs font-medium text-gray-700">Register new Webhook URL</label>
                        <div className="grid grid-cols-2 gap-2">
                          <input value={deployForm.webhookUrl} onChange={(e) => setDeployForm({ ...deployForm, webhookUrl: e.target.value })}
                            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm" placeholder="https://hooks.slack.com/..." />
                          <input value={deployForm.ssmParamName} onChange={(e) => setDeployForm({ ...deployForm, ssmParamName: e.target.value })}
                            className="border border-gray-300 rounded-md px-2 py-1.5 text-sm font-mono" placeholder={`SSM name: /WhatsNew/URL${deployForm.tenant ? `/${deployForm.tenant}` : ''}`} />
                        </div>
                        <p className="text-xs text-gray-400">Registers Webhook URL to SSM. Leave SSM name empty for default. {deployMode === 'update' && 'Webhook URL empty = skip registration.'}</p>
                      </div>
                    )}
                  </div>

                  {/* Tab switcher */}
                  <div className="flex items-center gap-1 border-b border-gray-200">
                    <button onClick={() => setEditorTab('gui')}
                      className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${editorTab === 'gui' ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                      🛠️ GUI Editor
                    </button>
                    <button onClick={() => { setEditorTab('json'); setConfigJson(guiToJson(guiConfig)); }}
                      className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${editorTab === 'json' ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                      📝 JSON
                    </button>
                    {deployMode === 'new' && (
                      <label className="ml-auto text-xs text-blue-600 hover:text-blue-800 cursor-pointer">
                        📁 Load file...
                        <input type="file" accept=".json" className="hidden" onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = () => {
                            try {
                              const parsed = JSON.parse(reader.result as string);
                              const json = JSON.stringify(parsed, null, 2);
                              setConfigJson(json);
                              jsonToGui(json);
                              setConfigError('');
                              if (parsed.tenant) setDeployForm((f) => ({ ...f, tenant: parsed.tenant }));
                            } catch { setConfigError('Invalid JSON file'); }
                          };
                          reader.readAsText(file);
                          e.target.value = '';
                        }} />
                      </label>
                    )}
                  </div>

                  {editorTab === 'gui' ? (
                    <div className="space-y-3">
                      {/* Model config */}
                      <fieldset className="border border-gray-200 rounded-lg p-3 space-y-2">
                        <legend className="text-xs font-semibold text-gray-600 px-1">🤖 Model Configuration</legend>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Model Region</label>
                            <select value={guiConfig.modelRegion}
                              onChange={(e) => { updateGui({ modelRegion: e.target.value }); loadBedrockModels(e.target.value); }}
                              className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white">
                              <option value="">-- select --</option>
                              {BEDROCK_REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-gray-600 mb-1">Model IDs (fallback pool)</label>
                            <div className="space-y-1">
                              {guiConfig.modelIds.map((id, i) => (
                                <div key={i} className="flex gap-1">
                                  <input value={id} list="bedrock-models"
                                    onChange={(e) => { const ids = [...guiConfig.modelIds]; ids[i] = e.target.value; updateGui({ modelIds: ids }); }}
                                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs font-mono" placeholder="Model ID" />
                                  <button onClick={() => { const ids = guiConfig.modelIds.filter((_, j) => j !== i); updateGui({ modelIds: ids }); }}
                                    className="text-red-400 hover:text-red-600 text-xs px-1">✕</button>
                                </div>
                              ))}
                              <button onClick={() => updateGui({ modelIds: [...guiConfig.modelIds, ''] })}
                                className="text-xs text-blue-600 hover:text-blue-800">+ Add model</button>
                            </div>
                            <datalist id="bedrock-models">
                              {bedrockModels.map((m) => <option key={m.modelId} value={m.modelId} label={`${m.provider} — ${m.modelName}`} />)}
                            </datalist>
                          </div>
                        </div>
                      </fieldset>

                      {/* Summarizers (before Notifiers — Notifiers reference Summarizer names) */}
                      <fieldset className="border border-gray-200 rounded-lg p-3 space-y-2">
                        <legend className="text-xs font-semibold text-gray-600 px-1">📝 Summarizers</legend>
                        {Object.entries(guiConfig.summarizers).map(([key, s], idx) => (
                          <div key={idx} className="border border-gray-100 rounded p-2 space-y-1.5 bg-gray-50">
                            <div className="flex items-center justify-between">
                              <input value={key} onChange={(e) => {
                                const entries = Object.entries(guiConfig.summarizers);
                                entries[idx] = [e.target.value, s];
                                updateGui({ summarizers: Object.fromEntries(entries) });
                              }} className="text-xs font-semibold bg-transparent border-b border-gray-300 focus:border-blue-500 outline-none" />
                              <button onClick={() => { const { [key]: _, ...rest } = guiConfig.summarizers; updateGui({ summarizers: rest }); }}
                                className="text-red-400 hover:text-red-600 text-xs">✕ Remove</button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-xs text-gray-500">Language</label>
                                <input value={s.outputLanguage} onChange={(e) => updateGui({ summarizers: { ...guiConfig.summarizers, [key]: { ...s, outputLanguage: e.target.value } } })}
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                              </div>
                              <div>
                                <label className="text-xs text-gray-500">Persona</label>
                                <input value={s.persona} onChange={(e) => updateGui({ summarizers: { ...guiConfig.summarizers, [key]: { ...s, persona: e.target.value } } })}
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs" />
                              </div>
                            </div>
                          </div>
                        ))}
                        <button onClick={() => updateGui({ summarizers: { ...guiConfig.summarizers, [`Summarizer${Object.keys(guiConfig.summarizers).length + 1}`]: { outputLanguage: 'japanese', persona: '' } } })}
                          className="text-xs text-blue-600 hover:text-blue-800">+ Add summarizer</button>
                      </fieldset>

                      {/* Notifiers */}
                      <fieldset className="border border-gray-200 rounded-lg p-3 space-y-2">
                        <legend className="text-xs font-semibold text-gray-600 px-1">🔔 Notifiers</legend>
                        {Object.entries(guiConfig.notifiers).map(([key, n], idx) => (
                          <div key={idx} className="border border-gray-100 rounded p-2 space-y-1.5 bg-gray-50">
                            <div className="flex items-center justify-between">
                              <input value={key} onChange={(e) => {
                                const entries = Object.entries(guiConfig.notifiers);
                                entries[idx] = [e.target.value, n];
                                updateGui({ notifiers: Object.fromEntries(entries) });
                              }} className="text-xs font-semibold bg-transparent border-b border-gray-300 focus:border-blue-500 outline-none" />
                              <button onClick={() => { const { [key]: _, ...rest } = guiConfig.notifiers; updateGui({ notifiers: rest }); }}
                                className="text-red-400 hover:text-red-600 text-xs">✕ Remove</button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className="text-xs text-gray-500">Destination</label>
                                <select value={n.destination} onChange={(e) => updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, destination: e.target.value } } })}
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white">
                                  <option value="slack">Slack</option><option value="teams">Teams</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500">Summarizer</label>
                                <select value={n.summarizerName} onChange={(e) => updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, summarizerName: e.target.value } } })}
                                  className="w-full border border-gray-300 rounded px-2 py-1 text-xs bg-white">
                                  {Object.keys(guiConfig.summarizers).map((sk) => <option key={sk} value={sk}>{sk}</option>)}
                                  {!Object.keys(guiConfig.summarizers).includes(n.summarizerName) && (
                                    <option value={n.summarizerName}>{n.summarizerName} (not defined)</option>
                                  )}
                                </select>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500">SSM Param Name</label>
                                <div className="flex gap-1">
                                  <select value={existingSsmParams.some((p) => p.name === n.webhookUrlParameterName) ? n.webhookUrlParameterName : ''}
                                    onChange={(e) => { if (e.target.value) updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, webhookUrlParameterName: e.target.value } } }); }}
                                    className="flex-1 border border-gray-300 rounded px-1 py-1 text-xs bg-white">
                                    <option value="">custom...</option>
                                    {existingSsmParams.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                                  </select>
                                  <input value={n.webhookUrlParameterName} onChange={(e) => updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, webhookUrlParameterName: e.target.value } } })}
                                    className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs font-mono" placeholder="/WhatsNew/..." />
                                </div>
                              </div>
                              <div>
                                <label className="text-xs text-gray-500">RSS URLs</label>
                                {Object.entries(n.rssUrl).map(([rk, rv], ri) => (
                                  <div key={ri} className="flex gap-1 mb-1">
                                    <input value={rk} onChange={(e) => {
                                      const entries = Object.entries(n.rssUrl);
                                      entries[ri] = [e.target.value, rv];
                                      updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, rssUrl: Object.fromEntries(entries) } } });
                                    }} className="w-24 border border-gray-300 rounded px-1 py-0.5 text-xs" placeholder="Name" />
                                    <input value={rv} onChange={(e) => updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, rssUrl: { ...n.rssUrl, [rk]: e.target.value } } } })}
                                      className="flex-1 border border-gray-300 rounded px-1 py-0.5 text-xs font-mono" placeholder="URL" />
                                    <button onClick={() => { const { [rk]: _, ...rest } = n.rssUrl; updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, rssUrl: rest } } }); }}
                                      className="text-red-400 text-xs">✕</button>
                                  </div>
                                ))}
                                <button onClick={() => updateGui({ notifiers: { ...guiConfig.notifiers, [key]: { ...n, rssUrl: { ...n.rssUrl, '': '' } } } })}
                                  className="text-xs text-blue-600">+ Add RSS</button>
                              </div>
                            </div>
                          </div>
                        ))}
                        <button onClick={() => updateGui({ notifiers: { ...guiConfig.notifiers, [`Notifier${Object.keys(guiConfig.notifiers).length + 1}`]: { destination: 'slack', summarizerName: Object.keys(guiConfig.summarizers)[0] ?? 'default', webhookUrlParameterName: '/WhatsNew/URL', rssUrl: { "What's new": 'https://aws.amazon.com/about-aws/whats-new/recent/feed/' } } } })}
                          className="text-xs text-blue-600 hover:text-blue-800">+ Add notifier</button>
                      </fieldset>
                    </div>
                  ) : (
                    /* JSON tab */
                    <div
                      className={`relative border rounded-md ${configError ? 'border-red-300' : 'border-gray-300'}`}
                      onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('ring-2', 'ring-blue-400'); }}
                      onDragLeave={(e) => { e.currentTarget.classList.remove('ring-2', 'ring-blue-400'); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.remove('ring-2', 'ring-blue-400');
                        const file = e.dataTransfer.files[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          try {
                            const parsed = JSON.parse(reader.result as string);
                            const json = JSON.stringify(parsed, null, 2);
                            setConfigJson(json);
                            jsonToGui(json);
                            if (parsed.tenant) setDeployForm((f) => ({ ...f, tenant: parsed.tenant }));
                          } catch { setConfigError('Invalid JSON file'); }
                        };
                        reader.readAsText(file);
                      }}
                    >
                      <textarea
                        value={configJson}
                        onChange={(e) => { setConfigJson(e.target.value); setConfigError(''); }}
                        onBlur={() => { if (configJson.trim()) jsonToGui(configJson); }}
                        className="w-full h-64 px-3 py-2 text-xs font-mono bg-gray-50 rounded-md resize-y focus:ring-2 focus:ring-blue-500 focus:outline-none"
                        placeholder="Drop a JSON file here, or paste/edit config..."
                        spellCheck={false}
                      />
                    </div>
                  )}
                  {configError && <p className="text-xs text-red-600 mt-1">⚠️ {configError}</p>}
                </>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3 shrink-0">
              <button onClick={() => setDeployMode(null)} className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
              <button onClick={submitDeploy} disabled={deploying || (deployMode === 'new' && !deployForm.skipSsm && !deployForm.webhookUrl && !configJson.trim()) || (deployMode === 'new' && deployForm.skipSsm && !deployForm.ssmParamName) || (deployMode === 'destroy' && destroyConfirm !== (deployTarget?.tenant === '(default)' ? 'default' : deployTarget?.tenant))}
                className={`px-4 py-2 text-sm text-white rounded-md disabled:opacity-50 disabled:cursor-not-allowed ${deployMode === 'destroy' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
                {deploying ? '⏳ Starting...' : deployMode === 'destroy' ? '🗑️ Destroy' : deployMode === 'update' ? '🔄 Update' : '🚀 Deploy'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Build Console */}
      {buildInfo && (
        <div className="fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 shadow-2xl z-40"
          style={{ height: buildMinimized ? '44px' : '320px' }}>
          <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-gray-700 cursor-pointer"
            onClick={() => setBuildMinimized(!buildMinimized)}>
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-200">🔨 Build Console</span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                buildInfo.status === 'IN_PROGRESS' ? 'bg-blue-900 text-blue-300' :
                buildInfo.status === 'SUCCEEDED' ? 'bg-green-900 text-green-300' :
                'bg-red-900 text-red-300'
              }`}>
                {buildInfo.status === 'IN_PROGRESS' ? '🔵' : buildInfo.status === 'SUCCEEDED' ? '🟢' : '🔴'} {buildInfo.status}
              </span>
              <code className="text-xs text-gray-500">{buildInfo.buildId}</code>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={(e) => { e.stopPropagation(); setBuildMinimized(!buildMinimized); }}
                className="text-gray-400 hover:text-white text-sm px-2 py-1 rounded hover:bg-gray-700">
                {buildMinimized ? '▲' : '▼'}
              </button>
              {buildInfo.status !== 'IN_PROGRESS' && (
                <button onClick={(e) => { e.stopPropagation(); setBuildInfo(null); }}
                  className="text-gray-400 hover:text-white text-sm px-2 py-1 rounded hover:bg-gray-700">✕</button>
              )}
            </div>
          </div>
          {!buildMinimized && (
            <div className="overflow-auto p-4 font-mono text-xs text-green-400 leading-relaxed" style={{ height: 'calc(100% - 44px)' }}>
              {buildInfo.logs.length === 0 && buildInfo.status === 'IN_PROGRESS' && (
                <div className="text-gray-500">Waiting for logs...</div>
              )}
              {buildInfo.logs.map((line, i) => <div key={i}>{line}</div>)}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`fixed ${buildInfo && !buildMinimized ? 'bottom-[340px]' : buildInfo ? 'bottom-[60px]' : 'bottom-6'} right-6 max-w-md px-4 py-3 rounded-lg shadow-lg border text-sm transition-all ${
          toast.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'
        }`}>
          <div className="flex items-start gap-2">
            <span>{toast.ok ? '✅' : '❌'}</span>
            <div>{toast.msg}</div>
            <button onClick={() => setToast(null)} className="ml-auto opacity-50 hover:opacity-100">✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StackDetail({ stack, profile, ssmCache, onLoadSsm }: {
  stack: Stack; profile: string;
  ssmCache: Record<string, any>;
  onLoadSsm: (region: string, name: string) => void;
}) {
  const env = stack.envVars ?? {};
  const tryParse = (v?: string) => { try { return JSON.parse(v ?? ''); } catch { return v; } };
  const modelIds = tryParse(env['MODEL_IDS']) ?? env['MODEL_ID'];
  const modelRegion = env['MODEL_REGION'];
  const notifiers = tryParse(env['NOTIFIERS']);
  const summarizers = tryParse(env['SUMMARIZERS']);
  const legacyNotifier = !notifiers && env['APP'] ? { destination: env['APP'], webhookUrlParameterName: env['SSM_APP_URL_NAME'] } : null;
  const legacySummarizer = !summarizers && env['LANGUAGE'] ? { outputLanguage: env['LANGUAGE'], persona: env['PERSONA'] } : null;
  const displayNotifiers = notifiers ?? (legacyNotifier ? { default: legacyNotifier } : null);
  const displaySummarizers = summarizers ?? (legacySummarizer ? { default: legacySummarizer } : null);
  const ssmParams: string[] = [];
  if (displayNotifiers && typeof displayNotifiers === 'object') {
    Object.values(displayNotifiers).forEach((v: any) => { if (v?.webhookUrlParameterName) ssmParams.push(v.webhookUrlParameterName); });
  }

  return (
    <div className="px-4 py-4 bg-gray-50 border-t border-gray-100 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <ConfigCard title="🤖 Model Configuration">
          <KV label="Region" value={modelRegion} />
          <KV label="Model IDs (fallback pool)" value={Array.isArray(modelIds) ? JSON.stringify(modelIds, null, 2) : modelIds} json={Array.isArray(modelIds)} />
        </ConfigCard>
        <ConfigCard title="📝 Summarizers">
          {displaySummarizers && typeof displaySummarizers === 'object' ? (
            <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all">{JSON.stringify(displaySummarizers, null, 2)}</pre>
          ) : <span className="text-xs text-gray-400">Not found in Lambda environment</span>}
        </ConfigCard>
        <ConfigCard title="🔔 Notifiers">
          {displayNotifiers && typeof displayNotifiers === 'object' ? (
            <pre className="text-xs text-gray-700 whitespace-pre-wrap break-all">{JSON.stringify(displayNotifiers, null, 2)}</pre>
          ) : <span className="text-xs text-gray-400">Not found in Lambda environment</span>}
        </ConfigCard>
        <ConfigCard title="🔑 SSM Parameters">
          {ssmParams.length > 0 ? ssmParams.map((name) => {
            const key = `${stack.region}:${name}`;
            const cached = ssmCache[key];
            return (
              <div key={name} className="mb-2">
                <div className="flex items-center gap-2">
                  <code className="text-xs bg-gray-100 px-1.5 py-0.5 rounded">{name}</code>
                  {!cached && <button onClick={() => onLoadSsm(stack.region, name)} className="text-xs text-blue-600 hover:underline">Load</button>}
                </div>
                {cached && (
                  <div className="mt-1 text-xs text-gray-600 pl-2 border-l-2 border-gray-200">
                    <div>Type: {cached.type}</div>
                    <div>Value: {cached.value}</div>
                    <div>Version: {cached.version}</div>
                  </div>
                )}
              </div>
            );
          }) : <span className="text-xs text-gray-400">No SSM parameters detected</span>}
        </ConfigCard>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500 hover:text-gray-700">Raw CloudFormation Parameters & Outputs</summary>
        <div className="mt-2 grid grid-cols-2 gap-4">
          <div>
            <p className="font-medium text-gray-600 mb-1">Parameters ({stack.parameters.length})</p>
            <pre className="bg-white border border-gray-200 rounded p-2 overflow-auto max-h-60 text-gray-600">{JSON.stringify(stack.parameters, null, 2)}</pre>
          </div>
          <div>
            <p className="font-medium text-gray-600 mb-1">Outputs ({stack.outputs.length})</p>
            <pre className="bg-white border border-gray-200 rounded p-2 overflow-auto max-h-60 text-gray-600">{JSON.stringify(stack.outputs, null, 2)}</pre>
          </div>
        </div>
      </details>
    </div>
  );
}

function ConfigCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-3">
      <h4 className="text-xs font-semibold text-gray-700 mb-2">{title}</h4>
      {children}
    </div>
  );
}

function KV({ label, value, json }: { label: string; value?: string; json?: boolean }) {
  const display = json && value ? (() => { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } })() : value;
  return (
    <div className="mb-1.5">
      <span className="text-xs text-gray-500">{label}</span>
      {display ? (
        json ? <pre className="text-xs text-gray-700 mt-0.5 whitespace-pre-wrap break-all">{display}</pre>
             : <div className="text-xs text-gray-700 font-mono">{display}</div>
      ) : <div className="text-xs text-gray-400">-</div>}
    </div>
  );
}
