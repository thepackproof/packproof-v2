#!/usr/bin/env python3
"""Bounded local-only worker. Run --job <json> --output <private-empty-directory>."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import time

# Set before native libraries initialize thread pools.
for variable in ('OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','MKL_NUM_THREADS','NUMEXPR_NUM_THREADS'):
    os.environ[variable] = '1'
os.environ['OPENCV_IO_MAX_IMAGE_PIXELS'] = '24000000'
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'protocol_whitelist;file|format_whitelist;mov,matroska,webm,avi'

MAX_INPUT_BYTES = 128 * 1024 * 1024
MAX_JOB_BYTES = 512 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024
FEATURES = {'proofprint','proofsight','prooftwin','prooflive','proofpilot','proofmatch'}
MIMES = {'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/x-portable-graymap':'.pgm',
         'video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm','video/x-msvideo':'.avi'}


def bounded_int(value, minimum, maximum, name):
    if isinstance(value,bool) or not isinstance(value,int) or not minimum <= value <= maximum:
        raise ValueError(name)
    return value


def within(root, path):
    result = Path(path).resolve(strict=False)
    if not result.is_relative_to(root):
        raise ValueError('PATH_OUTSIDE_SANDBOX')
    return result


def snapshots(job, root, temporary):
    sources=job.get('sources',[])
    if not isinstance(sources,list) or not 1<=len(sources)<=24:
        raise ValueError('SOURCE_COUNT_LIMIT')
    total=0; result=[]; identifiers=set()
    for index, source in enumerate(sources):
        if not isinstance(source,dict) or not isinstance(source.get('sourceId'),str) or not source['sourceId'] or source['sourceId'] in identifiers:
            raise ValueError('INVALID_OR_DUPLICATE_SOURCE_ID')
        identifiers.add(source['sourceId'])
        media=source.get('mimeType',source.get('mediaType'))
        if media not in MIMES:
            raise ValueError('UNSUPPORTED_MEDIA_TYPE')
        expected=source.get('sha256','').removeprefix('sha256:')
        if len(expected)!=64 or any(char not in '0123456789abcdef' for char in expected):
            raise ValueError('INVALID_SOURCE_DIGEST')
        size=bounded_int(source.get('byteLength'),1,MAX_INPUT_BYTES,'INVALID_SOURCE_SIZE')
        total+=size
        if total>MAX_INPUT_BYTES:
            raise ValueError('INPUT_BYTE_LIMIT')
        raw=source.get('path')
        if not isinstance(raw,str) or '://' in raw or '\x00' in raw:
            raise ValueError('LOCAL_FILE_REQUIRED')
        candidate=Path(raw) if Path(raw).is_absolute() else root/raw
        path=within(root,candidate)
        if any(part.is_symlink() for part in (candidate,*candidate.parents) if part.is_relative_to(root)):
            raise ValueError('SOURCE_SYMLINK_REJECTED')
        flags=os.O_RDONLY | getattr(os,'O_NOFOLLOW',0)
        handle=os.open(path,flags)
        destination=Path(temporary)/f'{index}{MIMES[media]}'
        h=hashlib.sha256(); read=0
        with os.fdopen(handle,'rb') as incoming, destination.open('xb') as outgoing:
            info=os.fstat(incoming.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size!=size:
                raise ValueError('SOURCE_LENGTH_MISMATCH')
            while part:=incoming.read(1024*1024):
                read+=len(part)
                if read>size:
                    raise ValueError('SOURCE_LENGTH_MISMATCH')
                outgoing.write(part); h.update(part)
        if read!=size or h.hexdigest()!=expected:
            raise ValueError('SOURCE_DIGEST_MISMATCH')
        with destination.open('rb') as probe:
            header=probe.read(16)
        signatures={'image/png':header.startswith(b'\x89PNG\r\n\x1a\n'), 'image/jpeg':header.startswith(b'\xff\xd8\xff'),
                    'image/webp':header[:4]==b'RIFF' and header[8:12]==b'WEBP', 'image/x-portable-graymap':header[:2] in (b'P5',b'P2'), 'video/mp4':header[4:8]==b'ftyp',
                    'video/quicktime':header[4:8] in (b'ftyp',b'moov',b'mdat',b'wide'), 'video/webm':header.startswith(b'\x1a\x45\xdf\xa3'),
                    'video/x-msvideo':header[:4]==b'RIFF' and header[8:12]==b'AVI '}
        if not signatures[media]:
            raise ValueError('MEDIA_CONTAINER_SIGNATURE_MISMATCH')
        destination.chmod(0o400)
        result.append({**source,'mimeType':media,'sha256':expected,'_snapshot':destination})
    return result


def source_inventory(sources):
    return [{key:source[key] for key in ('sourceId','sha256','byteLength','mimeType','objectVersionId') if key in source} for source in sources]


def load_trusted_model(job,root):
    entry=job.get('trustedModels',{}).get('proofsight')
    if entry is None:return None
    if not isinstance(entry,dict) or not isinstance(entry.get('path'),str) or not isinstance(entry.get('sha256'),str):
        raise ValueError('INVALID_TRUSTED_MODEL_ENTRY')
    candidate=Path(entry['path']);candidate=candidate if candidate.is_absolute() else root/candidate
    path=within(root,candidate)
    if candidate.is_symlink() or not path.is_file() or path.stat().st_size>4*1024*1024:
        raise ValueError('MODEL_FILE_LIMIT')
    data=path.read_bytes()
    if hashlib.sha256(data).hexdigest()!=entry['sha256'].removeprefix('sha256:'):
        raise ValueError('MODEL_DIGEST_MISMATCH')
    parsed=json.loads(data,object_pairs_hook=strict_object,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_MODEL')))
    model=parsed.get('model',parsed)
    if model.get('schemaVersion')!='packproof.event-model.v1' or model.get('feature')!='proofsight' or model.get('method')!='temporal-hog-linear-softmax.v1' or model.get('qualified') is not False or model.get('customerDisplayEnabled') is not False:
        raise ValueError('UNSUPPORTED_MODEL_POLICY')
    return {'model':model,'sha256':hashlib.sha256(data).hexdigest(),'releaseId':entry.get('releaseId')}


def process(job, root, output):
    from engine import (Artifacts, POLICY, POLICY_PATH, appearance, condition, decode_sources, digest,
                        live, pilot, proofprint, sight)
    import cv2
    import numpy as np
    import rfc8785
    cv2.setNumThreads(1); cv2.setRNGSeed(173)
    if job.get('schemaVersion')!='packproof.vision-job.v1':
        raise ValueError('UNSUPPORTED_JOB_SCHEMA')
    feature=job.get('feature')
    if feature not in FEATURES:
        raise ValueError('UNSUPPORTED_FEATURE')
    parameters=job.get('parameters',{})
    if not isinstance(parameters,dict):
        raise ValueError('INVALID_PARAMETERS')
    if any(key in parameters for key in ('qualified','customerFindingsEnabled','physicalQualification','thresholds','verdict')):
        raise ValueError('CLIENT_POLICY_OVERRIDE_REJECTED')
    if 'frozenRequiredGroups' in parameters and parameters['frozenRequiredGroups']!=POLICY['requiredRegionGroups']:
        raise ValueError('FROZEN_REGION_GROUP_MISMATCH')
    hz=parameters.get('samplingHz',2)
    if not isinstance(hz,(int,float)) or isinstance(hz,bool) or not math.isfinite(hz) or not .5<=hz<=8:
        raise ValueError('SAMPLING_RATE_LIMIT')
    artifacts=Artifacts(output)
    with tempfile.TemporaryDirectory(prefix='.verified-media-',dir=root) as temporary:
        sources=snapshots(job,root,temporary)
        frames,coverage=decode_sources(sources,float(hz))
        if feature=='proofprint' and parameters.get('mode')=='enroll':
            from enrollment import enroll
            result=enroll(frames,artifacts,parameters)
        elif feature=='proofsight':
            trusted=load_trusted_model(job,root)
            result=sight(frames,artifacts,parameters,trusted_model=trusted)
        elif feature=='prooftwin' and parameters.get('mode')=='sparse3d':
            from sfm import reconstruct
            result=reconstruct(frames,artifacts,parameters)
        else:
            methods={'proofprint':proofprint,'proofsight':sight,'prooftwin':condition,'prooflive':live,'proofpilot':pilot,'proofmatch':appearance}
            result=methods[feature](frames,artifacts,parameters)
        if result['findingState'] in ('CONSISTENT','DIFFERENCE_OBSERVED'):
            raise ValueError('UNQUALIFIED_FINDING_REJECTED')
        inventory=source_inventory(sources)
        result.update({'schemaVersion':'packproof.vision-result.v1','feature':feature,'analysisId':job.get('analysisId'),
                       'operationalState':'SUCCEEDED','binding':job.get('binding',{'subject':job.get('subject')}),
                       'policyVersion':POLICY['policyVersion'],'coverage':{'sources':coverage,'samplingHz':float(hz),'coverageSemantics':'SAMPLED_INTERVALS_ONLY'},'artifacts':artifacts.items,
                       'provenance':{'sources':inventory,'modelDigest':('sha256:'+result.get('diagnostics',{}).get('modelInference',{}).get('sha256','')) if result.get('diagnostics',{}).get('modelInference',{}).get('sha256') else None,
                                     'modelReleaseId':result.get('diagnostics',{}).get('modelInference',{}).get('releaseId'),'sourceInventoryDigest':hashlib.sha256(rfc8785.dumps(inventory)).hexdigest(),
                                     'opencvVersion':cv2.__version__,'numpyVersion':np.__version__,'pythonVersion':sys.version.split()[0],
                                     'decoderBuildDigest':hashlib.sha256(cv2.getBuildInformation().encode()).hexdigest(),
                                     'reconstructionExecutableDigest':digest(Path(__file__).with_name('sfm.py')),
                                     'enrollmentExecutableDigest':digest(Path(__file__).with_name('enrollment.py')),
                                     'requirementsDigest':digest(Path(__file__).with_name('requirements-sfm.txt')),
                                     'workerDigest':digest(Path(__file__)),'extractorDigest':digest(Path(__file__).with_name('engine.py')),
                                     'extractorPolicyVersion':POLICY['policyVersion'],'policyDigest':digest(POLICY_PATH),'pixelDecode':'OpenCV BGR8; stored orientation; optional area downscale explicitly recorded in source refs',
                                     'reproducibility':'Single CPU thread; OpenCV RNG seed 173; native decoder/platform can affect numeric outputs.',
                                     'retention':'Snapshots deleted at worker exit; results inherit source retention and purpose; no training reuse authorized.'},
                       'qualification':{'physical':False,'sceneResponse':False,'condition':False,'customerFindingsEnabled':False}})
        return result


def strict_object(pairs):
    result={}
    for key,value in pairs:
        if key in result:
            raise ValueError('DUPLICATE_JSON_KEY')
        result[key]=value
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('job_file',nargs='?'); parser.add_argument('result_file',nargs='?')
    parser.add_argument('--job'); parser.add_argument('--output'); parser.add_argument('--timeout',type=int,default=55)
    args=parser.parse_args()
    job_path=Path(args.job or args.job_file or '').resolve()
    if not job_path.is_file() or job_path.stat().st_size>MAX_JOB_BYTES:
        parser.error('A local job JSON <=512KiB is required')
    job=json.loads(job_path.read_text(),object_pairs_hook=strict_object,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('NONFINITE_JSON')))
    root=Path(job.get('sandboxRoot',str(job_path.parent))).resolve(strict=True)
    within(root,job_path)
    output=within(root,args.output or Path(args.result_file or str(job_path.parent/'result.json')).parent)
    output.mkdir(parents=True,exist_ok=True,mode=0o700)
    target=within(root,Path(args.result_file) if args.result_file else output/'result.json')
    if target.exists():
        raise ValueError('RESULT_ALREADY_EXISTS')
    timeout=bounded_int(args.timeout,1,180,'TIMEOUT_LIMIT')
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU,(timeout,timeout+1))
        resource.setrlimit(resource.RLIMIT_FSIZE,(128*1024*1024,128*1024*1024))
        resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
        resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))
    except ImportError:
        parser.error('This worker requires Linux process limits; run in the documented container.')
    def expired(*_):
        raise TimeoutError('WORKER_DEADLINE_EXCEEDED')
    signal.signal(signal.SIGALRM,expired); signal.alarm(timeout)
    start=time.monotonic()
    try:
        result=process(job,root,output)
    except Exception as error:
        # Do not expose paths, OCR text, media bytes or arbitrary third-party exceptions.
        code=str(error) if isinstance(error,(ValueError,TimeoutError)) and str(error).isupper() and len(str(error))<100 else type(error).__name__.upper()
        result={'schemaVersion':'packproof.vision-result.v1','feature':job.get('feature'),'analysisId':job.get('analysisId'),
                'operationalState':'FAILED','findingState':'NOT_CHECKED','observations':[],'artifacts':[],
                'coverage':{},'diagnostics':{'errorCode':code},'limitations':['Analysis execution failed; no physical discrepancy is inferred.']}
    finally:
        signal.alarm(0)
    result['resourceUsage']={'wallTimeMs':round((time.monotonic()-start)*1000,3),'maxRssKiB':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                             'limits':{'inputBytes':MAX_INPUT_BYTES,'decodedPixelsPerFrame':24_000_000,'selectedFrames':120,'wallSeconds':timeout,'addressSpaceBytes':2*1024**3,'cpuThreads':1}}
    data=json.dumps(result,sort_keys=True,allow_nan=False,indent=2).encode()
    if len(data)>MAX_OUTPUT_BYTES:
        raise ValueError('RESULT_BYTE_LIMIT')
    with target.open('xb') as file:
        file.write(data)
    print(json.dumps({'result':target.name,'operationalState':result['operationalState'],'findingState':result['findingState']}))
    return 0 if result['operationalState']=='SUCCEEDED' else 2


if __name__=='__main__':
    raise SystemExit(main())
