import json, time, base64
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / 'assets'
OUT.mkdir(parents=True, exist_ok=True)
uid = '11111111-1111-4111-8111-111111111111'
profile = {'id': uid, 'full_name': 'Demo Administrator', 'role': 'administrator', 'school_id': None}
user = {'id': uid, 'aud': 'authenticated', 'role': 'authenticated', 'email': 'demo@example.invalid', 'app_metadata': {}, 'user_metadata': {}, 'created_at': '2026-10-01T00:00:00Z'}
def enc(x): return base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip('=')
token = enc({'alg':'HS256','typ':'JWT'})+'.'+enc({'sub':uid,'exp':int(time.time())+7200,'role':'authenticated'})+'.demonstration'
session = {'access_token':token,'refresh_token':'demonstration-only','token_type':'bearer','expires_in':7200,'expires_at':int(time.time())+7200,'user':user}
titles = [('Introduction to Computing','Sample Author A','Information Technology'),('Database Fundamentals','Sample Author B','Information Technology'),('Academic Writing','Sample Author C','General Education')]
books = []
copies = []
for i,(title,author,category) in enumerate(titles,1):
    bid=f'22222222-2222-4222-8222-{i:012d}'
    book={'id':bid,'title':title,'author':author,'category':category,'isbn':None,'description':'Illustrative catalog record for prototype documentation.','publication_year':2025,'cover_url':None,'created_at':'2026-10-01T00:00:00Z'}
    for j in range(2):
        copies.append({'id':f'33333333-3333-4333-8333-{i*2+j:012d}','book_id':bid,'barcode':f'DEMO-{i:03d}-{j+1}','location':f'Shelf {i}','condition':'Good','status':'available','created_at':'2026-10-01T00:00:00Z','books':book.copy()})
    book['book_copies']=[{k:v for k,v in c.items() if k!='books'} for c in copies if c['book_id']==bid]
    books.append(book)
member={'id':'44444444-4444-4444-8444-444444444444','full_name':'Sample Borrower','library_card_number':'DEMO-CARD-001','school_id':'DEMO-STUDENT-001','member_type':'student','is_active':True,'auth_user_id':None,'created_at':'2026-10-01T00:00:00Z'}
event={'id':'55555555-5555-4555-8555-555555555555','created_at':'2026-10-05T01:00:00Z','action':'return','entity_type':'loan','entity_id':'DEMO-LOAN-001','member_name':member['full_name'],'school_id':member['school_id'],'library_card_number':member['library_card_number'],'title':titles[0][0],'barcode':'DEMO-001-1','actor_name':'Demo Librarian','details':{'note':'Illustrative completed return; not an actual library transaction'}}
policy={'loan_period_days':3,'max_active_loans':5,'due_soon_days':3,'max_renewals':1,'pickup_hold_days':3,'fine_per_day':0,'notifications_enabled':True}
requests=[]
def route(r):
    req=r.request
    url=urlparse(req.url)
    if url.hostname in ('127.0.0.1','localhost'):
        r.continue_(); return
    if url.hostname != 'paper-demo.invalid':
        r.abort(); return
    requests.append(url.path)
    data=[]
    name=url.path.split('/')[-1]
    if '/auth/' in url.path: data=session if name=='token' else user
    elif '/rpc/' in url.path:
        if name=='get_circulation_policy': data=policy
        elif name=='library_analytics': data={'daily':[],'categories':[{'label':'Information Technology','count':2},{'label':'General Education','count':1}]}
        elif name=='transaction_history': data={'items':[event],'total':1}
        else: data=None
    elif name=='profiles': data=profile if 'object' in req.headers.get('accept','') else [profile]
    elif name=='books': data=books
    elif name=='book_copies': data=copies
    elif name=='library_members': data=[member]
    elif name=='circulation_job_health': data={'last_scheduled_success_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
    total=len(data) if isinstance(data,list) else 1
    if isinstance(data,list):
        query=parse_qs(url.query)
        start=int(query.get('offset',['0'])[0])
        count=int(query.get('limit',['200'])[0])
        if req.headers.get('range'): start=int(req.headers['range'].split('-')[0])
        data=data[start:start+count]
    headers={'access-control-allow-origin':'*','access-control-expose-headers':'content-range','content-type':'application/json','content-range':f'0-{max(0,total-1)}/{total}'}
    r.fulfill(status=200,headers=headers,body='' if req.method=='HEAD' else json.dumps(data))

with sync_playwright() as p:
    browser=p.chromium.launch(channel='msedge',headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000},device_scale_factor=1,timezone_id='Asia/Manila')
    context.route('**/*',route)
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:5189',wait_until='networkidle')
    page.get_by_role('heading',name='Staff sign in').wait_for()
    page.screenshot(path=str(OUT/'login.png'),full_page=True)
    page.get_by_role('button',name='Browse catalog without an account').click()
    page.wait_for_timeout(700)
    page.screenshot(path=str(OUT/'public_catalog.png'),full_page=True)
    page.get_by_role('button',name='Staff sign in',exact=True).click()
    page.locator('#auth-identifier').fill('demo@example.invalid')
    page.locator('#auth-password').fill('IllustrativePasswordOnly')
    page.get_by_role('button',name='Sign in',exact=True).click()
    page.get_by_role('heading',name='Library Analytics',exact=True).wait_for()
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT/'dashboard.png'),full_page=True)
    for label,filename in [('Borrow / Return','circulation'),('Reports','reports'),('Transactions','transactions'),('Members','members'),('Reservations','reservations'),('Book Requests','requests'),('Stock Audit','stock_audit')]:
        page.locator('.staff-sidebar').get_by_role('button',name=label,exact=True).click()
        page.wait_for_timeout(750)
        page.screenshot(path=str(OUT/(filename+'.png')),full_page=True)
    (OUT/'capture_log.json').write_text(json.dumps({'method':'Actual local React UI with browser-intercepted synthetic API responses. No live backend accessed.','requests':sorted(set(requests)),'browser_errors':errors},indent=2))
    print(json.dumps({'screenshots':len(list(OUT.glob('*.png'))),'errors':errors}))
    browser.close()
