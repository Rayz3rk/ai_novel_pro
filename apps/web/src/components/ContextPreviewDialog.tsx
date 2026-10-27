import type { ContextPreview } from '@shujian/contracts';
import { Dialog } from './Dialog';

export function ContextPreviewDialog({ preview, busy, error, onClose, onStart }: { preview: ContextPreview; busy: boolean; error: string | null; onClose: () => void; onStart: () => void }) {
  return <Dialog title="本次会用到的材料" subtitle="预览不会调用模型，也不会新增正文留稿。正式开始时会再次核对材料是否变化。" onClose={onClose} busy={busy} wide><div className="context-preview-body">
    <div className="context-preview-stats"><div><small>模型</small><strong>{preview.model || '尚未配置'}</strong></div><div><small>预计输入 / 预留输出 Token</small><strong>{preview.inputTokens.toLocaleString()} / {preview.outputTokens.toLocaleString()}</strong></div><div><small>本次调用预留费用</small><strong>{preview.estimatedCost === null ? '未知价格' : `$${preview.estimatedCost.toFixed(6)} USD`}</strong></div></div>
    <p className="field-help">Token 使用保守估算，窗口 {preview.contextWindow.toLocaleString()}。费用按已配置单价估算，服务商账单为准；格式修正或重试会另计，并继续受预算限制。</p>
    {preview.blocked && <p className="notice error" role="alert">{preview.blocked.message}</p>}{error && <p className="notice error" role="alert">{error}</p>}
    <h3>将发送 · {preview.included.length} 条材料</h3>{preview.included.map((item) => <details key={item.id}><summary>{item.label}<small>{item.required ? '必需' : '按相关性选入'}</small></summary><p>{item.text}</p></details>)}
    {preview.omitted.length > 0 && <><h3>本次未装入 · {preview.omitted.length} 条</h3>{preview.omitted.map(({ item, reason }) => <details key={item.id}><summary>{item.label}</summary><p>{reason}</p><p>{item.text}</p></details>)}</>}
    <details className="prompt-snapshot"><summary>查看实际提示与方法版本</summary><p>档案 V{preview.prompt.creativity.profileVersion} · 提示摘要 {preview.prompt.hash.slice(0, 16)}</p>{preview.prompt.creativity.skills.map((skill) => <p key={skill.id}>{skill.definition.title} · V{skill.version} · {skill.hash.slice(0, 16)} · 已选参考 {skill.resources.length} 份</p>)}{preview.prompt.messages.map((message, index) => <pre key={index}>{message.role === 'system' ? '任务规则' : '本次材料'}{'\n'}{message.content}</pre>)}</details>
    <div className="dialog-footer"><button className="button secondary" disabled={busy} onClick={onClose}>返回调整</button><button className="button primary" disabled={busy || !!preview.blocked} onClick={onStart}>按此材料开始任务</button></div>
  </div></Dialog>;
}
