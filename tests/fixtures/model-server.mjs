// Local deterministic transport fixture. Never a default product provider.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const story = JSON.parse(readFileSync(new URL('./story-ten-chapters.json', import.meta.url), 'utf8'));
const port = Number(process.env.QA_MODEL_PORT ?? 19091);
let calls = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/health') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ fixture: true, calls })); return; }
  if(req.url==='/v1/models'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'QA fixture · 工程样本'},{id:'fixture-alternate'}]}));return;}
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  calls++;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw);
  const messages = input.messages.map((message) => message.content).join('\n');
  const instruction = /【作者本次要求】\n([\s\S]*?)(?=\n\n【|$)/.exec(messages)?.[1] ?? '';
  const match = /QA:DRAFT:(\d+)/.exec(instruction);
  let output = match ? story.chapters[Number(match[1]) - 1]?.text : undefined;
  if (instruction.includes('QA:REVISE')) output = '雨敲着玻璃，她把信攥在掌心。';
  if (instruction.includes('QA:PLAN')) output = '本章意图：雨夜收到来自明天的信。冲突：阻止旧钟响起。结尾：发现没有落款。';
  if (instruction.includes('QA:DISCUSS')) output = '可以让邮戳先造成疑问，再用旧钟的异常推进冲突。作者可先确认近期计划，远期真相暂留在作者资料。';
  if (instruction.includes('QA:ATLAS:RELATIONS')) { const ids=[...new Set([...messages.matchAll(/卡片ID：([a-zA-Z0-9-]+)/g)].map(match=>match[1]))];output=JSON.stringify({relations:ids.length>=2?[{fromId:ids[0],toId:ids[1],label:'固定样本的合作建议',description:'仅用于界面测试，需要作者确认。',symmetric:false}]:[]}); }
  if (instruction.includes('QA:FAIL')) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"QA fixture unavailable"}}'); return; }
  if (messages.includes('检查此正文快照')) output = JSON.stringify({ issues: [] });
  if ((messages.includes('从本章已定稿快照提取')||messages.includes('从本章冻结快照提取'))) {
    const serialized = /【第[^】]+】\n([^\n]+)/.exec(messages)?.[1];
    const doc = serialized ? JSON.parse(serialized) : { content: [] };
    const p = doc.content.find((node) => node.type === 'paragraph' && node.attrs?.uid && node.content?.length);
    const quote = p?.content.map((node) => node.text ?? '').join('') ?? '';
    output = JSON.stringify({ entries: p ? [{ kind: 'event', authority: 'fact', title: '本章发生的事', content: quote, visibility: 'public', evidence: [{ paragraphId: p.attrs.uid, quote }] }] : [] });
  }
  if (instruction.includes('QA:MALFORMED')) output = '{not valid JSON';
  output ??= '这是本机工程验收模型的固定响应，只用于验证接口，不代表真实模型能力。';
  const usage = { prompt_tokens: 110, completion_tokens: 90, total_tokens: 200 };
  if (!input.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: output }, finish_reason: 'stop' }], usage })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunks = output.match(/[\s\S]{1,18}/gu) ?? [];
  for (const chunk of chunks) {
    if (res.destroyed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, finish_reason: null }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, instruction.includes('QA:SLOW') ? 200 : 10));
  }
  if (instruction.includes('QA:DISCONNECT')) { res.destroy(); return; }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
});
server.listen(port, '127.0.0.1', () => console.log(`QA FIXTURE ONLY http://127.0.0.1:${port}/v1`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
