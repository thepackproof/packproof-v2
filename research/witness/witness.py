"""Private experimental RFC6962-hashed log and stateful witnesses; no public service.
Merkle hashing, tree construction and proofs are provided by pinned pymerkle 6.1.0.
"""
from __future__ import annotations
import argparse, base64, contextlib, hashlib, json, os, sqlite3
try:
    import fcntl
except ImportError:  # Windows offline verification needs no locking.
    fcntl=None
from pathlib import Path
from datetime import datetime, timezone
from pymerkle import SqliteTree, InmemoryTree, MerkleProof, verify_inclusion, verify_consistency
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey,Ed25519PublicKey
from cryptography.hazmat.primitives import serialization
import rfc8785

DOMAIN=b'packproof.witness.commitment.v1\0'
MAX_LEAVES=100000

def canonical(x): return rfc8785.dumps(x)
def sha(x): return hashlib.sha256(x).hexdigest()
def unhex(s):
    if not isinstance(s,str) or len(s)!=64 or s!=s.lower(): raise ValueError('expected canonical 32-byte hex')
    return bytes.fromhex(s)
def commitment(digest,blind): return sha(DOMAIN+unhex(blind)+unhex(digest))
def now(): return datetime.now(timezone.utc).isoformat()
def key_id(key): return sha(key.public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw))
def load_private(path):
    key=serialization.load_pem_private_key(Path(path).read_bytes(),password=None)
    if not isinstance(key,Ed25519PrivateKey): raise ValueError('Ed25519 required')
    return key

def sign(record,key): return {'keyId':key_id(key.public_key()),'signature':base64.b64encode(key.sign(canonical(record))).decode()}
def verify_sig(record,sig,entry):
    if entry.get('revoked',False): raise ValueError('revoked signer')
    key=serialization.load_pem_public_key(entry['publicKeyPem'].encode())
    if not isinstance(key,Ed25519PublicKey) or key_id(key)!=sig['keyId'] or entry['keyId']!=sig['keyId']: raise ValueError('untrusted signer')
    issued=datetime.fromisoformat(record['issuedAt'])
    if issued.tzinfo is None: raise ValueError('checkpoint timestamp requires timezone')
    for field,cmp in [('validFrom',lambda a,b:a<b),('validUntil',lambda a,b:a>b)]:
        if entry.get(field) and cmp(issued,datetime.fromisoformat(entry[field])): raise ValueError('signer outside trust interval')
    key.verify(base64.b64decode(sig['signature'],validate=True),canonical(record))

@contextlib.contextmanager
def locked(path):
    with open(str(path)+'.lock','a+b') as f:
        if fcntl is not None:
            fcntl.flock(f,fcntl.LOCK_EX)
            try: yield
            finally: fcntl.flock(f,fcntl.LOCK_UN)
        else:
            import msvcrt
            if f.seek(0,2)==0: f.write(b'\0');f.flush()
            f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_LOCK,1)
            try: yield
            finally:
                f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)

def append(db,digest,blind,private_key,log_id):
    leaf=unhex(commitment(digest,blind))
    with locked(db):
        tree=SqliteTree(str(db),algorithm='sha256')
        try:
            tree.cur.execute('CREATE UNIQUE INDEX IF NOT EXISTS rnd_unique_commitment ON leaf(entry)')
            index=tree.cur.execute('SELECT id FROM leaf WHERE entry = ?', (leaf,)).fetchone()
            if index is None:
                if tree.get_size()>=MAX_LEAVES: raise ValueError('research log capacity reached')
                index=tree.append_entry(leaf)
            size=tree.get_size()
            cp={'schemaVersion':'packproof.checkpoint.v1','origin':log_id,'treeSize':size,'rootHash':tree.get_state().hex(),'hashAlgorithm':'rfc6962-sha256','issuedAt':now()}
            return {'schemaVersion':'packproof.witness-receipt.v1','commitment':leaf.hex(),'opening':{'recordDigest':digest,'blind':blind},'leafIndex':index,'checkpoint':cp,'logSignature':sign(cp,load_private(private_key)),'inclusionProof':tree.prove_inclusion(index,size).serialize(),'witnessSignatures':[],'consistencyLinks':[],'publicationState':'INCLUDED','limitations':['Only this committed record is checked; omitted records and future extensions are not covered.','Witnesses do not inspect source media or certify scene truth.','Public log timing and volume remain observable.']}
        finally: tree.con.close()

def proof_shape(kind,size,index):
    # Generate only the proof shape with the maintained implementation. Dummy nodes
    # are never used to verify hashes; this binds pymerkle's flexible proof metadata
    # to the stated leaf index/tree sizes without implementing a new Merkle protocol.
    tree=InmemoryTree(algorithm='sha256'); tree.get_size=lambda:size
    tree._get_leaf=lambda _index:b'\0'*32
    tree._get_root=lambda _start,_end:b'\0'*32
    return (tree.prove_inclusion(index,size) if kind=='inclusion' else tree.prove_consistency(index,size)).serialize()

