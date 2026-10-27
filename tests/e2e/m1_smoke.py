"""Real browser acceptance against an isolated running M1 workspace.

Run the server with NOVEL_DATA_DIR pointing at test data, never a personal workspace.
Set PLAYWRIGHT_CHROMIUM_EXECUTABLE when using an existing Chromium installation.
"""
import json
import os
import re
from pathlib import Path
from time import monotonic, sleep

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "test-results"
OUTPUT.mkdir(exist_ok=True)
BASE = os.environ.get("NOVEL_TEST_URL", "http://127.0.0.1:5173")
FIRST = "雨落在雾港的石阶上。\n林砚拆开信封，邮戳上的日期却是明天。"
SECOND = "她把铜钥匙交给陈舟，自己留在码头等船。"
THIRD = "天亮以后，城里的钟少响了一声。"


with sync_playwright() as playwright:
    executable = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE")
    browser = playwright.chromium.launch(headless=True, **({"executable_path": executable} if executable else {}))
    context = browser.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
    page = context.new_page()
    errors = []
    checks = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def current_chapter():
        chapter_id = page.url.rsplit("/", 1)[-1]
        response = context.request.get(f"{BASE}/api/chapters/{chapter_id}")
        assert response.ok, response.text()
        return response.json()["chapter"]

    def wait_text(text):
        deadline = monotonic() + 12
        while monotonic() < deadline:
            chapter = current_chapter()
            if text in chapter["plainText"]:
                return chapter
            page.wait_for_timeout(100)
        raise AssertionError(f"Expected saved chapter text: {text}")

    def editor():
        return page.get_by_role("textbox", name="章节正文", exact=True)

    def save_text(text):
        editor().fill(text)
        editor().press("Control+s")
        wait_text(text.splitlines()[-1])
        expect(page.get_by_text("已保存到本地", exact=True)).to_be_visible()

    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name="新建作品", exact=True).click()
    dialog = page.get_by_role("dialog")
    dialog.get_by_label(re.compile("作品名称")).fill("雾港来信 · 完整验收")
    dialog.get_by_label("题材", exact=True).fill("悬疑")
    dialog.get_by_label(re.compile("故事的种子")).fill("失踪多年的父亲寄来一封信，邮戳却是明天。")
    dialog.get_by_role("button", name="开始写作", exact=True).click()
    expect(editor()).to_be_visible()
    expect(page.get_by_text("发现一份未完成保存的本机稿", exact=True)).to_have_count(0)
    checks.append("new book has no spurious emergency recovery")

    page.get_by_role("textbox", name="章节名称", exact=True).fill("雨夜的信")
    page.get_by_role("textbox", name="本章意图", exact=True).fill("建立雾港与来信的悬念，保留邮戳日期。")
    save_text(FIRST)
    first_url = page.url
    original_book_id = page.url.split("/books/", 1)[1].split("/", 1)[0]
    page.reload()
    expect(editor()).to_contain_text("邮戳上的日期却是明天")
    expect(page.get_by_role("textbox", name="章节名称", exact=True)).to_have_value("雨夜的信")
    expect(page.get_by_role("textbox", name="本章意图", exact=True)).to_have_value("建立雾港与来信的悬念，保留邮戳日期。")
    checks.append("draft, title, outline survive refresh")

    editor().dispatch_event("compositionstart", {"data": "输入中"})
    editor().fill(FIRST + "\n输入法组合中的文字。")
    page.wait_for_timeout(1100)
    assert "输入法组合中的文字" not in current_chapter()["plainText"]
    editor().dispatch_event("compositionend", {"data": "输入中"})
    wait_text("输入法组合中的文字")
    save_text(FIRST)
    checks.append("composition events defer autosave until input is complete")

    page.get_by_role("button", name="版本", exact=True).click()
    history = page.get_by_role("dialog", name="章节版本历史")
    history.get_by_placeholder("例如：调整了开场对白").fill("保留开场")
    history.get_by_role("button", name="保存当前版本", exact=True).click()
    expect(history.get_by_role("heading", name="保留开场", exact=True)).to_be_visible()
    history.get_by_role("button", name="关闭版本历史", exact=True).click()
    save_text("这一稿准备重写开场。")
    page.get_by_role("button", name="版本", exact=True).click()
    history.get_by_role("button").filter(has_text="保留开场").click()
    expect(history.get_by_text(re.compile("林砚拆开信封"))).to_be_visible()
    history.get_by_role("button", name="恢复到编辑器", exact=True).click()
    history.get_by_role("button", name="确认恢复这一稿", exact=True).click()
    expect(history).not_to_be_visible()
    expect(editor()).to_contain_text("邮戳上的日期却是明天")
    chapter = wait_text("林砚拆开信封")
    versions = context.request.get(f"{BASE}/api/chapters/{chapter['id']}/versions").json()["versions"]
    assert any(version["kind"] == "before_restore" for version in versions)
    checks.append("checkpoint preview and restore preserve previous draft")

    page.get_by_role("button", name="定稿", exact=True).click()
    expect(page.get_by_text("已定稿", exact=True)).to_be_visible()
    checks.append("manual finalize succeeds")

    # Delay a save ACK while the author keeps typing: the late response must not overwrite new text.
    page.evaluate("""() => {
      const original = window.fetch.bind(window);
      let delay = true;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (delay && String(args[0]).endsWith('/draft')) {
          delay = false;
          await new Promise(resolve => setTimeout(resolve, 900));
        }
        return response;
      };
    }""")
    editor().fill(FIRST + "\n第一封信还没有读完。")
    editor().press("Control+s")
    wait_text("第一封信还没有读完")
    editor().fill(FIRST + "\n第二封信已经到了。")
    wait_text("第二封信已经到了")
    expect(editor()).to_contain_text("第二封信已经到了")
    expect(editor()).not_to_contain_text("第一封信还没有读完")
    checks.append("late save ACK never overwrites newer editor content")

    editor().fill(FIRST + "\n她决定去码头。")
    page.get_by_role("button", name="写下一章", exact=True).click()
    expect(page.get_by_role("textbox", name="章节名称", exact=True)).to_have_value(re.compile(r"第[二2]章"))
    save_text(SECOND)
    page.get_by_role("button", name="写下一章", exact=True).click()
    expect(page.get_by_role("textbox", name="章节名称", exact=True)).to_have_value(re.compile(r"第[三3]章"))
    save_text(THIRD)
    page.get_by_role("navigation", name="章节目录").get_by_role("button").filter(has_text="雨夜的信").click()
    expect(editor()).to_contain_text("她决定去码头")
    checks.append("three chapters and immediate navigation flush retain text")
    page.screenshot(path=str(OUTPUT / "editor-desktop.png"), full_page=True)

    page.get_by_role("button", name="导出", exact=True).click()
    with page.expect_download() as download:
        page.get_by_role("button", name="纯文本 .txt", exact=True).click()
    exported = OUTPUT / "manuscript-export.txt"
    download.value.save_as(exported)
    text = exported.read_text(encoding="utf-8-sig")
    assert "她决定去码头" in text and SECOND in text and THIRD in text
    checks.append("TXT download contains all three chapters")

    # An actual offline save, followed by reload, must offer the previous session's local draft.
    context.set_offline(True)
    editor().fill("断网时写下的这一句，必须能找回来。")
    editor().press("Control+s")
    expect(page.get_by_text("尚未保存", exact=True)).to_be_visible(timeout=10000)
    context.set_offline(False)
    page.reload()
    expect(page.get_by_text("发现一份未完成保存的本机稿", exact=True)).to_be_visible()
    page.get_by_role("button", name="恢复本机稿", exact=True).click()
    expect(editor()).to_contain_text("断网时写下的这一句")
    editor().press("Control+s")
    wait_text("断网时写下的这一句")
    checks.append("offline emergency draft survives reload and can be recovered")

    # A separate client changes the saved version, forcing an honest conflict in this editor.
    chapter = current_chapter()
    changed = context.request.put(f"{BASE}/api/chapters/{chapter['id']}/draft", data={
        "expectedVersion": chapter["version"], "title": chapter["title"], "outline": chapter["outline"],
        "document": {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "另一窗口保存的新稿。"}]}]},
    })
    assert changed.ok
    editor().fill("本窗口的冲突草稿。")
    editor().press("Control+s")
    expect(page.get_by_text("版本需要处理", exact=True)).to_be_visible()
    assert current_chapter()["plainText"] == "另一窗口保存的新稿。"
    page.get_by_role("button", name="查看服务器稿", exact=True).click()
    conflict = page.get_by_role("dialog", name="两份稿件，都先留下")
    expect(conflict.get_by_text("本窗口的冲突草稿。", exact=True)).to_be_visible()
    with page.expect_download() as local_copy:
        conflict.get_by_role("button", name="导出本机稿并载入服务器稿", exact=True).click()
    local_copy.value.save_as(OUTPUT / "conflict-local.txt")
    expect(editor()).to_contain_text("另一窗口保存的新稿")
    assert "本窗口的冲突草稿" in (OUTPUT / "conflict-local.txt").read_text(encoding="utf-8-sig")
    checks.append("conflict preserves server data and exports local draft before reload")

    page.get_by_role("button", name="返回书架", exact=True).click()
    expect(page.get_by_role("heading", name=re.compile("我的作品"))).to_be_visible()
    with page.expect_download() as backup_download:
        page.get_by_role("button", name="备份作品", exact=True).click()
    backup_path = OUTPUT / "workspace-backup.json"
    backup_download.value.save_as(backup_path)
    backup = json.loads(backup_path.read_text(encoding="utf-8-sig"))
    assert backup["format"] == "shujian-backup"
    page.get_by_label("选择备份文件", exact=True).set_input_files(backup_path)
    recovery = page.get_by_role("dialog", name="恢复作品备份")
    recovery.get_by_role("button", name="确认恢复", exact=True).click()
    expect(recovery).not_to_be_visible()
    expect(page.get_by_text(re.compile("已恢复 .* 部作品"))).to_be_visible()
    books = context.request.get(f"{BASE}/api/books").json()["books"]
    assert len(books) >= 2 and any(book["id"] != original_book_id and book["title"] == "雾港来信 · 完整验收" for book in books)
    checks.append("backup download and restore create independent books")

    page.get_by_label("选择导入手稿", exact=True).set_input_files({
        "name": "旧城来信.txt", "mimeType": "text/plain",
        "buffer": "第一章 旧城\n她回到了旧城。\n\n第二章 来信\n门口多了一封信。".encode("utf-8"),
    })
    expect(editor()).to_contain_text("她回到了旧城")
    assert len(context.request.get(f"{BASE}/api/books/{current_chapter()['bookId']}/chapters").json()["chapters"]) == 2
    checks.append("TXT import splits chapter headings without losing prose")

    page.set_viewport_size({"width": 390, "height": 844})
    expect(page.get_by_role("button", name="关闭本章计划", exact=True)).not_to_be_visible()
    assert editor().bounding_box()["width"] >= 300, "Mobile prose should retain a usable width"
    page.get_by_role("button", name="打开章节目录", exact=True).click()
    page.get_by_role("navigation", name="移动端章节目录").get_by_role("button").filter(has_text="来信").click()
    expect(editor()).to_contain_text("门口多了一封信")
    page.get_by_role("button", name="展开本章计划", exact=True).click()
    expect(page.get_by_role("button", name="关闭本章计划", exact=True)).to_be_visible()
    page.get_by_role("button", name="关闭本章计划", exact=True).click()
    expect(editor()).to_be_visible()
    checks.append("mobile chapter navigation and plan open/close remain usable")
    page.screenshot(path=str(OUTPUT / "editor-mobile.png"), full_page=True)
    mobile_buttons = page.get_by_role("button").all_text_contents()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "Mobile horizontal overflow"
    checks.append("mobile editor has no horizontal overflow")
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.get_by_role("button", name="返回书架", exact=True).click()
    page.screenshot(path=str(OUTPUT / "library-populated.png"), full_page=True)
    assert not errors, errors
    report = {"checks": checks, "count": len(checks), "page_errors": errors, "first_chapter_url": first_url, "mobile_buttons": mobile_buttons}
    (OUTPUT / "m1-browser-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    browser.close()
