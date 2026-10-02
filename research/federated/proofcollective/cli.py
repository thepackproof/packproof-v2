"""Executable synthetic training; fail closed on deployment or unreviewed DP modes."""
from __future__ import annotations
import argparse
import hashlib
import importlib.metadata
import json
import platform
import secrets
import time
from pathlib import Path
from uuid import uuid4
import numpy as np
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .governance import Governance,GateError,ModelRegistry,PURPOSE,sign,verify,public_key,digest,release_gates
from .model import FEATURES,synthetic_dataset,train_update,evaluate
from .protocol import LocalAgent,secure_aggregate


def require_privacy_mode(mode:str) -> None:
    if mode!='central':
        raise GateError('Distributed-noise release is blocked: dropout/collusion/noise-generation assumptions require reviewed protocol and independent contributors')


def run(output:Path,*,clients:int=24,rounds:int=2,campaign:str='synthetic-quality-v1',privacy_mode:str='central',transport:str='simulated') -> dict:
    require_privacy_mode(privacy_mode)
    if not 20<=clients<=64 or not 1<=rounds<=3:
        raise GateError('Bounded simulation requires 20..64 clients and 1..3 rounds')
    output.mkdir(parents=True,exist_ok=True)
    start=time.monotonic()
    governance=Governance(output/'privacy-ledger.sqlite')
    key=Ed25519PrivateKey.generate() # ephemeral research authority; no production keys
    trusted=public_key(key)
    # Every run records its exact signer. The signing key is never persisted or uploaded.
    run_id=str(uuid4())
    run_dir=output/run_id;run_dir.mkdir()
    (run_dir/'trust-key.hex').write_text(trusted.hex()+'\n')
    registry=ModelRegistry(run_dir/'models',trusted)
    partners=[f'synthetic-partner-{i:02d}' for i in range(1,clients+1)]
    datasets={p:digest({'generator':'quality-v1','partner':i,'samples':128,'scope':'synthetic'}) for i,p in enumerate(partners,1)}
    for p in partners:
        # Lab-generated consent is explicit and cannot qualify as real partner consent.
        # Existing withdrawal is respected, even when a new campaign name is requested.
        latest=governance.db.execute('SELECT action FROM consents WHERE partner=? ORDER BY seq DESC LIMIT 1',(p,)).fetchone()
        if latest is None:
            governance.consent(p,datasets[p])
        governance.require_consent(p,datasets[p])
    baseline=np.array([.6,-.4,0,0])
    model=baseline.copy(); nonprivate=baseline.copy()
    baseline_metrics=evaluate(baseline)
    round_reports=[]
    for round_idx in range(1,rounds+1):
        signed_model=sign({'schema':'proofcollective-model/v1','weights':model.tolist(),'purpose':PURPOSE},key)
        model_payload=verify(signed_model,trusted)
        if model_payload['purpose']!=PURPOSE:
            raise GateError('Wrong signed model purpose')
        pinned_model=np.array(model_payload['weights'])
        recipe_payload={'schema':'proofcollective-recipe/v1','purpose':PURPOSE,'featureOrder':FEATURES,'modelDigest':digest(pinned_model.tolist()),'localSteps':32,'learningRate':.5,'clipNorm':1.0,'weighting':'one equal bounded contribution per partner','roundId':f'{run_id}:{round_idx}','scope':'SYNTHETIC_LOCAL_RESEARCH'}
        recipe=sign(recipe_payload,key)
        (run_dir/f'recipe-{round_idx}.json').write_text(json.dumps(recipe,indent=2)+'\n')
        (run_dir/f'input-model-{round_idx}.json').write_text(json.dumps(signed_model,indent=2)+'\n')
        agents=[]
        for i,p in enumerate(partners,1):
            def train(i=i):
                x,y=synthetic_dataset(i)
                return train_update(x,y,pinned_model,recipe,trusted)
            agents.append(LocalAgent(i,train,governance.local_consent_guard(p,datasets[p]) if transport=="local-mtls" else lambda p=p:governance.require_consent(p,datasets[p])))
        privacy=governance.reserve(campaign,f'{run_id}:{round_idx}',partners,datasets,4.0,clients)
        aggregate,protocol=secure_aggregate(agents,transport=transport)
        # Replacement adjacency: two norm-C vectors can differ by at most 2C.
        # Conservatively include both vectors' stochastic quantization L2 error.
        sensitivity=2*(1.0+protocol['quantizationL2Slack'])/protocol['contributors']
        std=privacy['noiseMultiplier']*sensitivity
        random=secrets.SystemRandom()
        noise=np.array([random.gauss(0,std) for _ in range(4)])
        model=model+aggregate+noise
        # Synthetic-only authorized ablation. Never compute/persist this for real partners.
        nonprivate_recipe=sign({**recipe_payload,'modelDigest':digest(nonprivate.tolist())},key)
        updates=[train_update(*synthetic_dataset(i),nonprivate,nonprivate_recipe,trusted) for i in range(1,clients+1)]
        nonprivate+=np.mean(updates,axis=0)
        for p in partners:
            governance.require_consent(p,datasets[p])
        round_reports.append({'round':round_idx,'privacy':privacy,'noiseStd':std,'l2Sensitivity':sensitivity,'protocol':protocol,'quality':evaluate(model)})
    candidate_metrics=evaluate(model)
    quality=release_gates(baseline_metrics,candidate_metrics)
    local_recipe=sign({**recipe_payload,'modelDigest':digest(baseline.tolist())},key)
    local_only=baseline+train_update(*synthetic_dataset(1),baseline,local_recipe,trusted)
    candidate={'schema':'proofcollective-candidate/v1','scope':'SYNTHETIC_LOCAL_RESEARCH','purpose':PURPOSE,'featureOrder':FEATURES,'model':model.tolist(),'modelSha256':digest(model.tolist()),'parentSha256':digest(baseline.tolist()),'recipeSha256':digest(recipe_payload),'datasetManifestSha256':digest(datasets),'holdoutManifestSha256':digest({'generator':'quality-v1','holdoutPartnerGroups':[100,120,140],'separateSeed':100000,'examples':3072}),'privacy':privacy,'qualityGate':quality,'evaluation':candidate_metrics,'productionReleaseAuthorized':False,'reviewStatus':'EXTERNAL_PRIVACY_SECURITY_AND_PARTNER_VALIDATION_REQUIRED','rollbackModelSha256':digest(baseline.tolist())}
    signed=sign(candidate,key);candidate_id=registry.store(signed)
    if quality['passed']:
        registry.promote_lab(candidate_id)
    report={'schema':'proofcollective-report/v1','feature':'F10','runId':run_id,'scope':'SYNTHETIC_LOCAL_MULTI_CLIENT_SIMULATION','status':'ENGINEERED','productionReleaseAuthorized':False,'independentContributors':0,'syntheticClients':clients,'rounds':round_reports,'comparisons':{'currentBaseline':baseline_metrics,'singleLocalSyntheticClient':evaluate(local_only),'federatedWithoutDpSyntheticOnly':evaluate(nonprivate),'federatedWithActualCentralDp':candidate_metrics},'qualityGate':quality,'candidateDigest':candidate_id,'candidateArtifact':f'models/{candidate_id}.json','signerPublicKey':trusted.hex(),'privacyBoundary':{'protectedUnit':'one enrolled partner contribution, replacement adjacency','coordinatorSeesPreNoiseAggregate':True,'dpProtects':'released noisy model outputs under trusted coordinator assumptions','individualUpdatesHiddenBy':'Flower SecAgg+ semi-honest protocol; this simulator owns all node memory','withdrawal':'future rounds stop; existing artifacts do not automatically forget contributions','sampling':'all selected clients; no privacy amplification claimed','maliciousClientClippingProven':False,'noiseGenerator':'OS-entropy-backed SystemRandom Gaussian floating point; specialist finite-precision review required','strongerDistributedNoise':'BLOCKED pending reviewed dropout/collusion/noise mechanism'},'openGates':['Representative consented partner-local examples and useful task baseline','20 independently enrolled contributors per released pilot aggregate','Independent secure-aggregation and DP adjacency/finite-precision/accountant review','Separately operated partner TLS/identity enrollment, key lifecycle and network attack exercise','Cross-partner and supported-camera holdout; synthetic device groups cannot qualify hardware','Poisoning evaluation against governed enrolled adversaries','Explicit separate authorization for any pilot, distribution or production release'],'elapsedSeconds':time.monotonic()-start,'environment':{'python':platform.python_version(),'flwr':importlib.metadata.version('flwr'),'dp-accounting':importlib.metadata.version('dp-accounting'),'numpy':np.__version__},'telemetry':{'rawImages':0,'labels':0,'individualUpdates':0,'partnerIdentities':'synthetic labels only in protected lab ledger'}}
    (run_dir/'report.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    (output/'latest-report.json').write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    return report


def main() -> None:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['simulate','verify'])
    parser.add_argument('--output',type=Path,default=Path('/tmp/packproof-proofcollective'))
    parser.add_argument('--clients',type=int,default=24)
    parser.add_argument('--rounds',type=int,default=2)
    parser.add_argument('--campaign',default='synthetic-quality-v1')
    parser.add_argument('--privacy-mode',choices=['central','distributed'],default='central')
    parser.add_argument('--transport',choices=['simulated','local-mtls'],default='simulated')
    parser.add_argument('--artifact',type=Path)
    parser.add_argument('--trust-key',type=Path)
    args=parser.parse_args()
    try:
        if args.command=='verify':
            if args.artifact is None or args.trust_key is None:
                raise GateError('--artifact and --trust-key are required')
            payload=verify(json.loads(args.artifact.read_text()),bytes.fromhex(args.trust_key.read_text().strip()))
            print(json.dumps({'signature':'VALID','digest':digest(payload),'scope':payload.get('scope'),'productionReleaseAuthorized':False}))
        else:
            report=run(args.output,clients=args.clients,rounds=args.rounds,campaign=args.campaign,privacy_mode=args.privacy_mode,transport=args.transport)
            print(json.dumps({'report':str(args.output/'latest-report.json'),'scope':report['scope'],'qualityGate':report['qualityGate'],'epsilon':report['rounds'][-1]['privacy']['epsilonMaxCumulative'],'elapsedSeconds':report['elapsedSeconds'],'productionReleaseAuthorized':False},indent=2))
    except (GateError,ValueError) as exc:
        parser.exit(2,f'ProofCollective gate rejected: {exc}\n')

if __name__=='__main__':
    main()
