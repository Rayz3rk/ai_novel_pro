"""Generate public README screenshots from fictional, isolated demo data."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE=os.environ['NOVEL_TEST_URL']
OUTPUT=Path(__file__).resolve().parents[2]/'docs/screenshots'
OUTPUT.mkdir(parents=True,exist_ok=True)
TEXT='''雾从海面漫上来时，林砚刚走到旧码头。

最后一班渡船已经离岸，栈桥上的灯却还亮着。有人把一封信压在灯下，信封没有落款，只有一枚沾着盐霜的邮戳。

日期是明天。

她站了片刻，伸手去取那封信。纸张是干的，边角微微卷起，仿佛有人已经在这里等了很久。

“你来晚了。”

陈舟从值班室里走出来。他没看那封信，只把目光落在她握紧的右手上。

林砚摊开手心。那把铜钥匙比记忆中更沉，齿口新添了一道划痕。

“门后的东西，还在吗？”她问。

陈舟没有回答。远处的雾里传来一声汽笛，低而漫长，像一封终于找到了收件人的信。'''

with sync_playwright() as p:
    executable=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE')
    browser=p.chromium.launch(headless=True,**({'executable_path':executable} if executable else {}))
    context=browser.new_context(viewport={'width':1440,'height':1000},device_scale_factor=1)
    api=context.request
    assert api.get(f'{BASE}/api/books').json()['books']==[], 'Use scripts/run-ui-tests.py with a fresh workspace.'
    def post(path,data):
        response=api.post(BASE+'/api'+path,data=data)
        assert response.ok,response.text()
        return response.json()
    book=post('/books',{'title':'雾港来信','genre':'悬疑 · 都市','premise':'一封寄自明天的信，把离乡多年的林砚带回雾港。她必须在最后一班渡船离开前，找到寄信的人。','accent':'#31584d','targetWords':120000})['book']
    for title,genre,premise,accent in [('山海无名','奇幻 · 冒险','少年沿着一张没有终点的地图，寻找被人遗忘的山海。','#5b6581'),('长街灯未眠','都市 · 成长','一间深夜书店，收留城市里那些尚未说完的故事。','#b26747')]:
        post('/books',{'title':title,'genre':genre,'premise':premise,'accent':accent,'targetWords':180000})
    post(f'/books/{book["id"]}/chapters',{'title':'第二章 · 明日邮戳'})
    chapter=api.get(f'{BASE}/api/books/{book["id"]}/chapters').json()['chapters'][0]
    response=api.put(f'{BASE}/api/chapters/{chapter["id"]}/draft',data={'expectedVersion':1,'title':'第一章 · 雾中的来信','outline':'林砚回到旧码头，发现一封日期为明天的信。\n\n用铜钥匙引出她与陈舟共同保守的秘密。\n\n结尾留下疑问：信究竟是谁寄来的？','document':{'type':'doc','content':[{'type':'paragraph','content':[{'type':'text','text':line}]} for line in TEXT.split('\n\n')]}})
    assert response.ok,response.text()
    nodes=[]
    for kind,title,content in [('character','林砚','离乡多年后重回雾港。谨慎、敏锐，一直保留着父亲留下的铜钥匙。'),('character','陈舟','旧码头值班人，熟悉渡船的每一条航线，也知道林家旧事。'),('item','铜钥匙','林父留下的旧物，齿口多了一道新划痕。通往灯塔下的旧仓库。'),('location','旧码头','雾港最早的渡口，夜里只剩一间值班室亮着灯。')]:
        nodes.append(post(f'/books/{book["id"]}/story',{'kind':kind,'title':title,'content':content,'authority':'setting','status':'confirmed'})['entry']['id'])
    for a,b,label in [(0,1,'旧识'),(0,2,'持有'),(1,3,'值守'),(2,3,'通往旧仓库')]:
        post(f'/books/{book["id"]}/atlas/relations',{'fromId':nodes[a],'toId':nodes[b],'label':label,'description':'演示设定','symmetric':False,'phase':'confirmed'})
    response=api.put(f'{BASE}/api/books/{book["id"]}/atlas/view',data={'expectedVersion':0,'positions':{nodes[0]:{'x':.2,'y':.2},nodes[1]:{'x':.65,'y':.2},nodes[2]:{'x':.2,'y':.65},nodes[3]:{'x':.65,'y':.65}},'selectedNodeIds':[],'branch':'主线'})
    assert response.ok,response.text()
    page=context.new_page();page.goto(BASE);page.wait_for_load_state('networkidle')
    page.screenshot(path=str(OUTPUT/'library.png'))
    page.get_by_role('button',name='继续写作：雾港来信',exact=True).click()
    expect(page.get_by_role('textbox',name='章节正文',exact=True)).to_be_visible()
    page.wait_for_load_state('networkidle');page.screenshot(path=str(OUTPUT/'editor.png'))
    page.get_by_role('button',name='设定与图谱',exact=True).click()
    page.get_by_role('tab',name='关系图谱',exact=True).click()
    expect(page.get_by_role('dialog',name='小说设定与关系图',exact=True)).to_be_visible()
    page.wait_for_load_state('networkidle');page.screenshot(path=str(OUTPUT/'atlas.png'))
    browser.close()
    print('Generated three README screenshots using fictional demo data.')
