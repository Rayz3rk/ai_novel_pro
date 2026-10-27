"""Creative 1.1 acceptance, only against isolated workspaces and local model fixture."""
import json
import os
import re
import uuid
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('NOVEL_CREATIVE_TEST_OUTPUT', str(ROOT / 'test-results/creative-browser')))
OUT.mkdir(exist_ok=True, parents=True)
BASE = os.environ.get('NOVEL_TEST_URL', 'http://127.0.0.1:5177')
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, **({'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    state = context.request.get(BASE + '/api/storage').json()['storage']
    assert (state['driver'] == 'sqlite' and ('novel-qa-creative-' in state['database'] or 'test-results' in state['database'])) or (state['driver'] == 'postgresql' and state['database'].startswith('shujian_test_'))
    settings = context.request.get(BASE + '/api/model').json()['settings']
    settings.update(baseUrl='http://127.0.0.1:19091/v1', model='QA fixture · 工程样本', stream=True, maxOutputTokens=1024, contextWindow=24000, inputPricePerMillion=1, outputPricePerMillion=2, taskBudget=None, dailyBudget=None)
    assert context.request.put(BASE + '/api/model', data=settings).ok
    book = context.request.post(BASE + '/api/books', data={'title': '创作技能 · 完整界面验收'}).json()['book']
    chapter = context.request.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters'][0]
    text = '她把伞靠在门边，等对方先开口。🙂\n[待补正文]'
    chapter = context.request.put(f'{BASE}/api/chapters/{chapter["id"]}/draft', data={'expectedVersion': chapter['version'], 'title': chapter['title'], 'outline': '两个人各有自己的打算。', 'document': {'type': 'doc', 'content': [{'type': 'paragraph', 'content': [{'type': 'text', 'text': text}]}]}}).json()['chapter']
    page = context.new_page()
    errors, checks = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())

    def data():
        return context.request.get(f'{BASE}/api/books/{book["id"]}/creative').json()

    def open_desk():
        page.get_by_role('button', name='文风与技能', exact=True).click()
        dialog = page.get_by_role('dialog', name='文风与创作技能', exact=True)
        expect(dialog.get_by_label('技能标题', exact=True)).to_be_visible()
        return dialog

    def save_profile(dialog):
        dialog.get_by_role('button', name='保存创作档案', exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('创作档案已保存')

    def fixture_calls():
        return context.request.get('http://127.0.0.1:19091/health').json()['calls']

    try:
        page.goto(f'{BASE}/#/books/{book["id"]}/chapters/{chapter["id"]}')
        page.wait_for_load_state('networkidle')
        dialog = open_desk()
        assert len(data()['skills']) == 6
        dialog.get_by_role('tab', name='本书文风', exact=True).click()
        dialog.get_by_label('叙述方式', exact=True).fill('第三人称限制视角。')
        dialog.get_by_label('语气与幽默', exact=True).fill('STYLE_UI_VERIFIED · 幽默来自反差。')
        save_profile(dialog)
        dialog.get_by_role('tab', name='人物声音', exact=True).click()
        for index, name, traits in [(1, '甲', 'VOICE_SELECTED_UI'), (2, '乙', 'VOICE_NOT_SELECTED_UI')]:
            dialog.get_by_role('button', name='添加人物声音', exact=True).click()
            dialog.get_by_label(f'人物名称 {index}', exact=True).fill(name)
            dialog.get_by_label(f'声音特点 {index}', exact=True).fill(traits)
            dialog.get_by_label(f'对白示例 {index}', exact=True).fill('我会先把这件事做完。')
        save_profile(dialog)
        checks.append('style and independent character voice cards persist with explicit saves')
        dialog.get_by_role('tab', name='偏好案例', exact=True).click()
        dialog.get_by_role('button', name='添加偏好案例', exact=True).click()
        for label, value in [('案例标题 1', '对白先有具体行动'), ('修改前 1', '她非常紧张。'), ('作者改稿 1', '她把纸杯握扁了一点。'), ('修改理由 1', 'PREFERENCE_CONFIRMED_ONLY'), ('适用条件 1', '紧张的对白场景')]:
            dialog.get_by_label(label, exact=True).fill(value)
        save_profile(dialog)
        assert data()['profile']['preferences'][0]['status'] == 'pending'
        checks.append('preference examples remain pending until explicitly confirmed')
        dialog.get_by_role('tab', name='创作技能', exact=True).click()
        dialog.get_by_label('技能标题', exact=True).fill('场景方法 · 工程样本')
        dialog.get_by_label('技能英文标识', exact=True).fill('ui-scene-method')
        dialog.get_by_label('创作方法正文', exact=True).fill('METHOD_V1_STABLE。保留作者给定的信息，只产生候选。')
        dialog.get_by_text('来源、许可与可选参考资料', exact=True).click()
        dialog.get_by_role('button', name='添加文本参考', exact=True).click()
        dialog.get_by_label('参考资料路径 1', exact=True).fill('references/example.md')
        dialog.get_by_label('参考资料正文 1', exact=True).fill('RESOURCE_EXPLICITLY_SELECTED')
        dialog.get_by_role('button', name='保存为我的技能', exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('V1')
        skill = next(item for item in data()['skills'] if not item['builtin'])
        dialog.get_by_text('每类任务的常用方法', exact=True).click()
        dialog.get_by_label('常用技能任务', exact=True).select_option('draft')
        dialog.get_by_label('场景方法 · 工程样本', exact=True).check()
        save_profile(dialog)
        checks.append('builtin method can become a custom version with resources and per-task defaults')
        page.screenshot(path=str(OUT / 'creative-desk-desktop.png'))
        dialog.get_by_role('button', name='关闭窗口', exact=True).click()
        page.get_by_role('button', name='AI 共创', exact=True).click()
        assistant = page.get_by_role('region', name='AI 创作助手', exact=True)
        assistant.get_by_role('button', name='起草', exact=True).click()
        assistant.get_by_label('采纳起草后自动检查', exact=True).uncheck()
        assistant.locator('details.creative-methods > summary').click()
        expect(assistant.get_by_label('使用方法：场景方法 · 工程样本', exact=True)).to_be_checked()
        assistant.get_by_label('方法补充：场景方法 · 工程样本', exact=True).fill('保留人物各自的目的。')
        assistant.get_by_label('加载参考：references/example.md', exact=True).check()
        assistant.get_by_label('参考人物声音：甲', exact=True).check()
        assistant.get_by_label('创作要求', exact=True).fill('QA:DRAFT:1')
        before = fixture_calls()
        versions_before = context.request.get(f'{BASE}/api/chapters/{chapter["id"]}/versions').json()['versions']
        with page.expect_response(lambda response: response.url.endswith('/api/jobs/preview')) as response:
            assistant.get_by_role('button', name='预览本次材料与费用', exact=True).click()
        preview = response.value.json()['preview']
        messages = json.dumps(preview['prompt']['messages'], ensure_ascii=False)
        assert all(value in messages for value in ['METHOD_V1_STABLE', 'STYLE_UI_VERIFIED', 'VOICE_SELECTED_UI', 'RESOURCE_EXPLICITLY_SELECTED'])
        assert 'VOICE_NOT_SELECTED_UI' not in messages and 'PREFERENCE_CONFIRMED_ONLY' not in messages
        assert fixture_calls() == before
        assert context.request.get(f'{BASE}/api/chapters/{chapter["id"]}/versions').json()['versions'] == versions_before
        preview_dialog = page.get_by_role('dialog', name='本次会用到的材料', exact=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert preview_dialog.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1')
        page.screenshot(path=str(OUT / 'creative-preview-mobile.png'))
        checks.append('preview is free of model calls and checkpoints, uses selected materials only and fits mobile')
        with page.expect_response(lambda response: response.url.endswith('/api/jobs') and response.request.method == 'POST') as created:
            preview_dialog.get_by_role('button', name='按此材料开始任务', exact=True).click()
        job = created.value.json()['job']
        expect(assistant.locator('[data-job-status]')).to_have_attribute('data-job-status', 'succeeded', timeout=20000)
        saved_job = context.request.get(f'{BASE}/api/jobs/{job["id"]}').json()['job']
        assert saved_job['promptSnapshot'] == preview['prompt'] and fixture_calls() == before + 1
        assert context.request.get(f'{BASE}/api/chapters/{chapter["id"]}').json()['chapter']['plainText'] == text
        checks.append('starting a preview uses its exact frozen prompt and leaves the manuscript untouched')
        assistant.get_by_text('创作方法与实际提示快照', exact=True).click()
        with page.expect_download() as downloaded:
            assistant.get_by_role('button', name='导出冻结评测样本', exact=True).click()
        downloaded.value.save_as(str(OUT / 'evaluation-sample.json'))
        sample = json.loads((OUT / 'evaluation-sample.json').read_text(encoding='utf-8'))
        assert sample['prompt'] == preview['prompt'] and 'apiKey' not in json.dumps(sample)
        checks.append('evaluation export preserves the prompt and public parameters, excluding credentials')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        dialog = open_desk()
        dialog.get_by_role('navigation', name='本书创作技能').get_by_role('button').filter(has_text='场景方法 · 工程样本').click()
        dialog.get_by_label('创作方法正文', exact=True).fill('METHOD_V2_NEW。仍不改变作者决定。')
        dialog.get_by_role('button', name='保存新版本', exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('V2')
        assert context.request.get(f'{BASE}/api/jobs/{job["id"]}').json()['job']['promptSnapshot'] == preview['prompt']
        dialog.get_by_role('button', name='查看技能历史', exact=True).click()
        expect(dialog.get_by_text('保留的技能版本', exact=True)).to_be_visible()
        checks.append('editing a skill retains history and never rewrites earlier job snapshots')
        dialog.get_by_role('tab', name='偏好案例', exact=True).click()
        dialog.get_by_label('偏好确认状态 1', exact=True).select_option('confirmed')
        save_profile(dialog)
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        assert dialog.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1')
        page.screenshot(path=str(OUT / 'creative-profile-mobile.png'))
        dialog.get_by_role('button', name='关闭窗口', exact=True).click()
        page.set_viewport_size({'width': 1440, 'height': 1000})
        with page.expect_response(lambda response: response.url.endswith('/api/jobs/preview')) as response:
            assistant.get_by_role('button', name='预览本次材料与费用', exact=True).click()
        latest = response.value.json()['preview']
        assert 'PREFERENCE_CONFIRMED_ONLY' in json.dumps(latest['prompt']['messages'])
        p = data()['profile']; p['style']['tone'] += ' · 外部更新'; p['expectedVersion'] = p['version']
        assert context.request.put(f'{BASE}/api/books/{book["id"]}/creative', data=p).ok
        count = fixture_calls()
        preview_dialog = page.get_by_role('dialog', name='本次会用到的材料', exact=True)
        preview_dialog.get_by_role('button', name='按此材料开始任务', exact=True).click()
        expect(preview_dialog.get_by_role('alert')).to_contain_text('重新预览')
        assert fixture_calls() == count
        preview_dialog.get_by_role('button', name='返回调整', exact=True).click()
        checks.append('confirmed preferences participate; external changes invalidate a preview before any charge')
        assistant.get_by_role('button', name='基础稿件检查 · 不调用模型', exact=True).click()
        expect(assistant.locator('.clean-findings')).to_contain_text('[待补正文]')
        assert fixture_calls() == count
        checks.append('basic manuscript cleanup gives evidence without a model call or automatic rewrite')
        assistant.get_by_role('button', name='记录作者改稿偏好', exact=True).click()
        dialog = page.get_by_role('dialog', name='文风与创作技能', exact=True)
        expect(dialog.get_by_label('偏好确认状态 2', exact=True)).to_have_value('pending')
        assert dialog.get_by_label('修改前 2', exact=True).input_value() == saved_job['output'][:6000]
        assert dialog.get_by_label('作者改稿 2', exact=True).input_value() == text
        save_profile(dialog)
        checks.append('author feedback captures actual before and after text as a pending, sourced case')
        dialog.get_by_role('button', name='关闭窗口', exact=True).click()
        other = context.request.post(f'{BASE}/api/books/{book["id"]}/chapters', data={}).json()['chapter']
        foreign = context.request.post(BASE + '/api/jobs', data={'requestId': str(uuid.uuid4()), 'kind': 'draft', 'chapterId': other['id'], 'expectedVersion': other['version'], 'instruction': 'QA:DRAFT:2', 'skills': []}).json()['job']
        page.reload(); page.get_by_role('button', name='AI 共创', exact=True).click()
        picker = assistant.get_by_label('选择创作记录', exact=True)
        expect(picker).to_have_value(job['id'])
        expect(picker.locator(f'option[value="{foreign["id"]}"]')).to_have_count(0)
        expect(assistant.get_by_role('button', name='记录作者改稿偏好', exact=True)).to_be_visible()
        checks.append('feedback never pairs another chapter job with the current manuscript')
        dialog = open_desk()
        exported = context.request.get(f'{BASE}/api/books/{book["id"]}/skills/{skill["id"]}/export').json()
        import_path = OUT / 'roundtrip.skill.json'; import_path.write_text(json.dumps(exported, ensure_ascii=False), encoding='utf-8')
        dialog.get_by_label('导入技能文件', exact=True).set_input_files(str(import_path))
        expect(dialog.get_by_role('status')).to_contain_text('独立副本')
        assert len([entry for entry in data()['skills'] if not entry['builtin']]) == 2
        bad = OUT / 'rejected.SKILL.md'; bad.write_text('---\nname: rejected-method\ndescription: test\nallowed-tools: Bash\n---\nDo not execute.', encoding='utf-8')
        dialog.get_by_label('导入技能文件', exact=True).set_input_files(str(bad))
        expect(dialog.get_by_role('alert')).to_contain_text('不授予工具权限')
        assert len([entry for entry in data()['skills'] if not entry['builtin']]) == 2
        checks.append('UI imports declarative resource packages and rejects executable permissions without mutations')
        dialog.get_by_role('button', name='关闭窗口', exact=True).click()
        backup = context.request.get(BASE + '/api/backup').json()
        backup['books'] = [item for item in backup['books'] if item['book']['id'] == book['id']]
        result = context.request.post(BASE + '/api/backup/restore', data={'backup': backup})
        assert result.ok, result.text()
        restored_id = result.json()['books'][0]['id']
        restored = context.request.get(f'{BASE}/api/books/{restored_id}/creative').json()
        assert restored['profile']['style'] == data()['profile']['style']
        assert len(restored['profile']['preferences']) == 2 and len(restored['profile']['voices']) == 2
        assert len([entry for entry in restored['skills'] if not entry['builtin']]) == 2
        checks.append('complete backup restores methods, resources, profiles, preferences and linked jobs')
        assert not errors, errors
        report = {'backend': state['driver'], 'checks': checks, 'count': len(checks), 'pageErrors': errors}
        (OUT / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    finally:
        browser.close()
