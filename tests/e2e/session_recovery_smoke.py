"""Real-browser regression for recovery ownership, legacy upgrade and stale actions.

Use an isolated SQLite workspace and pass NOVEL_TEST_URL. No model calls.
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-results/final-frontend-audit'
OUT.mkdir(exist_ok=True)
BASE = os.environ.get('NOVEL_TEST_URL', 'http://127.0.0.1:4321')
READ = '''id => new Promise((resolve,reject)=>{const req=indexedDB.open('shujian-drafts');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const tx=req.result.transaction('recovery','readonly');const all=tx.objectStore('recovery').getAll();all.onsuccess=()=>resolve(all.result.filter(value=>value.chapterId===id));all.onerror=()=>reject(all.error);};})'''
WRITE_LEGACY = '''draft=>new Promise((resolve,reject)=>{const req=indexedDB.open('shujian-drafts');req.onerror=()=>reject(req.error);req.onsuccess=()=>{const tx=req.result.transaction('recovery','readwrite');tx.objectStore('recovery').put(draft,draft.chapterId);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);};})'''

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    state = context.request.get(BASE + '/api/storage').json()['storage']
    assert state['driver'] == 'sqlite' and 'test-results' in state['database'], 'Use isolated SQLite test data.'
    errors = []
    checks = []

    def chapter(title):
        book = context.request.post(BASE + '/api/books', data={'title': title}).json()['book']
        first = context.request.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters'][0]
        return book, first, f'{BASE}/#/books/{book["id"]}/chapters/{first["id"]}'

    def page_at(url):
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        page.goto(url)
        page.wait_for_load_state('networkidle')
        return page

    def editor(page):
        return page.get_by_role('textbox', name='章节正文', exact=True)

    def failed_edit(page, chapter_id, text):
        page.route(f'**/api/chapters/{chapter_id}/draft', lambda route: route.abort('failed'))
        editor(page).fill(text)
        editor(page).press('Control+s')
        expect(page.get_by_text('尚未保存', exact=True)).to_be_visible()

    def export_selected(page, name):
        with page.expect_download() as event:
            page.get_by_role('button', name='导出副本并沿用已保存稿', exact=True).click()
        target = OUT / name
        event.value.save_as(target)
        return target.read_text(encoding='utf-8-sig')

    # A's successful ACK cannot erase B's failed edit in the same browser origin.
    _, first, url = chapter('会话隔离 · 保存成功不删除别页稿')
    a, b = page_at(url), page_at(url)
    held = []
    a.route(f'**/api/chapters/{first["id"]}/draft', lambda route: held.append(route))
    editor(a).fill('A 页签已保存。')
    editor(a).press('Control+s')
    a.wait_for_timeout(100)
    assert held
    failed_edit(b, first['id'], 'B 页签独有的未保存稿。')
    held[0].continue_()
    expect(a.get_by_text('已保存到本地', exact=True)).to_be_visible()
    records = b.evaluate(READ, first['id'])
    assert len(records) == 1 and 'B 页签独有' in json.dumps(records, ensure_ascii=False)
    b.reload(); b.wait_for_load_state('networkidle')
    expect(b.get_by_text('发现一份未完成保存的本机稿', exact=True)).to_be_visible()
    assert 'B 页签独有' in export_selected(b, 'retained-other-tab.txt')
    expect(editor(b)).to_contain_text('A 页签已保存')
    checks.append('a successful save only clears its own acknowledged recovery record')
    a.close(); b.close()

    # Several unsaved sessions are individually identifiable and explicitly selectable.
    _, first, url = chapter('会话隔离 · 多副本选择')
    a, b = page_at(url), page_at(url)
    failed_edit(a, first['id'], '第一份独立副本。')
    failed_edit(b, first['id'], '第二份独立副本。')
    records = b.evaluate(READ, first['id'])
    assert len(records) == 2
    c = page_at(url)
    expect(c.get_by_text('发现 2 份未完成保存的本机稿', exact=True)).to_be_visible()
    selector = c.get_by_label('选择本机恢复稿')
    c.set_viewport_size({'width': 390, 'height': 844})
    c.get_by_text('查看选中副本的内容', exact=True).click()
    expect(selector).to_be_visible()
    assert c.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    c.screenshot(path=str(OUT / 'multiple-recovery-mobile.png'), full_page=True)
    wanted = next(record for record in records if '第二份' in json.dumps(record, ensure_ascii=False))
    selector.select_option(wanted['sessionId'])
    c.get_by_role('button', name='恢复本机稿', exact=True).click()
    expect(c.get_by_text('发现一份未完成保存的本机稿', exact=True)).to_be_visible()
    assert '第一份' in export_selected(c, 'other-unselected-recovery.txt')
    expect(editor(c)).to_contain_text('第二份独立副本')
    editor(c).press('Control+s')
    expect(c.get_by_text('已保存到本地', exact=True)).to_be_visible()
    c.set_viewport_size({'width': 390, 'height': 844})
    assert c.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    checks.append('multiple unsaved sessions remain separate and only the chosen copy is restored')
    a.close(); b.close(); c.close()

    # Reading a recovery list does not authorize deleting later edits in that session.
    _, first, url = chapter('会话隔离 · 不删除未读更新')
    a = page_at(url)
    failed_edit(a, first['id'], '原页签第一版。')
    b = page_at(url)
    expect(b.get_by_text('发现一份未完成保存的本机稿', exact=True)).to_be_visible()
    editor(a).fill('原页签第二版，导出旧副本时必须保留。')
    editor(a).press('Control+s')
    expect(a.get_by_text('尚未保存', exact=True)).to_be_visible()
    assert '第一版' in export_selected(b, 'stale-selected-copy.txt')
    records = b.evaluate(READ, first['id'])
    assert len(records) == 1 and '第二版' in json.dumps(records, ensure_ascii=False)
    expect(b.get_by_text('副本已被原页签更新，未删除新内容，请重新查看。', exact=True)).to_be_visible()
    assert '第二版' in export_selected(b, 'newer-retained-copy.txt')
    checks.append('discarding an observed copy never deletes a newer unseen revision')
    a.close(); b.close()

    # The old chapter-only key is migrated atomically and remains recoverable.
    _, first, url = chapter('会话隔离 · 旧版副本升级')
    a = page_at(url)
    a.evaluate(WRITE_LEGACY, {'chapterId': first['id'], 'baseVersion': first['version'], 'title': first['title'], 'outline': '',
        'document': {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'uid': 'legacy-p'}, 'content': [{'type': 'text', 'text': '升级前已经写下的旧版应急稿。'}]}]},
        'updatedAt': datetime.now(timezone.utc).isoformat()})
    a.reload(); a.wait_for_load_state('networkidle')
    expect(a.get_by_text('发现一份未完成保存的本机稿', exact=True)).to_be_visible()
    records = a.evaluate(READ, first['id'])
    assert len(records) == 1 and records[0].get('legacy') is True and records[0].get('sessionId')
    a.get_by_role('button', name='恢复本机稿', exact=True).click()
    expect(editor(a)).to_contain_text('升级前已经写下')
    editor(a).press('Control+s')
    expect(a.get_by_text('已保存到本地', exact=True)).to_be_visible()
    a.reload(); a.wait_for_load_state('networkidle')
    expect(a.get_by_text('发现一份未完成保存的本机稿', exact=True)).to_have_count(0)
    expect(editor(a)).to_contain_text('升级前已经写下')
    checks.append('legacy chapter-only recovery upgrades without losing text or producing a repeated warning')
    a.close()

    # An outline/title-only offline edit must not disappear in the text export.
    _, first, url = chapter('元数据副本 · 离线只改标题与章纲')
    a = page_at(url)
    a.route(f'**/api/chapters/{first["id"]}/draft', lambda route: route.abort('failed'))
    a.get_by_role('textbox', name='章节名称', exact=True).fill('离线改过的章节名称')
    a.get_by_role('textbox', name='本章意图', exact=True).fill('离线独有章纲：保留这次人物选择。')
    a.keyboard.press('Control+s')
    expect(a.get_by_text('尚未保存', exact=True)).to_be_visible()
    a.reload(); a.wait_for_load_state('networkidle')
    expect(a.get_by_text('发现一份未完成保存的本机稿', exact=True)).to_be_visible()
    a.get_by_text('查看选中副本的内容', exact=True).click()
    expect(a.locator('.recovery-notice pre')).to_contain_text('离线独有章纲')
    exported = export_selected(a, 'offline-metadata-only.txt')
    assert '【章节名称】\n离线改过的章节名称' in exported
    assert '【本章意图】\n离线独有章纲：保留这次人物选择。' in exported
    assert '【正文】' in exported
    checks.append('title/outline-only offline edits are included in the exported recovery copy')
    a.close()

    # The conflict action exports all local text fields before loading the newer server draft.
    _, first, url = chapter('元数据副本 · 冲突只改标题与章纲')
    baseline = context.request.get(f'{BASE}/api/chapters/{first["id"]}').json()['chapter']
    document = {'type': 'doc', 'content': [{'type': 'paragraph', 'attrs': {'uid': 'metadata-source'}, 'content': [{'type': 'text', 'text': '正文没有改动，只改标题与章纲。'}]}]}
    baseline = context.request.put(f'{BASE}/api/chapters/{first["id"]}/draft', data={
        'expectedVersion': baseline['version'], 'title': '已保存章节', 'outline': '已保存章纲', 'document': document,
    }).json()['chapter']
    a = page_at(url)
    assert context.request.put(f'{BASE}/api/chapters/{first["id"]}/draft', data={
        'expectedVersion': baseline['version'], 'title': '服务器新名称', 'outline': '服务器新章纲', 'document': document,
    }).ok
    a.get_by_role('textbox', name='章节名称', exact=True).fill('本机未保存标题')
    a.get_by_role('textbox', name='本章意图', exact=True).fill('本机未保存章纲：这个内容必须留住。')
    a.keyboard.press('Control+s')
    expect(a.get_by_text('版本需要处理', exact=True)).to_be_visible()
    a.get_by_role('button', name='查看服务器稿', exact=True).click()
    dialog = a.get_by_role('dialog', name='两份稿件，都先留下', exact=True)
    expect(dialog.locator('.conflict-prose').first).to_contain_text('本机未保存章纲')
    with a.expect_download() as event:
        dialog.get_by_role('button', name='导出本机稿并载入服务器稿', exact=True).click()
    target = OUT / 'conflict-metadata-only.txt'
    event.value.save_as(target)
    exported = target.read_text(encoding='utf-8-sig')
    assert '【章节名称】\n本机未保存标题' in exported
    assert '【本章意图】\n本机未保存章纲：这个内容必须留住。' in exported
    assert '【正文】\n正文没有改动，只改标题与章纲。' in exported
    expect(a.get_by_role('textbox', name='章节名称', exact=True)).to_have_value('服务器新名称')
    expect(a.get_by_role('textbox', name='本章意图', exact=True)).to_have_value('服务器新章纲')
    expect(editor(a)).to_contain_text('正文没有改动')
    checks.append('conflict export retains local title, outline and prose before loading server fields')
    a.close()
    assert not errors, errors
    report = {'checks': checks, 'pageErrors': errors, 'count': len(checks)}
    (OUT / 'session-recovery-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
    browser.close()
