"""Database settings UI on an isolated production PostgreSQL workspace."""
import json
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ['NOVEL_TEST_URL']
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    state = context.request.get(BASE + '/api/storage').json()['storage']
    assert state['driver'] == 'postgresql' and state['database'].startswith('shujian_test_'), 'Use an isolated PostgreSQL test database.'
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    checks = []
    try:
        page.goto(BASE)
        page.get_by_role('button', name='数据库', exact=True).click()
        dialog = page.get_by_role('dialog', name='数据库存储', exact=True)
        expect(dialog.get_by_text('当前使用 PostgreSQL', exact=True)).to_be_visible()
        dialog.get_by_label('下次启动使用的数据库').select_option('sqlite')
        dialog.get_by_role('button', name='保存下次启动选择', exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('已保存选择')
        changed = context.request.get(BASE + '/api/storage').json()['storage']
        assert changed['driver'] == 'postgresql' and changed['nextDriver'] == 'sqlite'
        dialog.get_by_role('button', name='关闭', exact=True).click()
        page.get_by_role('button', name='数据库', exact=True).click()
        dialog = page.get_by_role('dialog', name='数据库存储', exact=True)
        expect(dialog.get_by_label('下次启动使用的数据库')).to_have_value('sqlite')
        checks.append('selection survives dialog reopen without switching the live database')
        dialog.get_by_label('下次启动使用的数据库').select_option('postgresql')
        dialog.get_by_role('button', name='保存下次启动选择', exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('已保存选择')
        page.screenshot(path=str(ROOT / 'test-results/storage-settings-desktop.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert dialog.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1')
        page.screenshot(path=str(ROOT / 'test-results/storage-settings-mobile.png'))
        dialog.get_by_role('button', name='关闭', exact=True).click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        checks.append('settings and library remain within a 390px viewport')
        assert not errors, errors
        report = {'backend': 'postgresql', 'checks': checks, 'pageErrors': errors}
        (ROOT / 'test-results/storage-browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    finally:
        context.request.put(BASE + '/api/storage/preference', data={'driver': 'postgresql'})
        browser.close()
