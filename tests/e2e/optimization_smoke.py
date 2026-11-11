"""Optimization acceptance; use an isolated server, never the personal library."""
import json
import os
from pathlib import Path
from time import perf_counter
from playwright.sync_api import sync_playwright, expect

BASE = os.environ['NOVEL_TEST_URL']
OUTPUT = Path(__file__).resolve().parents[2] / 'test-results' / 'optimization-ui'
OUTPUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    assert context.request.get(f'{BASE}/api/books').json()['books'] == [], 'A fresh, isolated test workspace is required.'
    book = context.request.post(f'{BASE}/api/books', data={'title': '优化功能验收'}).json()['book']
    chapter = context.request.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters'][0]
    response = context.request.post(f'{BASE}/api/books/{book["id"]}/story', data={
        'kind': 'note', 'authority': 'setting', 'title': '保留原文的关联便签', 'content': '回查此章', 'links': {'chapterIds': [chapter['id']]}})
    assert response.ok
    start = perf_counter()
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    shelf_ms = (perf_counter() - start) * 1000
    initial_js = page.evaluate("performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.js')).map(e=>({name:e.name.split('/').pop(),bytes:e.encodedBodySize}))")
    assert not any(any(name in entry['name'] for name in ['Workbench-', 'AtlasDesk-', 'AiAssistant-', 'ModelSettings-']) for entry in initial_js), initial_js
    start = perf_counter()
    page.get_by_role('button', name='继续写作：优化功能验收', exact=True).click()
    expect(page.get_by_role('textbox', name='章节正文', exact=True)).to_be_visible()
    editor_ms = (perf_counter() - start) * 1000
    page.get_by_role('textbox', name='章节正文', exact=True).fill('归档与恢复后都要保留这一段。')
    page.get_by_role('textbox', name='章节正文', exact=True).press('Control+s')
    expect(page.get_by_text('已保存到本地', exact=True)).to_be_visible()
    page.get_by_role('button', name='引用与归档', exact=True).click()
    dialog = page.get_by_role('dialog', name='章节引用与归档', exact=True)
    expect(dialog.get_by_text('资料卡 · 保留原文的关联便签', exact=True)).to_be_visible()
    expect(dialog.get_by_text('历史记录', exact=False).first).to_be_visible()
    page.screenshot(path=str(OUTPUT / 'references.png'), full_page=True)
    dialog.get_by_role('button', name='归档本章，保留引用', exact=True).click()
    expect(page.get_by_role('textbox', name='章节名称', exact=True)).to_be_disabled()
    assert context.request.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters'] == []
    page.get_by_role('button', name='取消归档，继续写作', exact=True).click()
    page.get_by_role('dialog').get_by_role('button', name='取消归档，继续写作', exact=True).click()
    expect(page.get_by_role('textbox', name='章节名称', exact=True)).to_be_enabled()
    expect(page.get_by_role('textbox', name='章节正文', exact=True)).to_contain_text('归档与恢复后都要保留这一段。')
    for width in [390, 720, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), width
        if width < 1280:
            page.get_by_role('button', name='更多工具', exact=True).click()
        expect(page.get_by_role('button', name='引用与归档', exact=True)).to_be_visible()
        page.screenshot(path=str(OUTPUT / f'tools-{width}.png'), full_page=True)
        if width < 1280:
            page.get_by_role('button', name='更多工具', exact=True).click()
    page.get_by_role('button', name='返回书架', exact=True).click()
    page.get_by_role('button', name='备份管理', exact=True).click()
    dialog = page.get_by_role('dialog', name='备份管理', exact=True)
    dialog.get_by_role('button', name='立即备份', exact=True).click()
    expect(dialog.get_by_text('已创建当前作品库备份。', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='预览恢复', exact=True).first.click()
    expect(dialog.get_by_role('region', name='恢复预览', exact=True)).to_be_visible()
    page.screenshot(path=str(OUTPUT / 'backup-preview.png'), full_page=True)
    dialog.get_by_role('button', name='确认恢复为新作品', exact=True).click()
    expect(dialog.get_by_text('已恢复 1 部作品。', exact=True)).to_be_visible()
    dialog.get_by_role('spinbutton', name='备份保留天数', exact=True).fill('30')
    dialog.get_by_role('button', name='保存保留设置', exact=True).click()
    expect(dialog.get_by_text('保留设置已保存。', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='预览过期备份清理', exact=True).click()
    expect(dialog.get_by_text('可清理 0 份', exact=False)).to_be_visible()
    expect(dialog.get_by_role('button', name='确认清理以上备份', exact=True)).to_be_disabled()
    dialog.get_by_role('button', name='关闭窗口', exact=True).click()
    assert len(context.request.get(f'{BASE}/api/books').json()['books']) == 2
    assert not errors, errors
    # Test a failed deferred chunk in a fresh browser context.
    failed_context = browser.new_context()
    retry_page = failed_context.new_page()
    attempts = []
    def fail_once(route):
        attempts.append(route.request.url)
        if len(attempts) == 1:
            route.abort()
        else:
            route.continue_()
    retry_page.route('**/Workbench-*.js', fail_once)
    retry_page.goto(BASE)
    retry_page.get_by_role('button', name='继续写作：优化功能验收', exact=True).first.click()
    retry_page.get_by_role('button', name='重试加载', exact=True).click()
    expect(retry_page.get_by_role('textbox', name='章节正文', exact=True)).to_be_visible(timeout=15000)
    result = {'initialJs': initial_js, 'shelfMs': round(shelf_ms), 'openEditorMs': round(editor_ms), 'chunkRetry': 'passed', 'responsiveWidths': [390,720,1440]}
    (OUTPUT / 'report.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    browser.close()
