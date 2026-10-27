import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[2]
out = root / 'test-results'
out.mkdir(exist_ok=True)
base = os.environ.get('NOVEL_TEST_URL', 'http://127.0.0.1:4318')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.goto(base)
    page.wait_for_load_state('networkidle')
    print(json.dumps({'buttons': page.get_by_role('button').all_text_contents()}, ensure_ascii=False))
    page.get_by_role('button', name='模型连接设置', exact=True).click()
    print(json.dumps({'model_fields': page.locator('dialog input').evaluate_all('(nodes) => nodes.map(n=>({label:n.getAttribute("aria-label"),type:n.type,value:n.value}))')}, ensure_ascii=False))
    page.screenshot(path=str(out / 'model-settings-inspect.png'))
    browser.close()