def parse_proof(doc,kind,size,index):
    if type(size)is not int or type(index)is not int or not 0<index<=size<=MAX_LEAVES: raise ValueError('invalid proof sizes')
    expected=proof_shape(kind,size,index)
    if set(doc)!={'metadata','rule','subset','path'} or doc['metadata']!=expected['metadata'] or doc['rule']!=expected['rule'] or doc['subset']!=expected['subset'] or len(doc['path'])!=len(expected['path']): raise ValueError('proof shape/size/index mismatch')
    if any(type(x)is not int for x in doc['rule']+doc['subset']): raise ValueError('invalid proof rule')
    for x in doc['path']: unhex(x)
    return MerkleProof.deserialize(doc)

def verify_checkpoint(receipt,policy):
    cp=receipt['checkpoint']
    if cp['schemaVersion']!='packproof.checkpoint.v1' or cp['origin']!=policy['logId'] or cp['hashAlgorithm']!='rfc6962-sha256' or type(cp['treeSize'])is not int or not 1<=cp['treeSize']<=MAX_LEAVES: raise ValueError('invalid checkpoint')
    unhex(cp['rootHash'])
    entry=policy['logKeys'].get(receipt['logSignature']['keyId'])
    if not entry: raise ValueError('unknown log key')
    verify_sig(cp,receipt['logSignature'],entry)

def consistency(db,old_size,new_size):
    tree=SqliteTree(str(db),algorithm='sha256')
    try: return tree.prove_consistency(old_size,new_size).serialize()
    finally: tree.con.close()

def last_checkpoint(state_db,log_id,operator_id):
    if not Path(state_db).exists(): return None
    con=sqlite3.connect('file:'+str(Path(state_db).resolve())+'?mode=ro',uri=True)
    try:
        if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoint_history'").fetchone(): return None
        row=con.execute('SELECT checkpoint FROM checkpoint_history WHERE log_id=? AND operator_id=? ORDER BY seq DESC LIMIT 1',(log_id,operator_id)).fetchone()
        return json.loads(row[0]) if row else None
    finally:con.close()

def witness(receipt,policy,state_db,private_key,operator_id,proof=None):
    verify_checkpoint(receipt,policy)
    key=load_private(private_key); kid=key_id(key.public_key()); entry=policy['witnessKeys'].get(kid)
    if not entry or entry['operatorId']!=operator_id: raise ValueError('witness key/operator not authorized')
    cp=receipt['checkpoint']
    with locked(state_db):
        con=sqlite3.connect(state_db)
        try:
            con.execute('CREATE TABLE IF NOT EXISTS checkpoint_history (seq INTEGER PRIMARY KEY, log_id TEXT NOT NULL, operator_id TEXT NOT NULL, checkpoint TEXT NOT NULL, signature TEXT NOT NULL)')
            prev=con.execute('SELECT checkpoint FROM checkpoint_history WHERE log_id=? AND operator_id=? ORDER BY seq DESC LIMIT 1',(cp['origin'],operator_id)).fetchone()
            previous=json.loads(prev[0]) if prev else None
            if previous:
                if cp['treeSize']<previous['treeSize']: raise ValueError('rollback checkpoint')
                if cp['treeSize']==previous['treeSize']:
                    if cp['rootHash']!=previous['rootHash']: raise ValueError('split view at same size')
                else:
                    if proof is None: raise ValueError('consistency proof required from persistent witness checkpoint')
                    p=parse_proof(proof,'consistency',cp['treeSize'],previous['treeSize'])
                    verify_consistency(unhex(previous['rootHash']),unhex(cp['rootHash']),p)
            signed=sign(cp,key)
            signed.update({'operatorId':operator_id,'testOnly':bool(entry.get('testOnly',True)),'previousCheckpoint':previous})
            verify_sig(cp,signed,entry)
            with con: con.execute('INSERT INTO checkpoint_history(log_id,operator_id,checkpoint,signature) VALUES(?,?,?,?)',(cp['origin'],operator_id,canonical(cp).decode(),canonical(signed).decode()))
            return signed
        finally: con.close()

def verify_inclusion_receipt(receipt,policy,expected_digest=None):
    if policy['schemaVersion']!='packproof.witness-trust.v1' or receipt['schemaVersion']!='packproof.witness-receipt.v1': raise ValueError('unsupported schema')
    if receipt.get('trustPolicyId')!=policy['policyId']: raise ValueError('trust policy must be pinned out of band')
    opening=receipt['opening']; leaf=commitment(opening['recordDigest'],opening['blind'])
    if expected_digest and opening['recordDigest']!=expected_digest: raise ValueError('record digest mismatch')
    if leaf!=receipt['commitment']: raise ValueError('commitment opening mismatch')
    verify_checkpoint(receipt,policy); cp=receipt['checkpoint']
    proof=parse_proof(receipt['inclusionProof'],'inclusion',cp['treeSize'],receipt['leafIndex'])
    verify_inclusion(hashlib.sha256(b'\0'+unhex(leaf)).digest(),unhex(cp['rootHash']),proof)
    age=(datetime.now(timezone.utc)-datetime.fromisoformat(cp['issuedAt'])).total_seconds()
    if age < -300: raise ValueError('checkpoint is in the future')
    return {'valid':True,'publicationState':'INCLUDED','assurance':'LOG_INCLUSION_ONLY','independentOperatorCount':0,'checkpointAgeSeconds':max(0,age),'treeSize':cp['treeSize'],'recordDigest':opening['recordDigest'],'policyId':policy['policyId'],'scope':'Log inclusion only. No witness consistency assurance, future/omitted extension completeness or scene truth established.'}

