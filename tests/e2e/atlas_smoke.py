"""1.2 setting workbench acceptance. Isolated storage and deterministic local model only."""
import json
import os
import uuid
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BASE = os.environ.get('NOVEL_TEST_URL', 'http://127.0.0.1:5182')
OUT = Path(os.environ.get('NOVEL_ATLAS_TEST_OUTPUT', str(ROOT / 'test-results/atlas-browser')))
OUT.mkdir(parents=True, exist_ok=True)
checks, errors = [], []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, **({'executable_path': os.environ['PLAYWRIGHT_CHROMIUM_EXECUTABLE']} if os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') else {}))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    request = context.request

    def call(method, path, value=None):
        result = getattr(request, method)(BASE + '/api' + path, **({'data': value} if value is not None else {}))
        assert result.ok, (result.status, result.text())
        return result.json()

    storage = call('get', '/storage')['storage']
    assert (storage['driver'] == 'sqlite' and any(value in storage['database'] for value in ['novel-qa-', 'test-results'])) or (storage['driver'] == 'postgresql' and storage['database'].startswith('shujian_test_'))
    settings = call('get', '/model')['settings']
    settings.update(baseUrl='http://127.0.0.1:19091/v1', model='QA atlas fixture', stream=True, maxOutputTokens=1024, contextWindow=24000, taskBudget=None, dailyBudget=None)
    call('put', '/model', settings)
    book = call('post', '/books', {'title': '设定图谱 · 完整功能验收'})['book']
    bid = book['id']
    chapter = call('get', f'/books/{bid}/chapters')['chapters'][0]
    second = call('post', f'/books/{bid}/chapters', {})['chapter']
    profile = call('get', f'/books/{bid}/creative')['profile']
    call('put', f'/books/{bid}/creative', {**profile, 'expectedVersion': profile['version'], 'voices': [{'id': 'atlas-voice-a', 'name': '测试甲', 'aliases': [], 'traits': 'ATLAS_LINKED_VOICE', 'example': ''}]})

    def card(title, kind='character', **extra):
        return call('post', f'/books/{bid}/story', {'kind': kind, 'authority': 'setting', 'title': title, 'content': title + '的工程样本说明', **extra})['entry']

    a = card('测试甲', attributes={'identity': '原有身份', 'secret': 'PRIVATE_ATLAS_SECRET'}, links={'voiceId': 'atlas-voice-a'})
    b = card('测试乙')
    campus = card('测试校园', 'location')
    room = card('测试活动室', 'location', links={'parentId': campus['id']})
    item = card('蓝色雨伞', 'item', attributes={'status': '完好'})
    card('测试社团', 'organization')
    note_a = card('方案甲便签', 'note', status='idea', branch='方案A', content='BRANCH_A_ONLY')
    note_b = card('方案乙便签', 'note', status='idea', branch='方案B', content='BRANCH_B_ONLY')
    book_plan = call('post', f'/books/{bid}/plans', {'level': 'book', 'title': '测试规划', 'content': '', 'position': 1, 'parentId': None, 'chapterId': None})['plan']
    chapter_plan = call('post', f'/books/{bid}/plans', {'level': 'chapter', 'title': '首章规划', 'content': '', 'position': 1, 'parentId': book_plan['id'], 'chapterId': chapter['id']})['plan']
    scene_plan = call('post', f'/books/{bid}/plans', {'level': 'scene', 'title': '测试雨天撤摊', 'content': 'SCENE_SOURCE_SINGLE_COPY', 'position': 1, 'parentId': chapter_plan['id'], 'chapterId': chapter['id']})['plan']

    def data():
        return call('get', f'/books/{bid}/atlas')

    def fixture_calls():
        return request.get('http://127.0.0.1:19091/health').json()['calls']

    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())

    def open_desk():
        page.get_by_role('button', name='设定与图谱', exact=True).click()
        dialog = page.get_by_role('dialog', name='小说设定与关系图', exact=True)
        expect(dialog.get_by_label('搜索设定卡', exact=True)).to_be_visible()
        return dialog

    try:
        page.goto(f'{BASE}/#/books/{bid}/chapters/{chapter["id"]}')
        desk = open_desk()
        desk.get_by_role('button', name='测试甲', exact=True).click()
        desk.get_by_role('button', name='编辑设定卡', exact=True).click()
        editor = page.get_by_role('dialog', name='编辑设定卡', exact=True)
        expect(editor.get_by_label('卡片人物声音', exact=True)).to_have_value('atlas-voice-a')
        editor.get_by_label('卡片属性：身份与角色', exact=True).fill('UI_STRUCTURED_IDENTITY')
        editor.get_by_label('设定卡别名', exact=True).fill('甲同学、阿甲')
        editor.get_by_role('button', name='保存设定卡', exact=True).click()
        expect(editor).not_to_be_visible()
        saved_a = next(row for row in data()['nodes'] if row['id'] == a['id'])
        assert saved_a['attributes']['identity'] == 'UI_STRUCTURED_IDENTITY' and saved_a['aliases'] == ['甲同学', '阿甲']
        checks.append('legacy canonical ID, structured fields, aliases and linked voice survive UI edits')

        desk.get_by_role('button', name='新建卡片', exact=True).click()
        editor = page.get_by_role('dialog', name='新建设定卡', exact=True)
        editor.get_by_label('设定卡类型', exact=True).select_option('note')
        editor.get_by_label('设定卡名称', exact=True).fill('先便签后人物')
        editor.get_by_label('设定卡说明', exact=True).fill('保留原来的构思说明')
        editor.get_by_role('button', name='保存设定卡', exact=True).click()
        expect(editor).not_to_be_visible()
        note = next(row for row in data()['nodes'] if row['title'] == '先便签后人物')
        assert note['status'] == 'idea'
        desk.get_by_role('button', name='编辑设定卡', exact=True).click()
        editor = page.get_by_role('dialog', name='编辑设定卡', exact=True)
        editor.get_by_label('设定卡类型', exact=True).select_option('character')
        editor.get_by_label('设定卡状态', exact=True).select_option('confirmed')
        editor.get_by_role('button', name='保存设定卡', exact=True).click()
        expect(editor).not_to_be_visible()
        assert next(row for row in data()['nodes'] if row['id'] == note['id'])['kind'] == 'character'
        checks.append('a quick idea card converts to a confirmed character while preserving its stable ID')

        desk.get_by_text('比较构思方案', exact=True).click()
        desk.get_by_label('比较方案 A', exact=True).select_option('方案A')
        desk.get_by_label('比较方案 B', exact=True).select_option('方案B')
        expect(desk.locator('.atlas-compare-grid')).to_contain_text('BRANCH_A_ONLY')
        expect(desk.locator('.atlas-compare-grid')).to_contain_text('BRANCH_B_ONLY')
        desk.get_by_text('比较构思方案', exact=True).click()
        checks.append('branches can be compared without confirming ideas or calling a model')

        desk.get_by_role('tab', name='关系图谱', exact=True).click()
        desk.get_by_role('button', name='新建关系', exact=True).click()
        editor = page.get_by_role('dialog', name='建立关系', exact=True)
        editor.get_by_label('关系起点', exact=True).select_option(a['id'])
        editor.get_by_label('关系终点', exact=True).select_option(b['id'])
        editor.get_by_label('关系含义', exact=True).fill('最初认识')
        editor.get_by_label('图谱记录状态', exact=True).select_option('confirmed')
        editor.get_by_role('button', name='保存关系', exact=True).click()
        expect(editor).not_to_be_visible()
        relation = next(row for row in data()['relations'] if row['label'] == '最初认识')
        assert not relation['symmetric'] and relation['phase'] == 'confirmed'
        node = desk.get_by_role('button', name='图谱卡片：测试甲', exact=True)
        node.scroll_into_view_if_needed()
        bounds = node.bounding_box()
        page.mouse.move(bounds['x'] + bounds['width'] / 2, bounds['y'] + bounds['height'] / 2)
        page.mouse.down()
        page.mouse.move(bounds['x'] + bounds['width'] / 2 + 80, bounds['y'] + bounds['height'] / 2 + 55, steps=12)
        page.mouse.up()
        desk.get_by_role('button', name='保存布局 · 未保存', exact=True).click()
        expect(desk.get_by_role('status')).to_contain_text('图谱布局已保存')
        view = data()['view']
        assert a['id'] in view['positions'] and next(row for row in data()['nodes'] if row['id'] == a['id'])['version'] == saved_a['version']
        page.screenshot(path=str(OUT / 'graph-desktop.png'))
        desk.get_by_role('button', name='关闭窗口', exact=True).click()
        desk = open_desk()
        desk.get_by_role('tab', name='关系图谱', exact=True).click()
        assert data()['view'] == view
        checks.append('manual directed relationship and drag/save/reopen layout work without revising story cards')

        row = desk.locator('.atlas-relation').filter(has_text='最初认识')
        row.get_by_role('button', name='编辑', exact=True).click()
        editor = page.get_by_role('dialog', name='编辑关系', exact=True)
        editor.get_by_label('关系说明', exact=True).fill('UNSAVED_RELATION_CONFLICT')
        latest = next(edge for edge in data()['relations'] if edge['id'] == relation['id'])
        call('put', f'/atlas/relations/{relation["id"]}', {**latest, 'expectedVersion': latest['version'], 'description': 'NEW_RELATION_DESCRIPTION'})
        editor.get_by_role('button', name='保存关系', exact=True).click()
        expect(editor.get_by_role('alert')).to_contain_text('已更新')
        expect(editor.get_by_label('关系说明', exact=True)).to_have_value('UNSAVED_RELATION_CONFLICT')
        with page.expect_download() as download:
            editor.get_by_role('button', name='导出填写并读取最新版', exact=True).click()
        download.value.save_as(str(OUT / 'relation-conflict-preserved.json'))
        expect(editor.get_by_label('关系说明', exact=True)).to_have_value('NEW_RELATION_DESCRIPTION')
        editor.get_by_role('button', name='保存关系', exact=True).click()
        expect(editor).not_to_be_visible()
        checks.append('relationship conflicts preserve input and explicitly reload a newer version before saving')

        row = desk.locator('.atlas-relation').filter(has_text='最初认识')
        row.get_by_role('button', name='记录关系变化', exact=True).click()
        editor = page.get_by_role('dialog', name='记录关系变化', exact=True)
        editor.get_by_label('关系含义', exact=True).fill('正式搭档')
        editor.get_by_label('图谱记录生效章节', exact=True).fill('2')
        editor.get_by_role('button', name='保存关系新阶段', exact=True).click()
        expect(editor).not_to_be_visible()
        expect(desk.get_by_label('图谱章节基准', exact=True)).to_have_value('2')
        expect(desk.locator('.atlas-relations')).to_contain_text('正式搭档')
        expect(desk.locator('.atlas-relations')).not_to_contain_text('最初认识')
        desk.get_by_label('图谱章节基准', exact=True).fill('1')
        expect(desk.locator('.atlas-relations')).to_contain_text('最初认识')
        desk.get_by_role('button', name='图谱卡片：蓝色雨伞', exact=True).click()
        desk.get_by_role('button', name='记录剧情状态', exact=True).click()
        editor = page.get_by_role('dialog', name='记录剧情状态', exact=True)
        editor.get_by_label('剧情状态说明', exact=True).fill('第二章雨伞被淋湿')
        editor.get_by_text('更新哪些属性（只填有变化的部分）', exact=True).click()
        editor.get_by_label('状态属性：剧情状态', exact=True).fill('被淋湿')
        editor.get_by_label('图谱记录状态', exact=True).select_option('confirmed')
        editor.get_by_label('图谱记录生效章节', exact=True).fill('2')
        editor.get_by_role('button', name='保存剧情状态', exact=True).click()
        expect(editor).not_to_be_visible()
        expect(desk.get_by_role('complementary', name='选中卡片详情')).to_contain_text('被淋湿')
        desk.get_by_label('图谱章节基准', exact=True).fill('1')
        expect(desk.get_by_role('complementary', name='选中卡片详情')).not_to_contain_text('被淋湿')
        assert next(row for row in data()['nodes'] if row['id'] == item['id'])['attributes']['status'] == '完好'
        desk.get_by_label('图谱章节基准', exact=True).fill('0')
        desk.get_by_role('tab', name='剧情时间线', exact=True).click()
        expect(desk.locator('.atlas-timeline')).to_contain_text('第二章雨伞被淋湿')
        checks.append('relationship evolution closes the old interval; chapter states change the view while static archives remain intact')

        desk.get_by_text('从现有规划和 AI 讨论整理资料', exact=True).click()
        desk.get_by_label('导入已有场景规划', exact=True).select_option(scene_plan['id'])
        desk.get_by_role('button', name='建立关联场景卡', exact=True).click()
        expect(desk.get_by_role('status')).to_contain_text('已关联原有场景规划')
        scene = next(row for row in data()['nodes'] if row.get('links', {}).get('planId') == scene_plan['id'])
        assert scene['status'] == 'idea' and scene['content'] != scene_plan['content']
        checks.append('existing scene plans link into the workbench without a second editable copy')

        desk.get_by_role('tab', name='设定卡片', exact=True).click()
        desk.get_by_label('选入子图：测试甲', exact=True).check()
        desk.get_by_label('选入子图：测试乙', exact=True).check()
        before = fixture_calls()
        desk.get_by_role('button', name='让 AI 提出关系建议', exact=True).click()
        expect(desk).not_to_be_visible()
        assistant = page.get_by_role('region', name='AI 创作助手', exact=True)
        expect(assistant).to_contain_text('本次使用图谱子图')
        assistant.get_by_label('创作要求', exact=True).fill('QA:ATLAS:RELATIONS')
        with page.expect_response(lambda response: response.url.endswith('/api/jobs/preview')) as response:
            assistant.get_by_role('button', name='预览本次材料与费用', exact=True).click()
        preview = response.value.json()['preview']
        prompt = json.dumps(preview['prompt']['messages'], ensure_ascii=False)
        assert a['id'] in prompt and b['id'] in prompt and 'ATLAS_LINKED_VOICE' in prompt
        assert fixture_calls() == before
        preview_dialog = page.get_by_role('dialog', name='本次会用到的材料', exact=True)
        with page.expect_response(lambda response: response.url.endswith('/api/jobs') and response.request.method == 'POST') as response:
            preview_dialog.get_by_role('button', name='按此材料开始任务', exact=True).click()
        job = response.value.json()['job']
        expect(assistant.locator('[data-job-status]')).to_have_attribute('data-job-status', 'succeeded', timeout=20000)
        assert fixture_calls() == before + 1
        desk = open_desk()
        desk.get_by_text('从现有规划和 AI 讨论整理资料', exact=True).click()
        desk.get_by_role('button', name='读取图谱讨论记录', exact=True).click()
        expect(desk.get_by_label('选择关系建议讨论').locator('option[value="'+job['id']+'"]')).to_have_count(1)
        desk.get_by_label('选择关系建议讨论', exact=True).select_option(job['id'])
        desk.get_by_role('button', name='整理为待确认关系', exact=True).click()
        expect(desk.get_by_role('status')).to_contain_text('等待你核对')
        imported = next(row for row in data()['relations'] if row['sourceJobId'] == job['id'])
        assert imported['phase'] == 'idea' and imported['visibility'] == 'author'
        assert call('get', f'/chapters/{chapter["id"]}')['chapter']['plainText'] == ''
        checks.append('selected subgraph and linked voices preview for free; one fixture discussion imports only author-private unconfirmed proposals')

        for width in [390, 320]:
            page.set_viewport_size({'width': width, 'height': 844})
            desk.get_by_role('tab', name='关系图谱', exact=True).click()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            assert desk.evaluate('(node) => node.scrollWidth <= node.clientWidth + 1')
            page.screenshot(path=str(OUT / f'graph-mobile-{width}.png'))
        checks.append('workbench, graph and relationship forms fit 390px and 320px without page overflow')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        desk.get_by_role('tab', name='设定卡片', exact=True).click()
        desk.get_by_role('button', name='测试甲', exact=True).click()
        desk.get_by_role('button', name='编辑设定卡', exact=True).click()
        editor = page.get_by_role('dialog', name='编辑设定卡', exact=True)
        editor.get_by_label('设定卡说明', exact=True).fill('UI_UNSAVED_CONFLICT')
        current = call('get', f'/story/{a["id"]}')['entry']
        call('put', f'/story/{a["id"]}', {**current, 'expectedVersion': current['version'], 'content': 'EXTERNAL_NEWEST'})
        editor.get_by_role('button', name='保存设定卡', exact=True).click()
        expect(editor.get_by_role('alert')).to_contain_text('已更新')
        expect(editor.get_by_label('设定卡说明', exact=True)).to_have_value('UI_UNSAVED_CONFLICT')
        with page.expect_download() as download:
            editor.get_by_role('button', name='导出并载入最新', exact=True).click()
        download.value.save_as(str(OUT / 'conflict-preserved.json'))
        expect(editor.get_by_label('设定卡说明', exact=True)).to_have_value('EXTERNAL_NEWEST')
        editor.get_by_role('button', name='取消', exact=True).click()
        checks.append('stale card writes retain unsaved text, export it and explicitly reload the newest canonical record')

        desk.get_by_role('button', name='先便签后人物', exact=True).click()
        desk.get_by_role('button', name='历史与撤销', exact=True).click()
        history = page.get_by_role('dialog', name='设定历史与撤销', exact=True)
        history.locator('details').last.locator('summary').click()
        history.locator('details').last.get_by_role('button', name='恢复这一版', exact=True).click()
        expect(history).not_to_be_visible()
        restored_note = next(node for node in data()['nodes'] if node['id'] == note['id'])
        assert restored_note['kind'] == 'note' and restored_note['status'] == 'idea' and restored_note['version'] == 3
        checks.append('undo restores an earlier idea as a new audited version without removing later history')

        backup = call('get', '/backup')
        restored = call('post', '/backup/restore', {'backup': backup})['books']
        restored_book = next(row for row in restored if row['title'].startswith(book['title']))
        result = call('get', f'/books/{restored_book["id"]}/atlas')
        assert len(result['nodes']) == len(data()['nodes']) and len(result['relations']) == len(data()['relations'])
        new_a = next(row for row in result['nodes'] if row['title'] == '测试甲')
        assert new_a['id'] != a['id'] and new_a['links']['voiceId'] != 'atlas-voice-a'
        assert all(edge['fromId'] in {node['id'] for node in result['nodes']} for edge in result['relations'])
        checks.append('complete backup restores graph, cards, scene/voice links, histories, job sources and layout with new IDs')
        assert not errors, errors
    finally:
        page.screenshot(path=str(OUT / 'last-state.png'))
        (OUT / 'report.json').write_text(json.dumps({'passed': not errors and len(checks) == 12, 'storage': storage['driver'], 'checks': checks, 'pageErrors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
print(json.dumps({'checks': len(checks), 'pageErrors': errors}, ensure_ascii=False))
