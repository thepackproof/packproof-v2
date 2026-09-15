import datetime,json,urllib.request,urllib.error
base='https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws'
results=[]
for path in ['/meta','/ready','/health','/me/intake/capabilities']:
    req=urllib.request.Request(base+path,headers={'Origin':'https://thepackproof.com'})
    try:
        response=urllib.request.urlopen(req,timeout=20)
    except urllib.error.HTTPError as exc:
        response=exc
    with response:
        body=response.read(8192).decode()
        try: body=json.loads(body)
        except json.JSONDecodeError: body={'nonJsonResponse':True}
        results.append({'path':path,'status':response.status,'allowOrigin':response.headers.get('Access-Control-Allow-Origin'),'body':body})
print(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'base':base,'checks':results},indent=2))
