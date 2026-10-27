"""Create a local, source-blind review form. No model/network or credentials."""
import argparse
import hashlib
import html
import json
import secrets
from string import Template
from pathlib import Path


def prepare(source: Path, target: Path):
    data = json.loads(source.read_text(encoding='utf-8'))
    if data.get('status') != 'succeeded' or len(data.get('samples', [])) != 2:
        raise ValueError('需要两个已完成的比较样本。')
    digest=hashlib.sha256(json.dumps(data,ensure_ascii=False,sort_keys=True).encode('utf-8')).hexdigest()
    existing=target/'identity-after-review.json'
    if existing.exists():
        saved=json.loads(existing.read_text(encoding='utf-8'))
        if saved.get('sourceDigest')==digest and (target/'review.html').exists():
            return {'trialId':saved['trialId'],'review':str(target/'review.html'),'reused':True}
        raise ValueError('此目录已有其他评阅记录，请使用新目录，保留原评分的身份对应。')
    samples = list(data['samples'])
    if secrets.randbelow(2):
        samples.reverse()
    target.mkdir(parents=True, exist_ok=True)
    trial_id = secrets.token_hex(8)
    identities = {label: sample['source'] for label, sample in zip(('A', 'B'), samples)}
    metrics = ('可读性', '情节推进', '人物表现', '与要求一致', '省改稿程度')
    cards = []
    for label, sample in zip(('A', 'B'), samples):
        questions = []
        for index, metric in enumerate(metrics):
            choices = ''.join(f'<label><input type="radio" name="{label}-{index}" value="{score}" required>{score}</label>' for score in range(1, 6))
            questions.append(f'<fieldset><legend>{metric}</legend><div class="choices">{choices}</div></fieldset>')
        cards.append(f'<section><span class="eyebrow">样本 {label}</span><h2>{label}</h2><article>{html.escape(sample["text"])}</article><div class="ratings">{"".join(questions)}</div></section>')
    brief = html.escape(data.get('sharedBrief', ''))
    document = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>书间 · 匿名质量对照</title><style>
    :root{color:#25382f;background:#f6f4ed;font-family:"Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0;padding:38px 5vw 55px}main{max-width:1300px;margin:auto}h1,h2,article{font-family:"Noto Serif SC",SimSun,serif}h1{font-size:32px;font-weight:500;line-height:1.7;margin:15px 0}header p{color:#6e7e60;font-size:13px;line-height:1.9}.eyebrow{color:#8b987b;font-size:10px;letter-spacing:2px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:28px}section{background:#fffefa;border:1px solid #e0e5d6;border-radius:4px;padding:30px}h2{font-size:36px;font-weight:400;margin:10px 0 23px}article{white-space:pre-wrap;font-size:17px;line-height:2.1;min-height:350px;border-bottom:1px solid #e2e7da;padding-bottom:28px}.ratings{padding-top:18px}fieldset{border:0;display:flex;align-items:center;justify-content:space-between;gap:18px;margin:9px 0;padding:8px 0}legend{float:left;font-size:12px;color:#789166}.choices{display:flex;gap:14px}.choices label{display:flex;align-items:center;gap:4px;font-size:12px}input{accent-color:#163c36}details{border-bottom:1px solid #dfe5d4;padding:18px 0}summary{cursor:pointer;font-size:12px;color:#7e8e6c}pre{white-space:pre-wrap;font:12px/1.9 "Microsoft YaHei",sans-serif;max-height:280px;overflow:auto}.conclusion{padding:28px 0}.conclusion label{font-size:13px;line-height:2}.conclusion select,.conclusion textarea{display:block;width:100%;padding:12px;margin:8px 0 20px;border:1px solid #dbe2d0;background:#fffefa;border-radius:4px;color:#25382f;font:13px/1.8 "Microsoft YaHei",sans-serif}button{background:#163c36;color:#fffefa;padding:13px 23px;border:0;border-radius:4px;font-size:13px;cursor:pointer}.hint{font-size:11px;color:#8d9b7e;line-height:1.9}.saved{display:none;color:#47753b;margin-left:15px;font-size:12px}@media(max-width:850px){body{padding:23px 18px}.grid{grid-template-columns:1fr;gap:20px}section{padding:23px}article{min-height:0}.choices{gap:10px}fieldset{gap:10px}}
    </style><main><header><span class="eyebrow">书间 · 作者评阅</span><h1>先读文字，再判断来源。</h1><p>两份样本使用相同模型、参数与冻结材料。请独立评价，不猜哪一份来自哪个流程。</p><p>1 分最低，5 分最高；“省改稿程度”越高，表示你预计需要改动越少。</p></header><details><summary>查看共同创作材料</summary><pre>__BRIEF__</pre></details><form id="review"><div class="grid">__CARDS__</div><div class="conclusion"><label>整体更愿意采用哪一份？<select name="preference" required><option value="">请选择</option><option>A</option><option>B</option><option>各有所长</option><option>都不够用</option></select></label><label>最需要修改的地方及原因<textarea name="notes" rows="4" placeholder="例如：人物选择缺乏动机、重复解释、提前揭示信息……"></textarea></label><button type="submit">导出匿名评分</button><span class="saved" id="saved">评分已导出</span><p class="hint">评分仅在本机填写，不会上传。请先评分，再查看身份对应文件；单个样本不能证明整体优劣。</p></div></form></main><script>
    document.getElementById('review').addEventListener('submit',function(event){event.preventDefault();const form=new FormData(event.target);const result={format:'shujian-blind-review',version:1,trialId:'__TRIAL__',reviewedAt:new Date().toISOString(),ratings:{A:{},B:{}},preference:form.get('preference'),notes:form.get('notes')};const metrics=['可读性','情节推进','人物表现','与要求一致','省改稿程度'];for(const side of ['A','B'])metrics.forEach((metric,index)=>result.ratings[side][metric]=Number(form.get(side+'-'+index)));const blob=new Blob([JSON.stringify(result,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='anonymous-review-'+result.trialId+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);document.getElementById('saved').style.display='inline';});
    </script></html>'''
    document = Template(document.replace('__BRIEF__', '$BRIEF').replace('__CARDS__', '$CARDS').replace('__TRIAL__', '$TRIAL')).substitute(BRIEF=brief,CARDS=''.join(cards),TRIAL=trial_id)
    (target / 'review.html').write_text(document, encoding='utf-8')
    key = {'trialId': trial_id, 'sourceDigest':digest, 'mapping': identities, 'method': data.get('method'), 'sourceJobId': data.get('sourceJobId'), 'model': data.get('model'), 'parameters': data.get('parameters')}
    (target / 'identity-after-review.json').write_text(json.dumps(key, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'trialId': trial_id, 'review': str(target / 'review.html')}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.target), ensure_ascii=False))
