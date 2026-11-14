"""Create/verify an exact Git-blob archive; never include local untracked or converted bytes."""
import hashlib,json,subprocess,sys,zipfile
from pathlib import Path
def archive(source,destination,profile,verify=False):
    import re
    if not re.fullmatch('[a-f0-9]{40}',source) or profile not in ('bridge','capture-receipts-v1','records-v1','connect-v1','zero-touch-v1','reconstruction-v1','reconstruction-v2','reconstruction-v3','reconstruction-v4'):
        raise ValueError('INVALID_SOURCE_PROFILE')
    if subprocess.check_output(['git','cat-file','-t',source]).decode().strip()!='commit':
        raise ValueError('INVALID_SOURCE_COMMIT')
    paths=['backend'] if profile=='bridge' else ['backend','packages/evidence-contracts','config/rnd/research-build.json','.dockerignore']
    probes=['infra/backend-release/record-agent-database-preflight.mjs','infra/backend-release/record-agent-previous-image-probe.mjs']
    if profile=='reconstruction-v1':probes+=['infra/backend-release/reconstruction-release-review.mjs','infra/backend-release/reconstruction-runtime-preflight.mjs']
    if profile=='reconstruction-v2':probes+=['infra/backend-release/reconstruction-release-review.mjs','infra/backend-release/reconstruction-runtime-preflight.mjs','infra/backend-release/reconstruction-v2-release-review.mjs','infra/backend-release/reconstruction-v2-runtime-preflight.mjs']
    if profile=='reconstruction-v3':probes+=['infra/backend-release/reconstruction-release-review.mjs','infra/backend-release/reconstruction-runtime-preflight.mjs','infra/backend-release/reconstruction-v2-release-review.mjs','infra/backend-release/reconstruction-v2-runtime-preflight.mjs','infra/backend-release/reconstruction-v3-release-review.mjs','infra/backend-release/reconstruction-v3-runtime-preflight.mjs']
    if profile=='reconstruction-v4':probes+=['infra/backend-release/reconstruction-release-review.mjs','infra/backend-release/reconstruction-runtime-preflight.mjs','infra/backend-release/reconstruction-v2-release-review.mjs','infra/backend-release/reconstruction-v2-runtime-preflight.mjs','infra/backend-release/reconstruction-v3-release-review.mjs','infra/backend-release/reconstruction-v3-runtime-preflight.mjs','infra/backend-release/reconstruction-v4-release-review.mjs','infra/backend-release/reconstruction-v4-runtime-preflight.mjs']
    if profile in ('connect-v1','zero-touch-v1','reconstruction-v1','reconstruction-v2','reconstruction-v3','reconstruction-v4'):paths+=probes
    tree=subprocess.check_output(['git','ls-tree','-rz',source,'--',*paths])
    entries=[]
    for record in tree.split(b'\0'):
        if not record:continue
        meta,name=record.split(b'\t',1);mode,kind,oid=meta.decode().split()
        if kind!='blob' or mode not in ('100644','100755'):raise ValueError('UNSUPPORTED_BLOB')
        n=name.decode();entries.append((n[8:] if profile=='bridge' else n,oid,mode))
    if profile in ('connect-v1','zero-touch-v1','reconstruction-v1','reconstruction-v2','reconstruction-v3','reconstruction-v4') and not set(probes)<={name for name,_,_ in entries}:
        raise ValueError('CONNECT_PROBES_REQUIRED')
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
    if profile in ('connect-v1','zero-touch-v1'):
        filename='record-agent-migration-manifest.json' if profile=='connect-v1' else 'source-association-migration-manifest.json'
        manifest=json.loads(subprocess.check_output(['git','show',source+':backend/scripts/'+filename]))
        digest=hashlib.sha256(json.dumps(inventory,separators=(',',':')).encode()).hexdigest()
        if len(inventory)!=manifest['sourceCount'] or digest!=manifest['inventorySha256']:
            raise ValueError('EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH')
    if profile=='reconstruction-v1':
        # This is a separate candidate profile. The historical108/109 guards
        # above remain frozen and must reject a reconstruction113 source.
        additions={'110_existing_data_reconstruction','111_source_subscriptions','112_reconstruction_exports','113_reconstruction_issue_history'}
        manifest=json.loads(subprocess.check_output(['git','show',source+':backend/scripts/source-association-migration-manifest.json']))
        predecessor=[row for row in inventory if row['id'] not in additions]
        digest=hashlib.sha256(json.dumps(predecessor,separators=(',',':')).encode()).hexdigest()
        if len(inventory)!=manifest['sourceCount']+4 or {row['id'] for row in inventory if row['id'] in additions}!=additions or digest!=manifest['inventorySha256']:
            raise ValueError('EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH')
    if profile=='reconstruction-v2':
        # Explicit116 review binds the entire frozen113 predecessor. The old
        #108/109/113 profiles above remain unchanged and reject this source.
        additions={'114_operational_case_allocations','115_operational_projection_indexes','116_case_export_retention'}
        predecessor=[row for row in inventory if row['id'] not in additions]
        digest=hashlib.sha256(json.dumps(predecessor,separators=(',',':')).encode()).hexdigest()
        if len(inventory)!=115 or {row['id'] for row in inventory if row['id'] in additions}!=additions or digest!='eac1cf8a3e505fdee80d3888a4d504efc6266f610897997b46fef8bca62cfd8c':
            raise ValueError('EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH')
    if profile=='reconstruction-v3':
        # Explicit117 admission preserves every qualified116 predecessor byte.
        additions={'117_source_backfill_jobs'}
        predecessor=[row for row in inventory if row['id'] not in additions]
        digest=hashlib.sha256(json.dumps(predecessor,separators=(',',':')).encode()).hexdigest()
        if len(inventory)!=116 or {row['id'] for row in inventory if row['id'] in additions}!=additions or digest!='343ff540ec79d5fe2446e3358e93cc7deac06f0bbc854fee834c2a65858cfa0f':
            raise ValueError('EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH')
    if profile=='reconstruction-v4':
        additions={'118_source_projection_rechecks'}
        predecessor=[row for row in inventory if row['id'] not in additions]
        digest=hashlib.sha256(json.dumps(predecessor,separators=(',',':')).encode()).hexdigest()
        if len(inventory)!=117 or {row['id'] for row in inventory if row['id'] in additions}!=additions or digest!='57d54b44d9f6d3e43db003da2159c4e1cf191cfc5d8acbe5e2c361939d91cf8b':
            raise ValueError('EXACT_SOURCE_PROFILE_INVENTORY_MISMATCH')
    return {'sourceSha':source,'archiveSha256':hashlib.sha256(Path(destination).read_bytes()).hexdigest(),'gitFilesVerified':len(entries),'migrationCount':len(inventory),'migrationInventorySha256':hashlib.sha256(json.dumps(inventory,separators=(',',':')).encode()).hexdigest(),'allGitBlobBytesVerified':True}
if __name__=='__main__':
    try: print(json.dumps(archive(*sys.argv[1:4],verify='--verify' in sys.argv[4:])))
    except Exception as e:
        print(str(e) if isinstance(e,ValueError) else 'ARCHIVE_OPERATION_FAILED',file=sys.stderr);sys.exit(1)
