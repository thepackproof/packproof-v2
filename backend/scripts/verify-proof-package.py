#!/usr/bin/env python3
"""Offline verifier. Uses only the Python standard library; never extracts paths."""
import argparse
import hashlib
import json
import sys
import zipfile

def digest(value):
    return hashlib.sha256(value).hexdigest()

def verify(path, expected=None):
    with zipfile.ZipFile(path) as archive:
        names=archive.namelist()
        if len(names)!=len(set(names)) or any(n.startswith('/') or '..' in n.split('/') for n in names):
            raise ValueError('Unsafe or duplicate archive names')
        if sum(i.file_size for i in archive.infolist())>220*1024*1024:
            raise ValueError('Package exceeds verifier size limit')
        index=json.loads(archive.read('integrity/hashes.json'))
        for name, expected_hash in index.items():
            if digest(archive.read(name))!=expected_hash:
                raise ValueError('Hash mismatch: '+name)
        raw=archive.read('manifest.json')
        manifest=json.loads(raw)
        package=json.loads(archive.read('package.json'))
        actual=digest(raw)
        if package.get('schema')!='packproof.proof-package.v1' or actual!=package['manifestSha256']:
            raise ValueError('Manifest digest or schema mismatch')
        if package['canonicalJson'].encode()!=raw or package['canonicalManifest']!=manifest:
            raise ValueError('Manifest representations disagree')
        if package['proofId']!=manifest['proofId']:
            raise ValueError('Proof identity mismatch')
        if expected and actual!=expected.lower():
            raise ValueError('Manifest differs from independently supplied digest')
        evidence_index=json.loads(archive.read('integrity/evidence.json'))
        media={entry['evidenceId']:entry for entry in evidence_index}
        if len(media)!=len(evidence_index) or set(media)!={e['evidenceId'] for e in manifest['evidence']}:
            raise ValueError('Evidence inventory mismatch')
        for evidence in manifest['evidence']:
            data=archive.read(media[evidence['evidenceId']]['path'])
            if len(data)!=evidence['byteSize'] or digest(data)!=evidence['sha256']:
                raise ValueError('Evidence differs from frozen manifest')
        stages=json.loads(archive.read('lifecycle/stages.json'))
        stage_hashes={stage['stageId']:stage['sha256'] for stage in stages}
        for stage in stages:
            raw_stage=archive.read(stage['manifestPath'])
            stage_manifest=json.loads(raw_stage)
            if digest(raw_stage)!=stage['sha256'] or stage_manifest['baseManifestSha256']!=actual or stage_manifest['proofId']!=manifest['proofId']:
                raise ValueError('Lifecycle manifest mismatch')
            previous=stage_manifest.get('previousStage')
            if previous and stage_hashes.get(previous['stageId'])!=previous['sha256']:
                raise ValueError('Lifecycle chain mismatch')
            stage_media={entry['evidenceId']:entry['path'] for entry in stage['evidence']}
            if set(stage_media)!={e['evidenceId'] for e in stage_manifest['evidence']}:
                raise ValueError('Lifecycle evidence inventory mismatch')
            for evidence in stage_manifest['evidence']:
                data=archive.read(stage_media[evidence['evidenceId']])
                if len(data)!=evidence['byteSize'] or digest(data)!=evidence['sha256']:
                    raise ValueError('Lifecycle evidence hash mismatch')
        return {'proofId':manifest['proofId'],'manifestSha256':actual,'evidenceVerified':len(media),'independentDigestMatched':bool(expected),'signatureVerified':False}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package')
    parser.add_argument('--expected-manifest-sha256')
    args=parser.parse_args()
    try:
        print(json.dumps(verify(args.package,args.expected_manifest_sha256),indent=2))
    except (ValueError,KeyError,zipfile.BadZipFile,OSError) as error:
        print('Verification failed: '+str(error),file=sys.stderr)
        sys.exit(1)
