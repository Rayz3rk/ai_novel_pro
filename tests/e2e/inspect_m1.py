"""Inspect the rendered app before selecting controls for browser verification."""
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

output = Path(__file__).resolve().parents[2] / "test-results"
output.mkdir(exist_ok=True)
with sync_playwright() as playwright:
    executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
    browser = playwright.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}))
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(os.environ.get("NOVEL_TEST_URL", "http://127.0.0.1:5173"))
    page.wait_for_load_state("networkidle")
    page.screenshot(path=str(output / "library-empty.png"), full_page=True)
    print(json.dumps({"title": page.title(), "buttons": page.get_by_role("button").all_text_contents(), "text": page.locator("body").inner_text()[:2400], "errors": errors}, ensure_ascii=False))
    browser.close()
