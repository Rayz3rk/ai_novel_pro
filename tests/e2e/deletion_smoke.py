"""Run against a disposable workspace only (NOVEL_TEST_URL required)."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = os.environ['NOVEL_TEST_URL']
OUTPUT = Path(__file__).resolve().parents[2] / 'test-results' / 'deletion-ui'
OUTPUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    executable = os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    response = context.request.post(f'{BASE}/api/books', data={"title": "删除功能验收"})
    assert response.ok, response.text()
    book = response.json()['book']
    chapters = context.request.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters']
    first = chapters[0]
    response = context.request.post(f'{BASE}/api/books/{book["id"]}/chapters', data={"title": "保留下来的第二章"})
    assert response.ok
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    page.screenshot(path=str(OUTPUT / 'shelf.png'), full_page=True)
    page.get_by_role('button', name='继续写作：删除功能验收', exact=True).click()
    expect(page.get_by_role('textbox', name='章节正文', exact=True)).to_be_visible()
    page.get_by_role('textbox', name='章节正文', exact=True).fill('正在编辑的正文也要先保存再删除。')
    page.get_by_role('button', name='删除本章', exact=True).click()
    dialog = page.get_by_role('dialog', name='删除章节', exact=True)
    expect(dialog).to_be_visible()
    dialog.get_by_role('button', name='取消', exact=True).click()
    expect(page.get_by_role('textbox', name='章节正文', exact=True)).to_contain_text('正在编辑的正文')
    page.get_by_role('button', name='删除本章', exact=True).click()
    page.screenshot(path=str(OUTPUT / 'chapter-confirm.png'), full_page=True)
    dialog.get_by_role('button', name='确认删除章节', exact=True).click()
    expect(page.get_by_role('textbox', name='章节名称', exact=True)).to_have_value('保留下来的第二章')
    assert context.request.get(f'{BASE}/api/chapters/{first["id"]}').status == 404
    page.get_by_role('button', name='删除本章', exact=True).click()
    page.get_by_role('button', name='确认删除章节', exact=True).click()
    expect(page.get_by_role('button', name='继续写作：删除功能验收', exact=True)).to_be_visible()
    page.get_by_role('button', name='继续写作：删除功能验收', exact=True).click()
    expect(page.get_by_role('button', name='新增章节', exact=True)).to_be_visible()
    page.get_by_role('button', name='新增章节', exact=True).click()
    expect(page.get_by_role('textbox', name='章节正文', exact=True)).to_be_visible()
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(OUTPUT / 'mobile-editor.png'), full_page=True)
    page.get_by_role('button', name='返回书架', exact=True).click()
    page.get_by_role('button', name='删除作品：删除功能验收', exact=True).click()
    confirm = page.get_by_role('button', name='确认删除作品', exact=True)
    expect(confirm).to_be_disabled()
    page.get_by_role('textbox', name='确认删除的作品名称', exact=True).fill('删除功能验收')
    expect(confirm).to_be_enabled()
    page.screenshot(path=str(OUTPUT / 'mobile-book-confirm.png'), full_page=True)
    confirm.click()
    expect(page.get_by_text('作品已删除。需要恢复时', exact=False)).to_be_visible()
    assert context.request.get(f'{BASE}/api/books/{book["id"]}').status == 404
    assert not errors, errors
    browser.close()
    print('Deletion UI passed: save, cancel, next chapter, empty book, recreate, title confirmation, mobile, no browser errors.')
