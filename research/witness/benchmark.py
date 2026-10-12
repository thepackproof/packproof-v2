"""Actual local two-test-witness run; independent-operator count is always zero."""
import json,platform,secrets,statistics,tempfile,time
from pathlib import Path
from research.witness.witness import *

def main():
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--output',default=str(Path(__file__).parent/'reports'));args=parser.parse_args()
    output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        p=Path(td);entries={};keys={}
        for name in ('log','packproof-test-a','packproof-test-b'):
            key=Ed25519PrivateKey.generate();path=p/f'{name}.pem';path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()));keys[name]=path
            entries[name]={'keyId':key_id(key.public_key()),'publicKeyPem':key.public_key().public_bytes(serialization.Encoding.PEM,serialization.PublicFormat.SubjectPublicKeyInfo).decode(),'operatorId':name,'independent':False,'testOnly':True}
        policy={'schemaVersion':'packproof.witness-trust.v1','policyId':'synthetic-local-test-v1','logId':'packproof-local-research','testOnly':True,'requiredOperators':['packproof-test-a','packproof-test-b'],'logKeys':{entries['log']['keyId']:entries['log']},'witnessKeys':{entries[x]['keyId']:entries[x] for x in ('packproof-test-a','packproof-test-b')}}
        latencies=[];verify_times=[];db=p/'log.sqlite'
        for index in range(1,33):
            record={'schemaVersion':'synthetic-benchmark-v1','sequence':index};started=time.perf_counter()
            receipt=append(db,sha(canonical(record)),secrets.token_hex(32),keys['log'],policy['logId']);receipt['trustPolicyId']=policy['policyId']
            proof=consistency(db,index-1,index) if index>1 else None
            receipt['witnessSignatures']=[witness(receipt,policy,p/f'{op}.sqlite',keys[op],op,proof) for op in policy['requiredOperators']]
            latencies.append((time.perf_counter()-started)*1000);started=time.perf_counter();verify_receipt(receipt,policy,sha(canonical(record)));verify_times.append((time.perf_counter()-started)*1000)
        report={'schemaVersion':'packproof.witness-benchmark.v1','generatedAt':now(),'population':32,'topology':'one local sqlite log; two stateful same-process PackProof-controlled test operators','independentOperatorCount':0,'hardware':{'platform':platform.platform(),'python':platform.python_version()},'publicationMs':{'median':statistics.median(latencies),'p95':sorted(latencies)[30]},'verificationMs':{'median':statistics.median(verify_times),'p95':sorted(verify_times)[30]},'latestReceiptBytes':len(canonical(receipt)),'cloudSpendUsd':0,'externalLatency':'NOT_MEASURED','securityReview':'PENDING','publicReliance':False,'library':'pymerkle 6.1.0; SHA256 RFC6962 domain separation','limits':['Local synthetic protocol validation only.','No external independently operated witness or network availability qualification.','Timing and volume leakage remain; no PII is logged.']}
        (output/'local-synthetic-2026-10-02.json').write_text(json.dumps(report,indent=2)+'\n')
        (output/'synthetic-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');(output/'synthetic-trust.json').write_text(json.dumps(policy,indent=2)+'\n');(output/'synthetic-record.json').write_text(json.dumps(record,indent=2)+'\n')
        print(json.dumps(report,indent=2))
if __name__=='__main__':main()
