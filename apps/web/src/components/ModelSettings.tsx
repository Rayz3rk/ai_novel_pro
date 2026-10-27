import { useEffect, useState } from 'react';
import { Check, LoaderCircle, PlugZap, Plus } from 'lucide-react';
import type { ModelSettings as Settings, UpdateModelSettings } from '@shujian/contracts';
import { collaborationApi } from '../lib/collaboration-api';
import { errorMessage } from '../lib/api';
import { Dialog } from './Dialog';

export function ModelSettings({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [connections,setConnections]=useState<Settings[]>([]);
  const [creating,setCreating]=useState(false);
  const [models,setModels]=useState<string[]>([]);
  const presets:Record<string,{name:string;baseUrl:string;tokenParameter:'max_tokens'|'max_completion_tokens';sendTemperature:boolean}>={
    omgt:{name:'New API',baseUrl:'https://api.example.com/v1',tokenParameter:'max_tokens',sendTemperature:true},
    openai:{name:'OpenAI',baseUrl:'https://api.openai.com/v1',tokenParameter:'max_completion_tokens',sendTemperature:false},
    deepseek:{name:'DeepSeek',baseUrl:'https://api.deepseek.com',tokenParameter:'max_tokens',sendTemperature:true},
    ollama:{name:'本机 Ollama',baseUrl:'http://127.0.0.1:11434/v1',tokenParameter:'max_tokens',sendTemperature:true},
    lmstudio:{name:'本机 LM Studio',baseUrl:'http://127.0.0.1:1234/v1',tokenParameter:'max_tokens',sendTemperature:true},
  };
  const reloadConnections=async()=>{const result=await collaborationApi.connections();setConnections(result.connections);};
  useEffect(() => { let live = true; void collaborationApi.model().then(({ settings: value }) => { if (live) setSettings(value); }).catch((failure) => { if (live) setError(errorMessage(failure)); }); return () => { live = false; }; }, []);
  useEffect(()=>{void reloadConnections().catch((failure)=>setError(errorMessage(failure)));},[]);
  const update = <K extends keyof Settings>(field: K, value: Settings[K]) => { setSettings((old) => old ? { ...old, [field]: value } : old); setDirty(true); setNotice(null); };
  const save = async (test = false) => {
    if (!settings) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const { id: _id, hasApiKey: _hasApiKey, ...publicFields } = settings;
      const input: UpdateModelSettings = { ...publicFields, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(clearKey ? { clearApiKey: true } : {}) };
      const result = await (creating?collaborationApi.addConnection(input):collaborationApi.saveModel(input));
      setSettings(result.settings); setKey(''); setClearKey(false); setDirty(false);
      setCreating(false);await reloadConnections();
      if (test) { const response = await collaborationApi.testModel(); setNotice(response.message || '模型连接成功。'); }
      else setNotice('模型设置已保存。');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  };
  const priceField = (label: string, field: 'inputPricePerMillion' | 'outputPricePerMillion' | 'taskBudget' | 'dailyBudget') => <label>{label}<input type="number" min="0" step="any" placeholder="未知 / 不限制" value={settings?.[field] ?? ''} disabled={busy} onChange={(e) => update(field, e.target.value === '' ? null : Number(e.target.value))} /></label>;
  return <Dialog title="模型连接" subtitle="保存多个平台连接，选择当前使用的一个。每套连接的密钥和参数分别保存。" onClose={onClose} busy={busy} wide>
    <div className="model-form">
      {error && <p className="notice error" role="alert">{error}</p>}{notice && <p className="notice success" role="status"><Check size={16} />{notice}</p>}
      {!settings ? <p className="panel-empty">{error ? '暂时无法读取模型设置，请重新打开重试。' : '正在读取连接设置……'}</p> : <>
        <div className="connection-picker"><label>当前连接<select aria-label="当前模型连接" value={creating?'new':settings.id} disabled={busy||dirty} onChange={(event)=>{setBusy(true);setError(null);void collaborationApi.activateConnection(event.target.value).then((result)=>{setSettings(result.settings);setKey('');setModels([]);setClearKey(false);setNotice('已切换连接，新任务将使用它；在途任务保留原连接。');}).catch((failure)=>setError(errorMessage(failure))).finally(()=>setBusy(false));}}>{connections.map((connection)=><option value={connection.id} key={connection.id}>{connection.name||connection.model||'默认连接'}</option>)}{creating&&<option value="new">新连接（尚未保存）</option>}</select></label><button className="button secondary compact" disabled={busy||dirty} onClick={()=>{setCreating(true);setSettings({...settings,id:'new',name:'新的平台连接',model:'',hasApiKey:false,inputPricePerMillion:null,outputPricePerMillion:null,taskBudget:null,dailyBudget:null});setKey('');setClearKey(false);setModels([]);setDirty(true);setNotice(null);}}><Plus size={14}/>新增连接</button></div>
        <div className="model-grid connection-presets"><label>连接名称<input aria-label="连接名称" value={settings.name??'默认连接'} maxLength={120} disabled={busy} onChange={(event)=>update('name',event.target.value)}/></label><label>平台预设<select aria-label="平台预设" value="" disabled={busy} onChange={(event)=>{const preset=presets[event.target.value];if(preset){setSettings({...settings,...preset,model:'',hasApiKey:settings.hasApiKey});setDirty(true);setModels([]);}}}><option value="">自定义 / 保留当前配置</option>{Object.entries(presets).map(([id,preset])=><option value={id} key={id}>{preset.name}</option>)}</select></label></div>
        <div className="model-connection-card"><PlugZap size={20} /><div><strong>OpenAI 兼容接口</strong><p>填写服务的基础地址和模型名称；本地免密服务可留空密钥。</p></div></div>
        <label>基础地址 Base URL<input aria-label="模型基础地址" type="url" autoComplete="off" placeholder="https://example.com/v1" value={settings.baseUrl} disabled={busy} onChange={(e) => update('baseUrl', e.target.value)} required /></label>
        <label>模型名称<input aria-label="模型名称" list="platform-model-list" autoComplete="off" placeholder="服务提供的模型 ID" value={settings.model} disabled={busy} onChange={(e) => update('model', e.target.value)} required /><datalist id="platform-model-list">{models.map((model)=><option key={model} value={model}/>)}</datalist></label>
        <button className="text-button model-catalog" disabled={busy||dirty||creating} onClick={()=>{setBusy(true);setError(null);void collaborationApi.modelCatalog(settings.id).then((result)=>{setModels(result.models);setNotice(`已读取 ${result.models.length} 个模型，在模型名称中输入可筛选。`);}).catch((failure)=>setError(errorMessage(failure))).finally(()=>setBusy(false));}}>读取此平台的模型列表</button>
        <label>API 密钥<span className="field-note">{settings.hasApiKey ? '已保存密钥，留空保留' : '尚未保存密钥'}</span><input aria-label="API 密钥" type="password" autoComplete="new-password" placeholder={settings.hasApiKey ? '留空保留当前密钥' : '仅保存到本机工作区以外'} value={key} disabled={busy || clearKey} onChange={(e) => { setKey(e.target.value); setDirty(true); }} /></label>
        {settings.hasApiKey && <label className="checkbox-field"><input type="checkbox" checked={clearKey} disabled={busy} onChange={(e) => { setClearKey(e.target.checked); setDirty(true); }} />清除已保存的密钥</label>}
        <p className="field-help">密钥只由本地服务使用，作品备份不包含密钥。请求会向你配置的模型服务发送本次上下文。</p>
        <details className="advanced-settings"><summary>生成参数与费用预算</summary><div className="model-grid"><label>上下文窗口（Token）<input aria-label="上下文窗口" type="number" min="1024" value={settings.contextWindow} disabled={busy} onChange={(e) => update('contextWindow', Number(e.target.value))} /></label><label>输出上限（Token）<input aria-label="输出上限" type="number" min="1" value={settings.maxOutputTokens} disabled={busy} onChange={(e) => update('maxOutputTokens', Number(e.target.value))} /></label><label>温度<input aria-label="生成温度" type="number" min="0" max="2" step="0.1" value={settings.temperature} disabled={busy} onChange={(e) => update('temperature', Number(e.target.value))} /></label><label className="checkbox-field"><input type="checkbox" checked={settings.stream} disabled={busy} onChange={(e) => update('stream', e.target.checked)} />使用流式输出</label><label>输出额度字段<select aria-label="输出额度字段" value={settings.tokenParameter??'max_tokens'} disabled={busy} onChange={(event)=>update('tokenParameter',event.target.value as 'max_tokens'|'max_completion_tokens')}><option value="max_tokens">max_tokens（常用兼容接口）</option><option value="max_completion_tokens">max_completion_tokens（部分新模型）</option></select></label><label className="checkbox-field"><input type="checkbox" checked={settings.sendTemperature!==false} disabled={busy} onChange={(event)=>update('sendTemperature',event.target.checked)}/>向平台发送温度参数</label><label className="checkbox-field"><input type="checkbox" checked={settings.includeStreamUsage!==false} disabled={busy} onChange={(event)=>update('includeStreamUsage',event.target.checked)}/>请求流式 Token 用量</label>{priceField('输入价格（USD / 百万 Token）', 'inputPricePerMillion')}{priceField('输出价格（USD / 百万 Token）', 'outputPricePerMillion')}{priceField('单任务预算（USD）', 'taskBudget')}{priceField('每日预算（USD，UTC 日）', 'dailyBudget')}</div><p className="field-help">价格由你填写。价格或服务端用量缺失时，费用显示未知；预算按已知价格估算，无法替代服务商账单。</p></details>
      </>}
    </div>
    <div className="dialog-footer"><button className="button quiet" onClick={onClose} disabled={busy}>关闭</button><button className="button secondary" disabled={busy || !settings} onClick={() => { void save(true); }}>{busy ? <LoaderCircle size={16} className="spin" /> : <PlugZap size={16} />}保存并测试连接</button><button className="button primary" disabled={busy || !settings || !dirty} onClick={() => { void save(); }}>保存设置</button></div>
  </Dialog>;
}