def verify_receipt(receipt,policy,expected_digest=None,require_independent=False):
    included=verify_inclusion_receipt(receipt,policy,expected_digest)
    cp=receipt['checkpoint']; opening=receipt['opening']
    seen=set(); independent=set()
    for sig in receipt['witnessSignatures']:
        entry=policy['witnessKeys'].get(sig['keyId'])
        if not entry or sig['operatorId']!=entry['operatorId'] or sig['operatorId'] in seen: raise ValueError('untrusted or duplicate witness')
        verify_sig(cp,sig,entry); seen.add(sig['operatorId'])
        if entry.get('independent') is True and entry.get('testOnly') is False: independent.add(sig['operatorId'])
    required=set(policy['requiredOperators'])
    if len(required)!=2 or not required.issubset(seen): raise ValueError('both named witness signatures required')
    if (require_independent or not policy.get('testOnly',True)) and not required.issubset(independent): raise ValueError('two genuinely independent operators required')
    for link in receipt.get('consistencyLinks',[]):
        old=link['previousCheckpoint']; new=link['checkpoint']
        if new!=cp or old['origin']!=cp['origin']: raise ValueError('unbound consistency checkpoint')
        p=parse_proof(link['proof'],'consistency',cp['treeSize'],old['treeSize'])
        verify_consistency(unhex(old['rootHash']),unhex(cp['rootHash']),p)
    issued=datetime.fromisoformat(cp['issuedAt'])
    age=(datetime.now(timezone.utc)-issued).total_seconds()
    if age < -300: raise ValueError('checkpoint is in the future')
    return {'valid':True,'publicationState':'WITNESSED','assurance':'TEST_WITNESSED' if policy.get('testOnly',True) else 'INDEPENDENTLY_WITNESSED','independentOperatorCount':len(independent),'checkpointAgeSeconds':max(0,age),'treeSize':cp['treeSize'],'recordDigest':opening['recordDigest'],'policyId':policy['policyId'],'scope':'Included record only; future/omitted extensions and scene truth not established.'}

def main():
    p=argparse.ArgumentParser(); s=p.add_subparsers(dest='cmd',required=True)
    a=s.add_parser('append'); a.add_argument('--record-digest',required=True);a.add_argument('--blind',required=True);a.add_argument('--log-db',required=True);a.add_argument('--log-key',required=True);a.add_argument('--log-id',required=True);a.add_argument('--policy-id')
    c=s.add_parser('consistency'); c.add_argument('--log-db',required=True);c.add_argument('--old-size',type=int,required=True);c.add_argument('--new-size',type=int,required=True)
    cp=s.add_parser('checkpoint');cp.add_argument('--state-db',required=True);cp.add_argument('--log-id',required=True);cp.add_argument('--operator-id',required=True)
    w=s.add_parser('witness');w.add_argument('receipt');w.add_argument('--policy',required=True);w.add_argument('--state-db',required=True);w.add_argument('--key',required=True);w.add_argument('--operator-id',required=True);w.add_argument('--consistency-proof')
    v=s.add_parser('verify');v.add_argument('receipt');v.add_argument('--policy',required=True);v.add_argument('--record-digest');v.add_argument('--require-independent',action='store_true')
    vi=s.add_parser('verify-inclusion');vi.add_argument('receipt');vi.add_argument('--policy',required=True);vi.add_argument('--record-digest')
    args=p.parse_args()
    if args.cmd=='append':
        result=append(args.log_db,args.record_digest,args.blind,args.log_key,args.log_id)
        if args.policy_id: result['trustPolicyId']=args.policy_id
    elif args.cmd=='consistency': result=consistency(args.log_db,args.old_size,args.new_size)
    elif args.cmd=='checkpoint': result=last_checkpoint(args.state_db,args.log_id,args.operator_id)
    elif args.cmd=='witness': result=witness(json.loads(Path(args.receipt).read_text()),json.loads(Path(args.policy).read_text()),args.state_db,args.key,args.operator_id,json.loads(Path(args.consistency_proof).read_text()) if args.consistency_proof else None)
    elif args.cmd=='verify-inclusion': result=verify_inclusion_receipt(json.loads(Path(args.receipt).read_text()),json.loads(Path(args.policy).read_text()),args.record_digest)
    else: result=verify_receipt(json.loads(Path(args.receipt).read_text()),json.loads(Path(args.policy).read_text()),args.record_digest,args.require_independent)
    print(json.dumps(result))
if __name__=='__main__': main()
