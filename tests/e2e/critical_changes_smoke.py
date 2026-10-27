"""Important-change reading cues remain nonbinding and never auto-confirm facts."""
import json
import os
import time
import uuid
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ['NOVEL_TEST_URL']
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    context = browser.new_context(viewport={'width': 390, 'height': 844})
    state = context.request.get(BASE + '/api/storage').json()['storage']
    assert state['driver'] == 'postgresql' and state['database'].startswith('shujian_test_')
    settings = context.request.get(BASE + '/api/model').json()['settings']
    settings['baseUrl'] = 'http://127.0.0.1:19091/v1'
    assert context.request.put(BASE + '/api/model', data=settings).ok
    book = context.request.post(BASE + '/api/books', data={'title': '重要变化提示 · 工程样本'}).json()['book']
    chapter = context.request.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters'][0]
    text = '回忆里提到，许衡的父亲早已去世。'
    chapter = context.request.put(f'{BASE}/api/chapters/{chapter["id"]}/draft', data={
        'expectedVersion': chapter['version'], 'title': chapter['title'], 'outline': '',
        'document': {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'uid': 'hint-p'}, 'content': [{'type': 'text', 'text': text}]}]},
    }).json()['chapter']
    job = context.request.post(BASE + '/api/jobs', data={
        'requestId': str(uuid.uuid4()), 'kind': 'extract', 'source': 'draft', 'chapterId': chapter['id'],
        'expectedVersion': chapter['version'], 'instruction': '本机工程样本，仅提取给定原句。',
    }).json()['job']
    for _ in range(100):
        if job['status'] not in ['running', 'queued']:
            break
        time.sleep(0.05)
        job = context.request.get(f'{BASE}/api/jobs/{job["id"]}').json()['job']
    assert job['status'] == 'succeeded', job['error']
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        page.goto(f'{BASE}/#/books/{book["id"]}/chapters/{chapter["id"]}')
        expect(page.get_by_role('textbox', name='章节正文', exact=True)).to_contain_text(text)
        page.get_by_role('button', name='定稿', exact=True).click()
        dialog = page.get_by_role('dialog', name='为这一章定稿', exact=True)
        cue = dialog.get_by_text('重点核对：', exact=False)
        expect(cue).to_contain_text('涉及生死措辞')
        expect(cue).to_contain_text('不代表已判定冲突')
        expect(dialog.get_by_role('checkbox')).not_to_be_checked()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(ROOT / 'test-results/important-change-mobile.png'))
        dialog.get_by_role('button', name='确认定稿', exact=True).click()
        expect(page.get_by_text('这一章已定稿。继续书写时，会保留这一稿。', exact=True)).to_be_visible()
        entries = context.request.get(f'{BASE}/api/books/{book["id"]}/story').json()['entries']
        assert not entries
        assert not errors, errors
        report = {'backend': 'postgresql', 'checks': ['important wording is visible without certifying a current death or blocking the author', 'unchecked facts remain unconfirmed after finalization'], 'pageErrors': errors}
        (ROOT / 'test-results/important-change-browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    finally:
        browser.close()
