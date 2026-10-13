"""Create/verify an exact Git-blob archive; never include local untracked or converted bytes."""
import hashlib,json,subprocess,sys,zipfile
from pathlib import Path
def archive(source,destination,profile,verify=False):
    import re
    if not re.fullmatch('[a-f0-9]{40}',source) or profile not in ('bridge','capture-receipts-v1'):
        raise ValueError('INVALID_SOURCE_PROFILE')
    paths=['backend'] if profile=='bridge' else ['backend','packages/evidence-contracts','config/rnd/research-build.json','.dockerignore']
    tree=subprocess.check_output(['git','ls-tree','-rz',source,'--',*paths])
    entries=[]
    for record in tree.split(b'\0'):
        if not record:continue
        meta,name=record.split(b'\t',1);mode,kind,oid=meta.decode().split()
        if kind!='blob' or mode not in ('100644','100755'):raise ValueError('UNSUPPORTED_BLOB')
        n=name.decode();entries.append((n[8:] if profile=='bridge' else n,oid,mode))
    payload=subprocess.check_output(['git','cat-file','--batch'],input=('\n'.join(oid for _,oid,_ in entries)+'\n').encode())
    offset=0;inventory=[]
    with zipfile.ZipFile(destination,'r' if verify else 'x',compression=zipfile.ZIP_DEFLATED) as z:
        if verify:
            names=[e.filename for e in z.infolist()]
            if len(names)!=len(set(names)) or set(names)!={e[0] for e in entries}:raise ValueError('FILE_SET_MISMATCH')
        for name,oid,mode in entries:
            end=payload.index(b'\n',offset);actual,kind,size=payload[offset:end].decode().split();offset=end+1
            if actual!=oid or kind!='blob':raise ValueError('BLOB_ID_MISMATCH')
            raw=payload[offset:offset+int(size)];offset+=int(size)
            if payload[offset:offset+1]!=b'\n':raise ValueError('BLOB_FRAMING_MISMATCH')
            offset+=1
            if verify:
                if z.read(name)!=raw:raise ValueError('ARCHIVE_BLOB_MISMATCH')
            else:
                info=zipfile.ZipInfo(name);info.external_attr=(int(mode,8)<<16);info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,raw)
            if (name.startswith('migrations/') or name.startswith('backend/migrations/')) and name.endswith('.sql'):
                inventory.append({'id':name.rsplit('/',1)[1][:-4],'checksum':hashlib.sha256(raw).hexdigest()})
    if offset!=len(payload):raise ValueError('BLOB_TRAILING_BYTES')
    inventory.sort(key=lambda r:r['id'])
    return {'sourceSha':source,'archiveSha256':hashlib.sha256(Path(destination).read_bytes()).hexdigest(),'gitFilesVerified':len(entries),'migrationCount':len(inventory),'migrationInventorySha256':hashlib.sha256(json.dumps(inventory,separators=(',',':')).encode()).hexdigest(),'allGitBlobBytesVerified':True}
if __name__=='__main__':
    try: print(json.dumps(archive(*sys.argv[1:4],verify='--verify' in sys.argv[4:])))
    except Exception as e:
        print(str(e) if isinstance(e,ValueError) else 'ARCHIVE_OPERATION_FAILED',file=sys.stderr);sys.exit(1)
