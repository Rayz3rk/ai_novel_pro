"""Smoke check only. The generated scores are not author ratings."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]
TARGET=ROOT/'data/trials/comparison-2026-10-26/blind/review.html'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    page=browser.new_page(viewport={'width':1440,'height':1100},accept_downloads=True)
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    page.goto(TARGET.as_uri());page.wait_for_load_state('load')
    body=page.locator('body').inner_text()
    assert '工作台原始候选' not in body and '普通聊天提示对照' not in body
    assert page.locator('article').count()==2
    page.screenshot(path=str(TARGET.parent/'review-desktop.png'),full_page=True)
    for side in ['A','B']:
        for metric in range(5):page.locator(f'input[name="{side}-{metric}"][value="3"]').check()
    page.locator('select[name="preference"]').select_option(label='各有所长')
    page.locator('textarea[name="notes"]').fill('自动化冒烟测试，不是作者评价。')
    with page.expect_download() as event:page.get_by_role('button',name='导出匿名评分',exact=True).click()
    file=ROOT/'test-results/blind-review-smoke-scores.json';event.value.save_as(str(file))
    saved=json.loads(file.read_text(encoding='utf-8'))
    assert saved['ratings']['A']['可读性']==3 and saved['ratings']['B']['省改稿程度']==3
    assert saved['notes']=='自动化冒烟测试，不是作者评价。'
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
    assert not errors,errors
    print(json.dumps({'checks':['two anonymous samples','source identities absent from review page','rating export','mobile viewport'],'pageErrors':errors},ensure_ascii=False))
    browser.close()
