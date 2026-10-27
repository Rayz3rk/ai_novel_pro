import { useEffect, useState } from 'react';
import type { StorageInfo } from '@shujian/contracts';
import { Database, LoaderCircle } from 'lucide-react';
import { Dialog } from './Dialog';
import { api, errorMessage } from '../lib/api';

export function StorageSettings({ onClose }: { onClose: () => void }) {
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [driver, setDriver] = useState<StorageInfo['driver']>('sqlite');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; void api.storage().then(({ storage: result }) => {
    if (alive) { setStorage(result); setDriver(result.nextDriver ?? result.driver); }
  }).catch((failure) => { if (alive) setError(errorMessage(failure)); }); return () => { alive = false; }; }, []);
  const save = async () => {
    setBusy(true); setError(null); setNotice(null);
    try { const result = await api.selectStorage(driver); setStorage(result.storage); setNotice('已保存选择。请先备份作品，再关闭并重新启动书间；当前连接继续工作。'); }
    catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  return <Dialog title="数据库存储" subtitle="查看作品保存位置，选择下次启动使用的数据库。" onClose={onClose} busy={busy}>
    <div className="model-form">
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice success" role="status">{notice}</p>}
      {!storage ? <p className="panel-empty">{error ? '暂时无法读取，请重新打开重试。' : '正在读取存储状态……'}</p> : <>
        <div className="model-connection-card"><Database size={22} /><div><strong>当前使用 {storage.driver === 'postgresql' ? 'PostgreSQL' : 'SQLite'}</strong><p style={{ overflowWrap: 'anywhere' }}>{storage.host ? `${storage.host}:${storage.port} / ` : ''}{storage.database}</p></div></div>
        <label>下次启动使用<select aria-label="下次启动使用的数据库" value={driver} disabled={busy || !storage.canSelect} onChange={(event) => { setDriver(event.target.value as StorageInfo['driver']); setNotice(null); }}>
          <option value="sqlite">SQLite · 单文件本地存储</option><option value="postgresql" disabled={!storage.hasPostgresConfig}>PostgreSQL · 数据库服务</option>
        </select></label>
        <p className="notice">两种存储各自保存数据，切换不会自动同步。切换前请备份，需要时在目标存储中恢复备份。当前已保存的作品不会被这一选择删除。</p>
        {storage.configFile && <p className="field-note">连接配置：<code style={{ overflowWrap: 'anywhere' }}>{storage.configFile}</code></p>}
        {!storage.canSelect && <p className="field-note">此环境由启动配置指定数据库。修改配置后重启即可切换。</p>}
      </>}
      <div className="dialog-footer"><button className="button quiet" disabled={busy} onClick={onClose}>关闭</button><button className="button primary" disabled={busy || !storage?.canSelect || driver === storage.nextDriver} onClick={() => { void save(); }}>{busy && <LoaderCircle className="spin" size={16} />}保存下次启动选择</button></div>
    </div>
  </Dialog>;
}
