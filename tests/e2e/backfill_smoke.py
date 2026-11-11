import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE=os.environ['NOVEL_TEST_URL']
class Provider(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length','0')))
        evidence=[{'paragraphId':'p1','quote':'林砚把钥匙交给陈舟。'}]
        output={'entries':[{'key':'a','kind':'character','title':'林砚','content':'交出钥匙','evidence':evidence},{'key':'b','kind':'character','title':'陈舟','content':'收到钥匙','evidence':evidence}], 'relations':[{'fromKey':'a','toKey':'b','label':'交付','description':'钥匙交付','symmetric':False,'evidence':evidence}], 'states':[{'nodeKey':'b','summary':'持有钥匙','changes':{'status':'持有钥匙'},'evidence':evidence}]}
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
        self.wfile.write(json.dumps({'choices':[{'message':{'content':json.dumps(output,ensure_ascii=False)}}],'usage':{'prompt_tokens':100,'completion_tokens':100}}).encode())

provider=ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=provider.serve_forever,daemon=True).start()
try:
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE'))
        context=browser.new_context(viewport={'width':1440,'height':1000});page=context.new_page();errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        api=context.request
        assert api.get(f'{BASE}/api/books').json()['books']==[]
        response=api.put(f'{BASE}/api/model',data={'baseUrl':f'http://127.0.0.1:{provider.server_port}/v1','model':'fixture','stream':False,'temperature':.7,'maxOutputTokens':2048,'contextWindow':32768,'inputPricePerMillion':1,'outputPricePerMillion':1,'taskBudget':None,'dailyBudget':None});assert response.ok,response.text()
        book=api.post(f'{BASE}/api/books',data={'title':'回填验收'}).json()['book']
        chapters=api.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters']
        chapters.append(api.post(f'{BASE}/api/books/{book["id"]}/chapters',data={'title':'第二章'}).json()['chapter'])
        for chapter in chapters:
            saved=api.put(f'{BASE}/api/chapters/{chapter["id"]}/draft',data={'expectedVersion':1,'title':chapter['title'],'outline':'','document':{'type':'doc','content':[{'type':'paragraph','attrs':{'uid':'p1'},'content':[{'type':'text','text':'林砚把钥匙交给陈舟。'}]}]}}).json()['chapter']
            assert api.post(f'{BASE}/api/chapters/{chapter["id"]}/finalize',data={'expectedVersion':saved['version']}).ok
        page.goto(f'{BASE}/#/books/{book["id"]}/chapters/{chapters[0]["id"]}')
        page.get_by_role('button',name='正文回填',exact=True).click()
        dialog=page.get_by_role('dialog',name='从正文回填知识与图谱',exact=True)
        dialog.get_by_role('button',name='预览分析材料与费用',exact=True).click()
        dialog.get_by_role('button',name='确认调用模型，按章顺序分析',exact=True).click()
        expect(dialog.get_by_text('分析完成。请逐章查看差异并确认回填。',exact=True)).to_be_visible(timeout=20000)
        assert len(api.get(f'{BASE}/api/books/{book["id"]}/atlas').json()['nodes'])==0
        dialog.get_by_role('button',name='查看回填差异',exact=True).last.click()
        expect(dialog.get_by_role('combobox',name='匹配林砚',exact=True)).to_be_visible()
        output=Path('test-results/backfill-ui');output.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(output/'preview.png'),full_page=True)
        dialog.get_by_role('button',name='确认将以上候选回填知识与图谱',exact=True).click()
        expect(dialog.get_by_role('button',name='此任务已回填',exact=True)).to_be_disabled()
        dialog.get_by_role('button',name='查看回填差异',exact=True).first.click()
        assert dialog.get_by_role('combobox',name='匹配林砚',exact=True).input_value()!='__new'
        dialog.get_by_role('button',name='确认将以上候选回填知识与图谱',exact=True).click()
        expect(dialog.get_by_text('知识、关系和状态已一并回填，原文未改动。',exact=True)).to_be_visible()
        graph=api.get(f'{BASE}/api/books/{book["id"]}/atlas').json()
        assert len(graph['nodes'])==2 and len(graph['relations'])==2 and len(graph['states'])==2
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(output/'mobile.png'),full_page=True)
        assert not errors,errors
        browser.close();print('Backfill UI passed: sequential batch, evidence preview, explicit apply, entity matching, mobile.')
finally:
    provider.shutdown();provider.server_close()
