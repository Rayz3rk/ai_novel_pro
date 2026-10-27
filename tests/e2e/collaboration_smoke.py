"""Real browser workflow with a clearly labeled, deterministic local model fixture.

Run only against an isolated NOVEL_DATA_DIR; never against a personal workspace.
The ten short chapters prove engineering flow, not real-model literary quality.
"""
import json
import os
import re
from pathlib import Path
from time import monotonic
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-results'
BASE = os.environ.get('NOVEL_TEST_URL', 'http://127.0.0.1:4318')
FIXTURE = json.loads((ROOT / 'tests/fixtures/story-ten-chapters.json').read_text(encoding='utf-8'))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True)
    page = context.new_page()
    errors, checks, chapter_ids = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def current():
        response = context.request.get(f'{BASE}/api/chapters/{page.url.rsplit("/", 1)[-1]}')
        assert response.ok, response.text()
        return response.json()['chapter']

    def editor():
        return page.get_by_role('textbox', name='章节正文', exact=True)

    def wait_saved():
        expect(page.get_by_text('已保存到本地', exact=True)).to_be_visible(timeout=15000)

    def saved_text(text):
        editor().fill(text)
        editor().press('Control+s')
        wait_saved()
        assert current()['plainText'] == text

    def assistant():
        return page.get_by_role('region', name='AI 创作助手', exact=True)

    def start(kind, instruction):
        panel = assistant()
        panel.get_by_role('button', name=kind, exact=True).click()
        if kind == '起草':
            panel.get_by_label('采纳起草后自动检查', exact=True).uncheck()
        panel.get_by_role('textbox', name='创作要求', exact=True).fill(instruction)
        with page.expect_response(lambda response: response.url.endswith('/api/jobs') and response.request.method == 'POST') as created:
            panel.get_by_role('button', name=f'开始{kind}', exact=True).click()
        assert created.value.ok, created.value.text()
        job_id = created.value.json()['job']['id']
        expect(panel.get_by_label('选择创作记录')).to_have_value(job_id)
        expect(panel.locator('[data-job-status]')).to_have_attribute('data-job-status', 'succeeded', timeout=20000)
        return panel

    def adopt(label):
        assistant().get_by_role('button', name=label, exact=True).click()
        expect(assistant().get_by_text(re.compile('已采纳为第'))).to_be_visible(timeout=10000)
        wait_saved()

    def ai_open():
        page.get_by_role('button', name='AI 共创', exact=True).click()
        expect(assistant()).to_be_visible()

    try:
        page.goto(BASE)
        page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='模型连接设置', exact=True).click()
        dialog = page.get_by_role('dialog', name='模型连接', exact=True)
        dialog.get_by_label('模型基础地址').fill('http://127.0.0.1:19091/v1')
        dialog.get_by_label('模型名称', exact=True).fill('QA fixture · 工程样本')
        dialog.get_by_role('button', name='保存并测试连接', exact=True).click()
        expect(dialog.get_by_text('模型连接成功，可以开始协作。', exact=True)).to_be_visible()
        expect(dialog.get_by_label('API 密钥', exact=True)).to_have_value('')
        dialog.get_by_role('button', name='关闭', exact=True).click()
        checks.append('model settings and local compatible connection test')

        page.get_by_role('button', name='新建作品', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label(re.compile('作品名称')).fill('雾港钟声 · 十章工程样本')
        dialog.get_by_label('题材', exact=True).fill('悬疑')
        dialog.get_by_label(re.compile('故事的种子')).fill('林砚收到一封邮戳来自明天的信，决定阻止旧钟响起。')
        dialog.get_by_role('button', name='开始写作', exact=True).click()
        expect(editor()).to_be_visible()
        book_id = page.url.split('/books/', 1)[1].split('/')[0]
        page.get_by_role('textbox', name='章节名称', exact=True).fill(FIXTURE['chapters'][0]['title'])
        ai_open()
        start('讨论', 'QA:DISCUSS 请给我两个开场冲突的思路。')
        expect(assistant().get_by_role('textbox', name='AI 候选内容')).to_contain_text('旧钟')
        assert current()['plainText'] == '' and current()['outline'] == ''
        checks.append('discussion persists without changing canon or prose')

        start('策划', 'QA:PLAN 只规划当前章。')
        adopt('采纳到本章计划')
        assert '本章意图' in current()['outline']
        start('起草', 'QA:DRAFT:1 请按计划写第一章。')
        assert current()['plainText'] == ''
        candidate = assistant().get_by_role('textbox', name='AI 候选内容')
        candidate.fill(candidate.input_value() + '\n\n作者补写：门外有人停了一下。')
        assistant().get_by_text('查看与原稿的差异', exact=True).click()
        expect(assistant().locator('.diff-lines ins').first).to_be_visible()
        adopt('采纳为正文')
        assert '作者补写' in current()['plainText']
        checks.append('planning, editable candidate, explicit diff and manuscript adoption')

        editor().click()
        editor().press('Control+Home')
        editor().press('Shift+End')
        start('改稿', 'QA:REVISE 改写选中的第一段，保留后文。')
        before = current()['plainText']
        adopt('采纳选区修改')
        assert '雨敲着玻璃' in current()['plainText'] and '作者补写' in current()['plainText']
        assert before != current()['plainText']
        checks.append('real editor selection revises only the selected passage')
        start('检查', '检查当前正文，给出有出处的疑点。')
        expect(assistant().get_by_text('本次检查未报告问题。仍建议通读当前稿。', exact=True)).to_be_visible()
        page.get_by_role('button', name='定稿', exact=True).click()
        expect(page.get_by_role('dialog', name='为这一章定稿', exact=True)).to_be_visible()
        page.get_by_role('dialog', name='为这一章定稿', exact=True).get_by_role('button', name='确认定稿', exact=True).click()
        expect(page.get_by_text('这一章已定稿。继续书写时，会保留这一稿。', exact=True)).to_be_visible()
        start('整理资料', '从本章定稿整理工程样本的有据事实。')
        assistant().get_by_role('button', name='查看待确认资料', exact=True).click()
        story = page.get_by_role('dialog', name='故事资料', exact=True)
        story.get_by_role('tab', name=re.compile('待确认')).click()
        expect(story.get_by_role('button', name='确认采纳', exact=True)).to_be_visible()
        story.get_by_role('button', name='确认采纳', exact=True).click()
        story.get_by_role('tab', name=re.compile('已确认资料')).click()
        expect(story.get_by_role('heading', name='本章发生的事', exact=True)).to_be_visible()
        story.get_by_role('button', name=re.compile('查看原文')).click()
        source = page.get_by_role('dialog', name='资料的原文出处', exact=True)
        expect(source.get_by_text('雨敲着玻璃，她把信攥在掌心。', exact=True).first).to_be_visible()
        source.get_by_role('button', name='关闭窗口', exact=True).click()
        checks.append('review, final snapshot extraction, proposal confirmation and evidence preview')

        story.get_by_role('button', name='新增资料', exact=True).click()
        form = page.get_by_role('dialog', name='新增故事资料', exact=True)
        form.get_by_role('textbox', name='资料名称', exact=True).fill('许衡的真相')
        form.get_by_role('textbox', name='资料内容', exact=True).fill('许衡是写信人，林砚第八章才知道。')
        form.get_by_label('知情范围', exact=True).select_option('author')
        form.get_by_role('button', name='确认保存', exact=True).click()
        expect(story.get_by_role('heading', name='许衡的真相', exact=True)).to_be_visible()
        story.get_by_role('textbox', name='搜索故事资料', exact=True).fill('许衡')
        expect(story.locator('.story-entry')).to_have_count(1)
        story.get_by_role('textbox', name='搜索故事资料', exact=True).fill('')
        story.get_by_role('button', name='关闭窗口', exact=True).click()
        checks.append('manual author-only story setting and Chinese search')
        chapter_ids.append(current()['id'])

        for number, chapter_data in enumerate(FIXTURE['chapters'][1:], start=2):
            page.get_by_role('button', name='写下一章', exact=True).click()
            expect(editor()).to_be_visible()
            page.get_by_role('textbox', name='章节名称', exact=True).fill(chapter_data['title'])
            page.get_by_role('textbox', name='本章意图', exact=True).fill(chapter_data['outline'])
            ai_open()
            start('起草', f'QA:DRAFT:{number} 按本章意图起草，作者秘密不能成为当前人物知情。')
            job_id = assistant().get_by_label('选择创作记录').input_value()
            job = context.request.get(f'{BASE}/api/jobs/{job_id}').json()['job']
            assert not any('许衡的真相' in item['label'] for item in job['context'])
            assert any(item['source'] == 'history' for item in job['context'])
            adopt('采纳为正文')
            assert current()['plainText'] == chapter_data['text']
            page.get_by_role('button', name='定稿', exact=True).click()
            expect(page.get_by_role('dialog', name='为这一章定稿', exact=True)).to_be_visible()
            page.get_by_role('dialog', name='为这一章定稿', exact=True).get_by_role('button', name='确认定稿', exact=True).click()
            expect(page.get_by_text('这一章已定稿。继续书写时，会保留这一稿。', exact=True)).to_be_visible()
            chapter_ids.append(current()['id'])
        checks.append('ten chapter draft/adopt/finalize loop with final-prose context and author-secret filtering')
        page.screenshot(path=str(OUT / 'ten-chapters-workbench.png'))

        with page.expect_download() as download:
            page.get_by_role('button', name='导出', exact=True).click()
            page.get_by_role('button', name='Markdown .md', exact=True).click()
        downloaded = download.value
        target = OUT / 'ten-chapters-export.md'
        downloaded.save_as(str(target))
        exported = target.read_text(encoding='utf-8-sig')
        for chapter_data in FIXTURE['chapters']:
            assert '## ' + chapter_data['title'] in exported
        checks.append('ten-chapter Markdown export preserves every chapter')

        first = page.get_by_role('navigation', name='章节目录', exact=True).get_by_role('button').filter(has_text=FIXTURE['chapters'][0]['title'])
        first.click()
        expect(editor()).to_contain_text('作者补写')
        saved_text('林砚没有拆信。她决定先去北岸。')
        page.get_by_role('button', name='定稿', exact=True).click()
        page.get_by_role('dialog', name='为这一章定稿', exact=True).get_by_role('button', name='确认定稿', exact=True).click()
        expect(page.get_by_text('这一章已定稿。继续书写时，会保留这一稿。', exact=True)).to_be_visible()
        page.get_by_role('button', name='故事资料', exact=True).click()
        story = page.get_by_role('dialog', name='故事资料', exact=True)
        expect(story.get_by_text('待复核', exact=True)).to_be_visible()
        story.get_by_role('tab', name=re.compile('修改影响')).click()
        expect(story.get_by_text('需要复核', exact=True)).to_be_visible()
        expect(story.get_by_role('button', name=re.compile('钥匙交接'))).to_be_visible()
        story.get_by_role('button', name='关闭窗口', exact=True).click()
        checks.append('old chapter re-finalization marks dependent facts and later chapters for review')

        ai_open()
        panel = assistant()
        panel.get_by_role('button', name='起草', exact=True).click()
        panel.get_by_role('textbox', name='创作要求', exact=True).fill('QA:DRAFT:1 QA:SLOW 验证刷新恢复。')
        panel.get_by_role('button', name='开始起草', exact=True).click()
        expect(panel.locator('[data-job-status]')).to_have_attribute('data-job-status', 'running')
        page.reload()
        expect(editor()).to_be_visible()
        ai_open()
        expect(assistant().locator('[data-job-status]')).to_have_attribute('data-job-status', 'running')
        assistant().get_by_role('button', name='停止生成', exact=True).click()
        expect(assistant().locator('[data-job-status]')).to_have_attribute('data-job-status', 'cancelled')
        assert current()['plainText'] == '林砚没有拆信。她决定先去北岸。'
        checks.append('live task survives page refresh, cancellation never writes partial output to prose')

        page.set_viewport_size({'width': 390, 'height': 844})
        expect(editor()).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        ai_open()
        expect(assistant()).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(OUT / 'ai-mobile.png'))
        checks.append('mobile authoring and AI panel stay within viewport')
        assert not errors, errors
        report = {'label': FIXTURE['label'], 'checks': checks, 'pageErrors': errors, 'bookId': book_id, 'chapterIds': chapter_ids}
        (OUT / 'collaboration-browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    except Exception:
        page.screenshot(path=str(OUT / 'collaboration-failure.png'))
        print(json.dumps({'url': page.url, 'errors': errors, 'checks': checks, 'alerts': page.get_by_role('alert').all_text_contents()}, ensure_ascii=False))
        raise
    finally:
        browser.close()
