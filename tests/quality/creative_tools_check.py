"""Local fake exports exercise offline tools. Never reads author data or calls a model."""
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-results/creative-quality-audit'
RUN = OUT / ('run-' + uuid.uuid4().hex[:10])
RUN.mkdir(parents=True)
node = Path(os.environ.get('NOVEL_TEST_NODE', str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')))
if not node.is_file():
    node = Path(shutil.which('node') or '')
assert node.is_file(), 'Node.js 24 is required for local tool verification.'
assert int(subprocess.check_output([str(node), '-p', 'process.versions.node'], text=True).split('.')[0]) >= 24
tsx = ROOT / 'apps/server/node_modules/tsx/dist/cli.mjs'
ENV = {key: value for key, value in os.environ.items() if not key.startswith('NOVEL_')}
checks = []


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def write(name, value):
    path = RUN / name
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    return str(path.relative_to(ROOT))


def sample(identifier, method):
    context = [
        {'id': 'instruction', 'label': '作者本次要求', 'source': 'instruction', 'text': '保留人物各自的选择。', 'required': True},
        {'id': 'chapter', 'label': '第一章 · V1', 'source': 'chapter', 'text': '她把伞靠在门边。', 'required': True},
    ]
    skills = []
    if method:
        definition = {'name': 'offline-method', 'title': '离线方法样本', 'description': '只用于工具测试。', 'tasks': ['draft'],
                      'instructions': '保留具体行动。', 'contextNeeds': ['current'], 'resources': [], 'license': '', 'source': 'local fake fixture'}
        skills.append({'id': 'fixture-skill', 'version': 1, 'hash': digest(definition), 'definition': definition, 'focus': '', 'resources': []})
        context.append({'id': 'skill:fixture-skill:v1', 'label': '本次方法', 'source': 'skill', 'text': definition['instructions'], 'required': True})
    creativity = {'skills': skills, 'profileVersion': 0, 'profileHash': digest({}), 'voiceIds': [], 'preferenceIds': []}
    messages = [{'role': 'system', 'content': '离线工具样本的相同任务规则。'},
                {'role': 'user', 'content': '\n\n'.join(f'【{item["label"]}】\n{item["text"]}' for item in context)}]
    prompt = {'schema': 1, 'hash': digest({'messages': messages, 'creativity': creativity}), 'messages': messages, 'creativity': creativity}
    output = '她把伞留在门边，回头等了一会儿。' if method else '她收好雨伞，站在门口等人。'
    return {'format': 'shujian-creative-evaluation', 'version': 1, 'exportedAt': '2026-10-26T00:00:00.000Z',
            'sourceJobId': identifier, 'task': 'draft', 'input': {'requestId': identifier, 'kind': 'draft', 'chapterId': 'fixture-chapter', 'expectedVersion': 1, 'instruction': '保留人物各自的选择。'},
            'prompt': prompt, 'context': context, 'output': output, 'model': 'offline-fixture', 'inputVersion': 1,
            'parameters': {'id': 'fixture', 'baseUrl': 'http://127.0.0.1:9/v1', 'model': 'offline-fixture', 'stream': False,
                           'temperature': 0.7, 'maxOutputTokens': 512, 'contextWindow': 32768,
                           'inputPricePerMillion': 1, 'outputPricePerMillion': 2, 'taskBudget': None, 'dailyBudget': None},
            'status': 'succeeded', 'calls': [{'id': identifier + '-call', 'jobId': identifier, 'attempt': 1, 'model': 'offline-fixture',
                                             'status': 'succeeded', 'inputTokens': 40, 'outputTokens': 20, 'estimatedCost': 0.00008,
                                             'error': None, 'output': output, 'createdAt': '2026-10-26T00:00:00.000Z', 'updatedAt': '2026-10-26T00:00:01.000Z',
                                             'requestMessages': copy.deepcopy(messages), 'promptHash': digest(messages)}]}


def rehash(item):
    item['prompt']['hash'] = digest({'messages': item['prompt']['messages'], 'creativity': item['prompt']['creativity']})
    item['calls'][0]['requestMessages'] = copy.deepcopy(item['prompt']['messages'])
    item['calls'][0]['promptHash'] = digest(item['calls'][0]['requestMessages'])


def run_tool(script, args, success, label):
    result = subprocess.run([str(node), str(tsx), str(ROOT / script), *args], cwd=RUN, env=ENV, capture_output=True, timeout=35)
    (RUN / (label + '.log')).write_bytes(result.stdout + result.stderr)
    assert (result.returncode == 0) == success, f'{label}: see isolated log'
    checks.append(label)
    return result


def compare(item, label, baseline=None, success=False, script='scripts/compare-creative-samples.ts'):
    destination = RUN / (label + '-output')
    args = ['--sample', write(label + '.json', item), '--out', str(destination.relative_to(ROOT))]
    if baseline is not None:
        args += ['--baseline', write(label + '-baseline.json', baseline)]
    result = run_tool(script, args, success, label)
    if success:
        assert json.loads((destination / 'evaluation.json').read_text(encoding='utf-8'))['modelRequests'] == 0
    else:
        assert not destination.exists(), f'{label} created output before validation'
    return destination, result


try:
    a, b = sample('fixture-job-a', True), sample('fixture-job-b', False)
    compare(a, 'single-sample-offline', success=True)
    pair_dir, _ = compare(a, 'paired-samples-offline', b, True)
    saved = (pair_dir / 'comparison.json').read_bytes()
    result = run_tool('scripts/compare-creative-samples.ts', ['--sample', write('repeat-source.json', a), '--baseline', write('repeat-baseline.json', b), '--out', str(pair_dir.relative_to(ROOT))], False, 'existing-output-preserved')
    assert (pair_dir / 'comparison.json').read_bytes() == saved
    mutated = copy.deepcopy(a); mutated['prompt']['messages'][0]['content'] += '改动'
    compare(mutated, 'prompt-tamper-rejected')
    mutated = copy.deepcopy(a); mutated['calls'][0]['requestMessages'][0]['content'] += '改动'
    compare(mutated, 'call-prompt-tamper-rejected')
    mutated = copy.deepcopy(a); mutated['context'][0]['text'] += '改动'
    compare(mutated, 'context-versus-prompt-rejected')
    mutated = copy.deepcopy(b); mutated['parameters']['temperature'] = 0.3
    compare(a, 'different-parameters-rejected', mutated)
    mutated = copy.deepcopy(b); mutated['prompt']['messages'][0]['content'] += '另一套任务规则'; rehash(mutated)
    compare(a, 'different-system-rules-rejected', mutated)
    mutated = copy.deepcopy(b); mutated['status'] = 'failed'
    compare(a, 'unfinished-pair-rejected', mutated)
    mutated = copy.deepcopy(a); mutated['prompt'] = None; mutated['parameters'] = None; mutated['calls'] = []
    compare(mutated, 'legacy-single-analysis', success=True)
    compare(mutated, 'legacy-pair-rejected', b)
    mutated = copy.deepcopy(b); del mutated['calls'][0]['requestMessages']; del mutated['calls'][0]['promptHash']
    compare(a, 'missing-call-proof-rejected', mutated)
    mutated = copy.deepcopy(a); mutated['calls'][0]['jobId'] = 'different-job'
    compare(mutated, 'foreign-call-rejected')
    mutated = copy.deepcopy(a); mutated['parameters']['apiKey'] = 'FAKE_KEY_MUST_NOT_EXPORT'
    compare(mutated, 'credential-field-rejected')
    mutated = copy.deepcopy(a); mutated['input']['kind'] = 'review'
    compare(mutated, 'task-mismatch-rejected')
    mutated = copy.deepcopy(a); mutated['context'][0]['text'] = 17
    compare(mutated, 'invalid-context-rejected')
    mutated = copy.deepcopy(a); mutated['output'] += '改动'
    compare(mutated, 'output-versus-call-rejected')
    compare(a, 'legacy-cli-is-offline', success=True, script='tests/quality/generate-baseline.ts')
    for name, cases in [('empty-cases-rejected', []), ('unknown-scenario-rejected', [{'id': 'wrong-scenario', 'kind': 'preview', 'scenario': 'does-not-exist'}]),
                        ('duplicate-case-ids-rejected', [{'id': 'same', 'kind': 'clean', 'text': '', 'rules': []}, {'id': 'same', 'kind': 'clean', 'text': '', 'rules': []}])]:
        output = RUN / (name + '-report.json')
        run_tool('scripts/evaluate-creative.ts', ['--cases', write(name + '.json', {'format': 'shujian-creative-evaluation-cases', 'version': 1, 'cases': cases}), '--out', str(output.relative_to(ROOT))], False, name)
        assert not output.exists()
    review = RUN / 'anonymous-review'
    result = subprocess.run([sys.executable, str(ROOT / 'tests/quality/prepare_review.py'), str(pair_dir / 'comparison.json'), str(review)], env=ENV, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr.decode(errors='replace')
    html = (review / 'review.html').read_text(encoding='utf-8')
    assert 'fixture-job-a' not in html and 'fixture-job-b' not in html
    identity = (review / 'identity-after-review.json').read_bytes()
    result = subprocess.run([sys.executable, str(ROOT / 'tests/quality/prepare_review.py'), str(pair_dir / 'comparison.json'), str(review)], env=ENV, capture_output=True, timeout=20)
    assert result.returncode == 0 and json.loads(result.stdout)['reused']
    assert identity == (review / 'identity-after-review.json').read_bytes()
    checks.append('anonymous-page-compatible-and-stable')
    report = {'passed': True, 'checks': checks, 'count': len(checks), 'modelRequests': 0, 'fixtureOnly': True, 'run': str(RUN)}
    (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
except Exception:
    (OUT / 'failure.json').write_text(json.dumps({'completedChecks': checks, 'run': str(RUN)}, ensure_ascii=False, indent=2), encoding='utf-8')
    raise
