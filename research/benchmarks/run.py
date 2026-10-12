#!/usr/bin/env python3
"""Reproducible synthetic engineering report. Stores no private corpus in source control."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from research.benchmarks.fixtures import basic,cube_views,source,passive_parcel
from research.benchmarks.statistics import independent_error_report

REGIONS=[{'regionId':'label-upper','group':'label','polygon':[[170,115],[470,115],[470,205],[170,205]]},
         {'regionId':'label-lower','group':'label','polygon':[[170,290],[470,290],[470,330],[170,330]]},
         {'regionId':'carton-left','group':'carton','polygon':[[20,90],[140,90],[140,335],[20,335]]},
         {'regionId':'carton-bottom','group':'carton','polygon':[[40,360],[550,360],[550,450],[40,450]]}]
SUPPORT=[{'regionId':'unchanged-top','group':'support','polygon':[[20,20],[620,20],[620,310],[20,310]]}]


def run_case(root,name,feature,sources,parameters=None):
    directory=Path(root)/name;directory.mkdir()
    job={'schemaVersion':'packproof.vision-job.v1','analysisId':name,'feature':feature,'sandboxRoot':str(Path(root).resolve()),
         'binding':{'tenantId':'SYNTHETIC_ONLY','proofId':'synthetic-proof','rootManifestDigest':'sha256:'+'0'*64,
                    'subject':{'packageInstanceId':'synthetic-package','shipmentLegId':'synthetic-leg'}},
         'sources':sources,'parameters':parameters or {}}
    job_path=directory/'job.json';job_path.write_text(json.dumps(job))
    start=time.monotonic()
    process=subprocess.run([sys.executable,str(ROOT/'research/vision/worker.py'),'--job',str(job_path),'--output',str(directory)],
                           capture_output=True,text=True,timeout=65)
    if not (directory/'result.json').exists():
        raise RuntimeError(f'{name}: worker returned no result: {process.stderr[-1000:]}')
    result=json.loads((directory/'result.json').read_text())
    return {'case':name,'feature':feature,'returnCode':process.returncode,'operationalState':result['operationalState'],
            'findingState':result['findingState'],'diagnostics':result.get('diagnostics'),'resourceUsage':result.get('resourceUsage'),
            'artifactCount':len(result.get('artifacts',[])),'resultPath':str(Path(name)/'result.json'),
            'wallIncludingStartupMs':round((time.monotonic()-start)*1000,3)}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',required=True)
    parser.add_argument('--feature',choices=['all','F01','F03','F04','F05','F06','F08'],default='all')
    parser.add_argument('--sparse3d',action='store_true')
    args=parser.parse_args();root=Path(args.output).resolve();root.mkdir(parents=True,exist_ok=True)
    paths=basic(root/'fixtures');cases=[]
    if args.feature in ('all','F01'):
        passive=passive_parcel(root/'fixtures')
        cases.append(run_case(root,'F01-passive-enrollment','proofprint',[source(passive,'passive')],{'mode':'enroll'}))
        for name in ('recapture','same-content-copy','label-transfer'):
            cases.append(run_case(root,'F01-'+name,'proofprint',[source(paths['base'],'a'),source(paths[name],'b')],{'regions':REGIONS}))
        cases.append(run_case(root,'F01-missing-carton','proofprint',[source(paths['base'],'a'),source(paths['recapture'],'b')],{'regions':REGIONS[:2]}))
    if args.feature in ('all','F08'):
        cases.append(run_case(root,'F08-quality','proofpilot',[source(paths[k],k) for k in ('base','blur','glare')]))
    if args.feature in ('all','F03'):
        cases.append(run_case(root,'F03-timeline','proofsight',[source(paths['response'],'response')],{'samplingHz':1}))
    if args.feature in ('all','F04'):
        cases.append(run_case(root,'F04-condition','prooftwin',[source(paths['base'],'a'),source(paths['condition-change'],'b')],{'regions':SUPPORT}))
        if args.sparse3d:
            sources,masks=cube_views(root/'cube-fixtures')
            cases.append(run_case(root,'F04-sparse3d','prooftwin',sources,{'mode':'sparse3d','objectMasks':masks,'focalLengthPixels':600}))
    if args.feature in ('all','F05'):
        cases.append(run_case(root,'F05-appearance','proofmatch',[source(paths['base'],'a'),source(paths['same-content-copy'],'b')]))
    if args.feature in ('all','F06'):
        cases.append(run_case(root,'F06-response','prooflive',[source(paths['response'],'response')],{'samplingHz':2,
                    'challenge':{'challengeId':'synthetic-not-server-issued','commands':[{'timeMs':t,'level':v} for t,v in [(0,0),(2000,.4),(4000,.1),(6000,.6),(7900,.2)]]}}))
    report={'schemaVersion':'packproof.synthetic-benchmark.v1','dataOrigin':'SYNTHETIC_DETERMINISTIC',
            'qualification':'ENGINEERING_ONLY_NO_PHYSICAL_VALIDATION','hardware':{'system':platform.system(),'machine':platform.machine(),'cpu':platform.processor(),'python':platform.python_version()},
            'fixtureSeed':[173,719],'cases':cases,'physicalAttempts':0,'nativeDeviceAttempts':0,
            'rareErrorRequirements':independent_error_report([],target=.0001),
            'cost':{'providerSpendMeasured':False,'cloudCostPerProof':None,'reason':'Local runtime and output sizes measured; no cloud pricing or lifetime retention assumed.'},
            'unresolved':['Consented physical corpus and real camera tests unavailable.','No qualified physical/capture/condition/liveness claim.','Synthetic copy/transfer images test plumbing and channel separation only.']}
    (root/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False))
    print(json.dumps({'report':str(root/'report.json'),'cases':len(cases),'failed':sum(c['operationalState']!='SUCCEEDED' for c in cases)},indent=2))
    return int(any(c['operationalState']!='SUCCEEDED' for c in cases))


if __name__=='__main__':
    raise SystemExit(main())
