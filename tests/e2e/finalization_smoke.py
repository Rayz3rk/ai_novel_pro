import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright,expect

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'test-results'
BASE=os.environ.get('NOVEL_TEST_URL','http://127.0.0.1:4319')
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    context=browser.new_context(viewport={'width':1440,'height':1000})
    page=context.new_page();checks=[];errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    settings=context.request.get(f'{BASE}/api/model').json()['settings']
    assert settings['baseUrl']=='http://127.0.0.1:19091/v1','This script requires the isolated local fixture.'
    def panel():return page.get_by_role('region',name='AI 创作助手',exact=True)
    def editor():return page.get_by_role('textbox',name='章节正文',exact=True)
    def save(text):editor().fill(text);editor().press('Control+s');expect(page.get_by_text('已保存到本地',exact=True)).to_be_visible()
    try:
        page.goto(BASE);page.wait_for_load_state('networkidle')
        page.get_by_role('button',name='新建作品',exact=True).click()
        page.get_by_role('dialog').get_by_label(re.compile('作品名称')).fill('定稿事务 · 工程样本')
        page.get_by_role('dialog').get_by_role('button',name='开始写作',exact=True).click()
        expect(editor()).to_be_visible();save('林砚把铜钥匙交给陈舟，自己留在码头等船。')
        book_id=page.url.split('/books/',1)[1].split('/')[0]
        chapter_id=page.url.rsplit('/',1)[-1]
        page.get_by_role('button',name='AI 共创',exact=True).click()
        panel().get_by_role('button',name='整理资料',exact=True).click()
        panel().get_by_label('资料提取来源',exact=True).select_option('draft')
        panel().get_by_role('button',name='开始整理资料',exact=True).click()
        expect(panel().locator('[data-job-status]')).to_have_attribute('data-job-status','succeeded',timeout=15000)
        assert context.request.get(f'{BASE}/api/books/{book_id}/story').json()['entries']==[]
        panel().get_by_role('button',name='查看待确认资料',exact=True).click()
        story=page.get_by_role('dialog',name='故事资料',exact=True)
        story.get_by_role('tab',name=re.compile('待确认')).click()
        expect(story.get_by_role('button',name='确认采纳',exact=True)).to_be_disabled()
        story.get_by_role('button',name='关闭窗口',exact=True).click()
        checks.append('draft evidence remains a candidate and cannot enter canon before finalization')
        page.get_by_role('button',name='定稿',exact=True).click()
        dialog=page.get_by_role('dialog',name='为这一章定稿',exact=True)
        dialog.get_by_role('checkbox',name='随定稿确认：本章发生的事',exact=True).check()
        page.screenshot(path=str(OUT/'finalization-dialog.png'))
        dialog.get_by_role('button',name='确认定稿',exact=True).click()
        expect(page.get_by_text('这一章已定稿。继续书写时，会保留这一稿。',exact=True)).to_be_visible()
        chapter=context.request.get(f'{BASE}/api/chapters/{chapter_id}').json()['chapter']
        entries=context.request.get(f'{BASE}/api/books/{book_id}/story').json()['entries']
        assert len(entries)==1 and entries[0]['evidence'][0]['revisionId']==chapter['finalizedRevisionId']
        checks.append('one browser confirmation commits the official revision and selected facts together')
        changed={**settings,'baseUrl':'http://127.0.0.1:9/v1'}
        assert context.request.put(f'{BASE}/api/model',data=changed).ok
        save('林砚把铜钥匙留在自己手里。')
        page.get_by_role('button',name='定稿',exact=True).click()
        dialog=page.get_by_role('dialog',name='为这一章定稿',exact=True)
        dialog.get_by_role('button',name='检查当前稿',exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('正在检查正文')
        expect(dialog.get_by_role('button',name='确认定稿',exact=True)).to_be_enabled()
        dialog.get_by_role('button',name='确认定稿',exact=True).click()
        expect(page.get_by_text('这一章已定稿。继续书写时，会保留这一稿。',exact=True)).to_be_visible()
        chapter=context.request.get(f'{BASE}/api/chapters/{chapter_id}').json()['chapter']
        assert chapter['status']=='final' and chapter['plainText']=='林砚把铜钥匙留在自己手里。'
        checks.append('unavailable model does not block explicit author finalization or lose saved prose')
        assert not errors,errors
        report={'checks':checks,'pageErrors':errors}
        (OUT/'finalization-browser-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False))
    except Exception:
        page.screenshot(path=str(OUT/'finalization-failure.png'))
        print(json.dumps({'checks':checks,'errors':errors,'alerts':page.get_by_role('alert').all_text_contents()},ensure_ascii=False));raise
    finally:
        context.request.put(f'{BASE}/api/model',data=settings)
        browser.close()
