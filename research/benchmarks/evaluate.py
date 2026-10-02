#!/usr/bin/env python3
"""Validate private dataset splits and compute prespecified independent-unit bounds."""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from research.benchmarks.statistics import independent_error_report,validate_manifest


def load(path):
    path=Path(path)
    if path.stat().st_size>10*1024*1024:
        raise ValueError('MANIFEST_BYTE_LIMIT')
    data=path.read_bytes()
    return json.loads(data),hashlib.sha256(data).hexdigest()


def evaluate(manifest,config,trials,config_digest,feature):
    if manifest.get('frozenPolicyDigest')!=config_digest:
        raise ValueError('FROZEN_POLICY_DIGEST_MISMATCH')
    manifest={**manifest,'holdoutDimensions':config['holdoutDimensions']}
    split=validate_manifest(manifest)
    if not split['valid']:
        return {'schemaVersion':'packproof.evaluation.v1','state':'REJECTED_SPLIT_LEAKAGE','splitValidation':split,'qualified':False}
    records={r['recordId']:r for r in manifest['records']}
    attempts=[]
    for attempt in trials.get('attempts',[]):
        record=records.get(attempt.get('recordId'))
        if not record or record['split']!='test':
            raise ValueError('ONLY_PRESPECIFIED_TEST_RECORDS_PERMITTED')
        if attempt.get('independentUnitId')!=record.get('experimentUnitId') or attempt.get('attackFamily')!=record.get('attackFamily'):
            raise ValueError('ATTEMPT_LINEAGE_MISMATCH')
        attempts.append(attempt)
    report=independent_error_report(attempts,config['errorTargets'][feature],config['confidence'])
    observed={row['attackFamily'] for row in report['families']}
    missing=[family for family in config[feature]['requiredAttackFamilies'] if family not in observed]
    return {'schemaVersion':'packproof.evaluation.v1','state':'MEASURED','feature':feature,'frozenPolicyDigest':config_digest,
            'splitValidation':split,'statistics':report,'missingAttackFamilies':missing,
            'reportedRepeatableBypasses':trials.get('repeatableBypasses',[]),'dataOrigin':manifest.get('dataOrigin','UNKNOWN'),
            'qualified':False,'releaseAuthorized':False,
            'limitations':['Bounds do not by themselves establish eligibility, device safety, genuine error, conclusive coverage or independent scientific review.',
                           'Dataset consent and physical ground truth require private audit; a manifest declaration is not verification of those facts.']}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',required=True);parser.add_argument('--config',required=True);parser.add_argument('--trials',required=True)
    parser.add_argument('--feature',required=True,choices=['F01','F04','F06']);parser.add_argument('--output',required=True)
    args=parser.parse_args()
    manifest,mdigest=load(args.manifest);config,cdigest=load(args.config);trials,tdigest=load(args.trials)
    report=evaluate(manifest,config,trials,cdigest,args.feature)
    report.update({'manifestDigest':mdigest,'trialsDigest':tdigest})
    with Path(args.output).open('x') as file:
        json.dump(report,file,indent=2,allow_nan=False)
    print(json.dumps({'state':report['state'],'qualified':False,'output':args.output}))
    return int(report['state']!='MEASURED')


if __name__=='__main__':
    raise SystemExit(main())
