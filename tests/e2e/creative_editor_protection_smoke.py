"""Independent editor-state audit; no model calls, only an isolated workspace."""
import json
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('NOVEL_CREATIVE_TEST_OUTPUT', str(ROOT / 'test-results/creative-frontend-audit')))
OUT.mkdir(exist_ok=True, parents=True)
BASE = os.environ.get('NOVEL_TEST_URL', 'http://127.0.0.1:5177')
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, **({'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    storage = context.request.get(BASE + '/api/storage').json()['storage']
    assert (storage['driver'] == 'sqlite' and ('novel-qa-creative-' in storage['database'] or 'test-results' in storage['database'])) or (storage['driver'] == 'postgresql' and storage['database'].startswith('shujian_test_'))
    book = context.request.post(BASE + '/api/books', data={'title': '独立前端审查 · 编辑保护'}).json()['book']
    chapter = context.request.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters'][0]
    data_url = f'{BASE}/api/books/{book["id"]}/creative'

    def data():
        return context.request.get(data_url).json()

    profile = data()['profile']
    profile['style']['tone'] = '第一版档案'
    profile['voices'] = [{'id': 'alias-card', 'name': '测试人物', 'aliases': [], 'traits': '简短', 'example': ''}]
    profile['expectedVersion'] = profile['version']
    assert context.request.put(data_url, data=profile).ok
    profile = data()['profile']; profile['style']['tone'] = '第二版档案'; profile['expectedVersion'] = profile['version']
    assert context.request.put(data_url, data=profile).ok
    fields = ['name', 'title', 'description', 'tasks', 'instructions', 'contextNeeds', 'resources', 'license', 'source']
    definition = {key: data()['skills'][0][key] for key in fields}
    definition.update(name='audit-editor-method', title='审查用方法', instructions='HISTORY_V1_ORIGINAL')
    skill = context.request.post(f'{BASE}/api/books/{book["id"]}/skills', data={'definition': definition, 'expectedVersion': 0, 'enabled': True}).json()['skill']
    definition['instructions'] = 'HISTORY_V2_CURRENT'
    assert context.request.put(f'{BASE}/api/books/{book["id"]}/skills/{skill["id"]}', data={'definition': definition, 'expectedVersion': 1, 'enabled': False}).ok
    page = context.new_page()
    page_errors, requests, dialogs, checks = [], [], [], []
    decision = {'accept': False}
    page.on('pageerror', lambda error: page_errors.append(str(error)))
    page.on('request', lambda request: requests.append((request.method, request.url)))
    def answer(dialog):
        dialogs.append(dialog.message)
        dialog.accept() if decision['accept'] else dialog.dismiss()
    page.on('dialog', answer)

    def desk():
        page.get_by_role('button', name='文风与技能', exact=True).click()
        result = page.get_by_role('dialog', name='文风与创作技能', exact=True)
        expect(result.get_by_label('技能标题', exact=True)).to_be_visible()
        return result

    def save_profile(dialog):
        with page.expect_response(lambda response: response.url.endswith(f'/api/books/{book["id"]}/creative') and response.request.method == 'PUT') as saved:
            dialog.get_by_role('button', name='保存创作档案', exact=True).click()
        assert saved.value.ok, saved.value.text()
        expect(dialog.get_by_role('status')).to_contain_text('创作档案已保存')

    try:
        page.goto(f'{BASE}/#/books/{book["id"]}/chapters/{chapter["id"]}')
        page.wait_for_load_state('networkidle')
        d = desk()
        d.get_by_label('技能标题', exact=True).fill('LOCAL_UNSAVED_TITLE')
        d.get_by_role('button', name='关闭窗口', exact=True).click()
        expect(d).to_be_visible()
        d.get_by_role('navigation', name='本书创作技能').get_by_role('button').filter(has_text='人物对白与潜台词').click()
        expect(d.get_by_label('技能标题', exact=True)).to_have_value('LOCAL_UNSAVED_TITLE')
        assert not page.evaluate("window.dispatchEvent(new Event('beforeunload', {cancelable:true}))")
        checks.append('closing, changing methods and leaving the page protect unsaved skill edits')
        decision['accept'] = True
        d.get_by_role('navigation', name='本书创作技能').get_by_role('button').filter(has_text='审查用方法').click()
        d.get_by_label('创作方法正文', exact=True).fill('LOCAL_BODY_BEFORE_HISTORY')
        d.get_by_role('button', name='查看技能历史', exact=True).click()
        old = d.get_by_text('保留的技能版本', exact=True).locator('..').locator(':scope > details').last
        old.locator(':scope > summary').click()
        decision['accept'] = False
        old.get_by_role('button', name='载入为编辑稿', exact=True).click()
        expect(d.get_by_label('创作方法正文', exact=True)).to_have_value('LOCAL_BODY_BEFORE_HISTORY')
        decision['accept'] = True
        old.get_by_role('button', name='载入为编辑稿', exact=True).click()
        expect(d.get_by_label('创作方法正文', exact=True)).to_have_value('HISTORY_V1_ORIGINAL')
        expect(d.get_by_label('启用自定义技能', exact=True)).to_be_checked()
        d.get_by_role('button', name='保存新版本', exact=True).click()
        expect(d.get_by_role('status')).to_contain_text('V3')
        assert next(item for item in data()['skills'] if item['id'] == skill['id'])['enabled']
        checks.append('history load respects unsaved edits, restores enabled state and creates a new revision')
        d.get_by_label('创作方法正文', exact=True).fill('LOCAL_IMPORT_DRAFT')
        valid = OUT / 'method-valid.json'
        valid.write_text(json.dumps({'format': 'shujian-skill', 'version': 1, 'definition': {**definition, 'name': 'imported-audit-method', 'title': '导入审查方法', 'instructions': 'IMPORTED_METHOD'}}, ensure_ascii=False), encoding='utf-8')
        invalid = OUT / 'method-invalid.json'; invalid.write_text('{invalid json', encoding='utf-8')
        count = len(data()['skills'])
        decision['accept'] = False
        d.get_by_label('导入技能文件', exact=True).set_input_files(str(valid))
        expect(d.get_by_label('创作方法正文', exact=True)).to_have_value('LOCAL_IMPORT_DRAFT')
        assert len(data()['skills']) == count
        decision['accept'] = True
        d.get_by_label('导入技能文件', exact=True).set_input_files(str(invalid))
        expect(d.get_by_role('alert')).to_be_visible()
        expect(d.get_by_label('创作方法正文', exact=True)).to_have_value('LOCAL_IMPORT_DRAFT')
        assert len(data()['skills']) == count
        d.get_by_label('导入技能文件', exact=True).set_input_files(str(valid))
        expect(d.get_by_role('status')).to_contain_text('独立副本')
        expect(d.get_by_label('创作方法正文', exact=True)).to_have_value('IMPORTED_METHOD')
        checks.append('import replacement can be cancelled and invalid files retain the exact local draft')
        d.get_by_role('tab', name='人物声音', exact=True).click()
        alias = d.get_by_label('声音别名 1', exact=True)
        alias.fill(''); alias.press_sequentially('小甲、小乙', delay=20)
        expect(alias).to_have_value('小甲、小乙')
        save_profile(d)
        assert data()['profile']['voices'][0]['aliases'] == ['小甲', '小乙']
        (OUT / 'alias-after.json').write_text(json.dumps({'typed': alias.input_value(), 'savedAliases': data()['profile']['voices'][0]['aliases'], 'passed': True}, ensure_ascii=False, indent=2), encoding='utf-8')
        checks.append('typing aliases character by character retains delimiters and persists separate names')
        d.get_by_role('tab', name='本书文风', exact=True).click()
        d.get_by_label('语气与幽默', exact=True).fill('LOCAL_STYLE_BEFORE_HISTORY')
        d.get_by_role('button', name='档案历史', exact=True).click()
        old_profile = d.locator('.creative-history > details').last
        old_profile.locator(':scope > summary').click()
        decision['accept'] = False
        old_profile.get_by_role('button', name='载入此版作为编辑稿', exact=True).click()
        expect(d.get_by_label('语气与幽默', exact=True)).to_have_value('LOCAL_STYLE_BEFORE_HISTORY')
        decision['accept'] = True
        old_profile.get_by_role('button', name='载入此版作为编辑稿', exact=True).click()
        expect(d.get_by_label('语气与幽默', exact=True)).to_have_value('第一版档案')
        save_profile(d)
        assert data()['profile']['style']['tone'] == '第一版档案'
        assert data()['profile']['version'] == 4
        checks.append('profile history never silently replaces unsaved values and restoration keeps current CAS version')
        d.get_by_role('tab', name='创作技能', exact=True).click()
        defaults = d.get_by_text('每类任务的常用方法', exact=True).locator('..')
        defaults.locator(':scope > summary').click()
        choices = defaults.get_by_role('checkbox')
        for index in range(3):
            choices.nth(index).check()
        expect(choices.nth(3)).to_be_disabled()
        choices.nth(0).uncheck()
        expect(choices.nth(3)).to_be_enabled()
        choices.nth(3).check()
        save_profile(d)
        assert len(data()['profile']['defaultSkillIds']['draft']) == 3
        checks.append('per-task defaults prevent a fourth method while allowing changes to existing choices')
        # Concurrent profile updates: keep both copies before explicitly loading server state.
        d.get_by_role('tab', name='本书文风', exact=True).click()
        d.get_by_label('语气与幽默', exact=True).fill('LOCAL_CONFLICT_STYLE')
        external = data()['profile']; external['style']['tone'] = 'SERVER_CONFLICT_STYLE'; external['expectedVersion'] = external['version']
        assert context.request.put(data_url, data=external).ok
        d.get_by_role('button', name='保存创作档案', exact=True).click()
        expect(d.get_by_role('alert')).to_contain_text('已更新')
        expect(d.get_by_label('语气与幽默', exact=True)).to_have_value('LOCAL_CONFLICT_STYLE')
        with page.expect_download() as download:
            d.get_by_role('button', name='导出填写并载入最新档案', exact=True).click()
        download.value.save_as(str(OUT / 'profile-conflict-local.json'))
        expect(d.get_by_label('语气与幽默', exact=True)).to_have_value('SERVER_CONFLICT_STYLE')
        saved_local = json.loads((OUT / 'profile-conflict-local.json').read_text(encoding='utf-8'))
        assert saved_local['style']['tone'] == 'LOCAL_CONFLICT_STYLE'
        checks.append('profile conflicts retain local values; explicit reload downloads the local copy first')
        d.get_by_role('tab', name='创作技能', exact=True).click()
        d.get_by_role('navigation', name='本书创作技能').get_by_role('button').filter(has_text='审查用方法').click()
        d.get_by_label('创作方法正文', exact=True).fill('LOCAL_SKILL_CONFLICT')
        current = next(item for item in data()['skills'] if item['id'] == skill['id'])
        newer = {key: current[key] for key in fields}; newer['instructions'] = 'SERVER_SKILL_CONFLICT'
        assert context.request.put(f'{BASE}/api/books/{book["id"]}/skills/{skill["id"]}', data={'definition': newer, 'enabled': True, 'expectedVersion': current['version']}).ok
        d.get_by_role('button', name='保存新版本', exact=True).click()
        expect(d.get_by_role('alert')).to_contain_text('已更新')
        expect(d.get_by_label('创作方法正文', exact=True)).to_have_value('LOCAL_SKILL_CONFLICT')
        with page.expect_download() as download:
            d.get_by_role('button', name='导出填写并载入技能最新版本', exact=True).click()
        download.value.save_as(str(OUT / 'skill-conflict-local.json'))
        expect(d.get_by_label('创作方法正文', exact=True)).to_have_value('SERVER_SKILL_CONFLICT')
        assert json.loads((OUT / 'skill-conflict-local.json').read_text(encoding='utf-8'))['editingSkill']['instructions'] == 'LOCAL_SKILL_CONFLICT'
        checks.append('skill conflicts also preserve a downloadable draft before loading the latest version')
        current_data = data()
        builtin_id = current_data['profile']['defaultSkillIds']['draft'][0]
        builtin = next(item for item in current_data['skills'] if item['id'] == builtin_id)
        d.get_by_role('navigation', name='本书创作技能').get_by_role('button').filter(has_text=builtin['title']).click()
        d.get_by_label('本书启用此内置技能', exact=True).uncheck()
        save_profile(d)
        assert builtin_id in data()['profile']['disabledSkillIds']
        assert builtin_id not in data()['profile']['defaultSkillIds']['draft']
        d.get_by_label('本书启用此内置技能', exact=True).check()
        save_profile(d)
        assert builtin_id not in data()['profile']['disabledSkillIds']
        assert builtin_id not in data()['profile']['defaultSkillIds']['draft']
        checks.append('disabling a builtin removes it from defaults and re-enabling does not silently select it')
        d.get_by_role('navigation', name='本书创作技能').get_by_role('button').filter(has_text='审查用方法').click()
        defaults = d.get_by_text('每类任务的常用方法', exact=True).locator('..')
        if defaults.get_attribute('open') is None:
            defaults.locator(':scope > summary').click()
        defaults.get_by_label('审查用方法', exact=True).check()
        save_profile(d)
        d.get_by_label('启用自定义技能', exact=True).uncheck()
        d.get_by_role('button', name='保存新版本', exact=True).click()
        expect(d.get_by_role('alert')).to_contain_text('常用方法')
        defaults.get_by_label('审查用方法', exact=True).uncheck()
        save_profile(d)
        d.get_by_role('button', name='保存新版本', exact=True).click()
        expect(d.get_by_role('status')).to_contain_text('已停用')
        assert '请保存创作档案' not in d.get_by_role('status').inner_text()
        assert not next(item for item in data()['skills'] if item['id'] == skill['id'])['enabled']
        assert skill['id'] not in data()['profile']['defaultSkillIds']['draft']
        checks.append('an in-use custom method can be removed from defaults then disabled without misleading save advice')
        long_pack = OUT / 'long-title.json'
        long_pack.write_text(json.dumps({'format': 'shujian-skill', 'version': 1, 'definition': {**definition, 'name': 'long-title-method', 'title': 'A' * 100, 'instructions': 'Long title layout fixture.'}}), encoding='utf-8')
        d.get_by_label('导入技能文件', exact=True).set_input_files(str(long_pack))
        expect(d.get_by_role('status')).to_contain_text('独立副本')
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert d.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1')
        page.screenshot(path=str(OUT / 'editor-protection-mobile.png'))
        checks.append('editor protection, reload controls and maximum-length method titles fit a 390px viewport')
        assert not page_errors, page_errors
        assert not [(method, url) for method, url in requests if method == 'POST' and url.split('?')[0].endswith(('/api/jobs', '/api/model/test'))]
        report = {'backend': storage['driver'], 'checks': checks, 'count': len(checks), 'pageErrors': page_errors, 'modelRequests': 0, 'confirmationMessages': dialogs}
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    except Exception as error:
        page.screenshot(path=str(OUT / 'failure.png'))
        (OUT / 'failure.json').write_text(json.dumps({'error': str(error), 'completedChecks': checks, 'pageErrors': page_errors}, ensure_ascii=False, indent=2), encoding='utf-8')
        raise
    finally:
        browser.close()
