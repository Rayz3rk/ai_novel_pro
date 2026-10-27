"""Additional browser acceptance: platform profiles, story planning and local candidates."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-results'
BASE=os.environ.get('NOVEL_TEST_URL','http://127.0.0.1:4318')
record=json.loads((OUT/'collaboration-browser-report.json').read_text(encoding='utf-8'))
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page()
    errors=[];checks=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    def panel(): return page.get_by_role('region',name='AI 创作助手',exact=True)
    def editor(): return page.get_by_role('textbox',name='章节正文',exact=True)
    def open_ai(): page.get_by_role('button',name='AI 共创',exact=True).click()
    def start(kind,instruction):
        panel().get_by_role('button',name=kind,exact=True).click()
        panel().get_by_role('textbox',name='创作要求').fill(instruction)
        with page.expect_response(lambda r:r.url.endswith('/api/jobs') and r.request.method=='POST') as created:
            panel().get_by_role('button',name='开始'+kind,exact=True).click()
        assert created.value.ok,created.value.text()
        identifier=created.value.json()['job']['id']
        expect(panel().get_by_label('选择创作记录')).to_have_value(identifier)
        expect(panel().locator('[data-job-status]')).to_have_attribute('data-job-status','succeeded',timeout=15000)
        return identifier
    try:
        page.goto(f'{BASE}/#/books/{record["bookId"]}/chapters/{record["chapterIds"][0]}')
        page.wait_for_load_state('networkidle');expect(editor()).to_be_visible();open_ai()
        panel().get_by_role('button',name='模型连接设置',exact=True).click()
        dialog=page.get_by_role('dialog',name='模型连接',exact=True)
        dialog.get_by_label('连接名称',exact=True).fill('工程主连接')
        dialog.get_by_role('button',name='保存设置',exact=True).click()
        expect(dialog.get_by_text('模型设置已保存。',exact=True)).to_be_visible()
        primary=dialog.get_by_label('当前模型连接').input_value()
        dialog.get_by_role('button',name='新增连接',exact=True).click()
        dialog.get_by_label('平台预设').select_option('omgt')
        expect(dialog.get_by_label('模型基础地址')).to_have_value('https://api.example.com/v1')
        dialog.get_by_label('连接名称',exact=True).fill('工程备用连接')
        dialog.get_by_label('模型基础地址').fill('http://127.0.0.1:19091/v1')
        dialog.get_by_label('模型名称',exact=True).fill('fixture-alternate')
        dialog.get_by_label('API 密钥',exact=True).fill('QA-LOCAL-FIXTURE-ONLY')
        dialog.get_by_role('button',name='保存设置',exact=True).click()
        expect(dialog.get_by_text('模型设置已保存。',exact=True)).to_be_visible()
        expect(dialog.get_by_label('API 密钥',exact=True)).to_have_value('')
        alternative=dialog.get_by_label('当前模型连接').input_value()
        assert alternative!=primary
        dialog.get_by_role('button',name='读取此平台的模型列表',exact=True).click()
        expect(dialog.get_by_text('已读取 2 个模型，在模型名称中输入可筛选。',exact=True)).to_be_visible()
        dialog.get_by_label('当前模型连接').select_option(primary)
        expect(dialog.get_by_label('连接名称',exact=True)).to_have_value('工程主连接')
        dialog.get_by_label('当前模型连接').select_option(alternative)
        expect(dialog.get_by_text('已保存密钥，留空保留',exact=True)).to_be_visible()
        page.screenshot(path=str(OUT/'multi-platform-settings.png'))
        dialog.get_by_role('button',name='关闭',exact=True).click()
        checks.append('New API preset, two independent profiles, masked keys and model catalog in browser')

        page.get_by_role('button',name='故事策划',exact=True).click()
        dialog=page.get_by_role('dialog',name='故事策划',exact=True)
        hierarchy=[('book','全书工程方向',None),('arc','雾港故事弧','全书工程方向'),('chapter','第一章近期规划','雾港故事弧'),('scene','码头场景','第一章近期规划')]
        plan_ids=[]
        for index,(level,title,parent) in enumerate(hierarchy):
            if index: dialog.get_by_role('button',name='新增剧情规划',exact=True).click()
            dialog.get_by_label('规划层级',exact=True).select_option(level)
            if parent: dialog.get_by_label('上级规划',exact=True).select_option(plan_ids[-1])
            dialog.get_by_label('规划名称',exact=True).fill(title)
            dialog.get_by_label('规划内容',exact=True).fill('这是作者确认的未来意图，尚未发生。')
            with page.expect_response(lambda response:response.url.endswith('/plans') and response.request.method=='POST') as created_plan:
                dialog.get_by_role('button',name='确认规划',exact=True).click()
            assert created_plan.value.ok,created_plan.value.text()
            plan_ids.append(created_plan.value.json()['plan']['id'])
            expect(dialog.get_by_text('已确认这份规划。它会作为未来意图参与相关章节，不会成为已发生事实。',exact=True)).to_be_visible()
        page.screenshot(path=str(OUT/'planning-desk.png'))
        dialog.get_by_role('button',name='关闭窗口',exact=True).click()
        checks.append('optional book, arc, chapter and scene planning saves in its hierarchy')

        open_ai(); draft_id=start('起草','QA:DRAFT:1 自动检查工程验证。')
        expect(panel().get_by_label('采纳起草后自动检查',exact=True)).to_be_checked()
        panel().get_by_role('button',name='采纳为正文',exact=True).click()
        expect(panel().locator('.review-report')).to_be_visible(timeout=15000)
        expect(panel().get_by_text('本次检查未报告问题。仍建议通读当前稿。',exact=True)).to_be_visible()
        adopted=context.request.get(f'{BASE}/api/jobs/{draft_id}').json()['job']
        assert adopted['appliedVersion'] and adopted['candidateText']
        assert all(any(item['id'].startswith(f'plan:{identifier}:') for item in adopted['context']) for identifier in plan_ids)
        checks.append('adopted draft automatically receives a separate review of the exact new version')

        start('策划','QA:PLAN 候选暂存工程验证。')
        field=panel().get_by_role('textbox',name='AI 候选内容',exact=True)
        local=field.input_value()+'\n本机暂存的候选编辑。'
        field.fill(local)
        page.get_by_role('button',name='关闭 AI 共创',exact=True).click();open_ai()
        expect(panel().get_by_role('textbox',name='AI 候选内容',exact=True)).to_have_value(local)
        page.reload();expect(editor()).to_be_visible();open_ai()
        expect(panel().get_by_role('textbox',name='AI 候选内容',exact=True)).to_have_value(local)
        checks.append('edited candidate survives panel close and page refresh in IndexedDB')
        panel().get_by_role('button',name='整理为人物或设定',exact=True).click()
        form=page.get_by_role('dialog',name='新增故事资料',exact=True)
        expect(form.get_by_label('资料内容',exact=True)).to_have_value(local)
        form.get_by_label('资料名称',exact=True).fill('林砚的性格')
        form.get_by_label('资料内容',exact=True).fill('遇事会先核对钟表，表面克制。')
        form.get_by_role('button',name='确认保存',exact=True).click()
        story=page.get_by_role('dialog',name='故事资料',exact=True)
        expect(story.get_by_role('heading',name='林砚的性格',exact=True)).to_be_visible()
        story.get_by_role('button',name='关闭窗口',exact=True).click()
        panel().get_by_text('视角与本次资料',exact=True).click()
        expect(panel().get_by_role('button',name='固定资料：林砚的性格',exact=True)).to_be_visible()
        checks.append('discussion can become an edited, author-confirmed character setting and refresh available context')
        editor().click();editor().press('Control+Home');editor().press('Shift+End')
        page.get_by_role('button',name='请 AI 修改选区',exact=True).click()
        expect(panel().get_by_role('button',name='改稿',exact=True)).to_have_attribute('aria-pressed','true')
        expect(panel().locator('.selected-excerpt p')).not_to_have_text('在正文里选中一段，再告诉我希望怎么改。')
        checks.append('selected prose offers an inline action that opens the correct AI task without losing the range')

        page.get_by_role('button',name='故事资料',exact=True).click()
        dialog=page.get_by_role('dialog',name='故事资料',exact=True)
        dialog.get_by_role('tab',name='原文回查',exact=True).click()
        dialog.get_by_role('textbox',name='搜索已定稿原文',exact=True).fill('钥匙')
        expect(dialog.get_by_role('button',name='打开原文出处',exact=True).first).to_be_visible()
        dialog.get_by_role('button',name='打开原文出处',exact=True).first.click()
        source=page.get_by_role('dialog',name='资料的原文出处',exact=True)
        expect(source.locator('blockquote')).to_contain_text('钥匙')
        source.get_by_role('button',name='关闭窗口',exact=True).click()
        dialog.get_by_role('button',name='关闭窗口',exact=True).click()
        checks.append('two-character Chinese keyword finds final prose and opens immutable source')
        open_ai()
        panel().get_by_role('button',name='检查',exact=True).click()
        panel().get_by_role('textbox',name='创作要求').fill('QA:MALFORMED 验证格式失败和调用原文留存。')
        panel().get_by_role('button',name='开始检查',exact=True).click()
        expect(panel().locator('[data-job-status]')).to_have_attribute('data-job-status','failed',timeout=15000)
        panel().get_by_text('本次依据与用量',exact=True).click()
        expect(panel().locator('.call-record')).to_have_count(2)
        panel().locator('.call-record').first.locator(':scope > summary').click()
        expect(panel().locator('.call-record').first.locator(':scope > pre')).to_contain_text('{not valid JSON')
        checks.append('malformed structured output fails honestly and retains each attempt for inspection')
        assert not errors,errors
        report={'checks':checks,'pageErrors':errors}
        (OUT/'extended-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False))
    except Exception:
        page.screenshot(path=str(OUT/'extended-failure.png'))
        print(json.dumps({'checks':checks,'errors':errors,'alerts':page.get_by_role('alert').all_text_contents()},ensure_ascii=False))
        raise
    finally: browser.close()
