"""Profile-bound SecAgg+ endpoint/coordinator and a separate-process synthetic lab.

This is execution engineering, not partner enrollment, an OS sandbox, distributed
noise or production release authority. The lab operator controls every local file.
No private examples, labels or individual updates cross the process control pipe.
"""
from __future__ import annotations

from contextlib import closing
from copy import deepcopy
import hashlib
import json
import logging
import multiprocessing
import os
from pathlib import Path
import random
import sqlite3
import tempfile
import time
from uuid import uuid4

import numpy as np
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from flwr.app import ConfigRecord, Context, Message, Metadata, RecordDict
from flwr.client.mod import secaggplus_mod
from flwr.common.secure_aggregation.secaggplus_constants import Key, Stage, RECORD_KEY_CONFIGS
from flwr.compat.common import recorddict_compat as compat

from .governance import GateError, Governance, MIN_CONTRIBUTORS, ModelRegistry, PURPOSE, canonical, digest, public_key, release_gates, sign, verify
from .model import FEATURES, evaluate, load_consented_local_quality, synthetic_dataset, train_update
from .mtls import TransportProfile, _claim_session, create_lab_pki, load_transport_profile, pin_certificate
from .protocol import LocalAgent, _run_aggregate

BINDING_RECORD='packproof-research-binding'
RELEASE_RECORD='packproof-research-release-check'
SCOPE='SYNTHETIC_LOCAL_RESEARCH'
STARTUP_SECONDS=90
ENDPOINT_SECONDS=300


def _enrollment(profile:TransportProfile) -> dict:
    return {'coordinatorCertificateSha256':profile.coordinator_pin,'peers':[{'nodeId':p.node_id,'host':p.host,'port':p.port,'serverName':p.server_name,'certificateSha256':p.certificate_sha256} for _,p in sorted(profile.peers.items())]}


def _json(path:Path) -> dict:
    if path.stat().st_size>65536:
        raise GateError('Run configuration exceeds its byte limit')
    return json.loads(path.read_text())


def _private_directory(path:Path) -> None:
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    if path.is_symlink() or not path.is_dir() or path.stat().st_mode&0o077:
        raise GateError('Lab state requires a private directory')


class RunArtifacts:
    """Same pinned, signed input model/recipe and exact cohort on every endpoint."""
    def __init__(self,signed_model:dict,signed_recipe:dict,trusted_key:bytes,profile:TransportProfile):
        model=verify(signed_model,trusted_key)
        recipe=verify(signed_recipe,trusted_key)
        if model.get('schema')!='proofcollective-model/v1' or model.get('purpose')!=PURPOSE or model.get('scope')!=SCOPE:
            raise GateError('Signed input model scope rejected')
        self.weights=np.asarray(model.get('weights'),dtype=np.float64)
        if self.weights.shape!=(4,) or not np.isfinite(self.weights).all():
            raise GateError('Signed input model bounds rejected')
        if recipe.get('schema')!='proofcollective-recipe/v1' or recipe.get('purpose')!=PURPOSE or recipe.get('scope')!=SCOPE or recipe.get('featureOrder')!=FEATURES or recipe.get('weighting')!='equal-partner':
            raise GateError('Signed recipe scope or weighting rejected')
        if type(recipe.get('runId')) is not int or recipe['runId']!=profile.run_id or recipe.get('modelDigest')!=digest(self.weights.tolist()) or recipe.get('inputModelArtifactDigest')!=digest(model):
            raise GateError('Signed recipe run/model binding rejected')
        self.enrollment_digest=digest(_enrollment(profile))
        if recipe.get('transportEnrollmentSha256')!=self.enrollment_digest:
            raise GateError('Signed transport enrollment binding rejected')
        if not isinstance(recipe.get('roundId'),str) or not 1<=len(recipe['roundId'])<=128:
            raise GateError('Signed round identity rejected')
        if type(recipe.get('localSteps')) is not int or not 1<=recipe['localSteps']<=64 or type(recipe.get('learningRate')) not in (int,float) or not 0<recipe['learningRate']<=1 or type(recipe.get('clipNorm')) not in (int,float) or not 0<recipe['clipNorm']<=1:
            raise GateError('Signed training bounds rejected')
        roster=recipe.get('participants')
        if not isinstance(roster,list) or not MIN_CONTRIBUTORS<=len(roster)<=64:
            raise GateError('Signed cohort requires 20..64 participants')
        self.participants={};partners=set()
        for item in roster:
            if not isinstance(item,dict) or set(item)!={'nodeId','partnerId','datasetSha256'}:
                raise GateError('Signed participant record rejected')
            node=item['nodeId'];partner=item['partnerId'];dataset=item['datasetSha256']
            if type(node) is not int or node not in profile.peers or node in self.participants or not isinstance(partner,str) or not 1<=len(partner)<=128 or partner in partners or not isinstance(dataset,str) or len(dataset)!=64 or any(c not in '0123456789abcdef' for c in dataset):
                raise GateError('Signed participant/dataset binding rejected')
            self.participants[node]=item;partners.add(partner)
        if set(self.participants)!=set(profile.peers):
            raise GateError('Signed cohort differs from enrolled TLS roster')
        self.run_id=profile.run_id
        self.roster=set(profile.peers)
        self.recipe=recipe;self.signed_recipe=signed_recipe;self.trusted_key=trusted_key
        self.binding={'recipeSha256':digest(recipe),'modelSha256':digest(model),'runId':profile.run_id}

    def check_profile(self,profile:TransportProfile) -> None:
        if profile.run_id!=self.run_id or set(profile.peers)!=self.roster or digest(_enrollment(profile))!=self.enrollment_digest:
            raise GateError('Run artifacts do not match transport profile')


class PartnerEndpoint:
    """Persistent Flower context for one admitted run; no restart of partial state.

    The caller supplies its own validated transport profile and local consent/data
    paths. Lab setup is separate from this reusable endpoint implementation.
    """
    def __init__(self,profile:TransportProfile,artifacts:RunArtifacts,dataset:Path,consent_ledger:Path):
        artifacts.check_profile(profile)
        if profile.node_id not in artifacts.participants:
            raise GateError('Local participant absent from signed cohort')
        self.profile=profile;self.artifacts=artifacts;self.dataset=dataset
        entry=artifacts.participants[profile.node_id]
        self.partner=entry['partnerId'];self.dataset_digest=entry['datasetSha256']
        # Read-only connection per request keeps cross-process withdrawal current.
        self.ledger=consent_ledger.resolve()
        self.context=Context(profile.run_id,profile.node_id,{},RecordDict(),{})
        self.completed=False;self.release_checked=False
        self.check_consent()
        self.agent=LocalAgent(profile.node_id,self.train,self.check_consent)
        self.server=profile.server(self.respond)

    def require_consent(self,partner:str,dataset:str) -> None:
        if partner!=self.partner or dataset!=self.dataset_digest:
            raise GateError('Local dataset differs from signed exact-byte consent')
        self.check_consent()

    def check_consent(self) -> None:
        with closing(sqlite3.connect(self.ledger.as_uri()+'?mode=ro',uri=True,timeout=5)) as db:
            db.row_factory=sqlite3.Row
            Governance._require_consent(db,self.partner,self.dataset_digest,PURPOSE)

    def train(self):
        x,y=load_consented_local_quality(self.dataset,self.partner,self)
        update=train_update(x,y,self.artifacts.weights,self.artifacts.signed_recipe,self.artifacts.trusted_key)
        self.check_consent()
        return update

    def respond(self,message:Message) -> Message:
        if message.metadata.group_id!=self.artifacts.recipe['roundId'] or dict(message.content.config_records.get(BINDING_RECORD,{}))!=self.artifacts.binding:
            raise GateError('Protocol message signed run binding rejected')
        self.check_consent()
        if self.release_checked:
            raise GateError('Participant run is already closed')
        if RELEASE_RECORD in message.content.config_records:
            check=dict(message.content.config_records[RELEASE_RECORD])
            candidate=check.get('candidateSha256')
            if not self.completed or set(check)!={'candidateSha256'} or not isinstance(candidate,str) or len(candidate)!=64 or any(c not in '0123456789abcdef' for c in candidate):
                raise GateError('Final consent checkpoint requires a completed bound run')
            content=RecordDict({RELEASE_RECORD:ConfigRecord({'candidateSha256':candidate,'consentCurrent':True})})
            self.release_checked=True
        else:
            # Flower consumes Key.STAGE from the incoming ConfigRecord in place.
            stage=message.content.config_records[RECORD_KEY_CONFIGS][Key.STAGE]
            try:
                reply=secaggplus_mod(message,self.context,self.agent.fit)
            except Exception as exc:
                raise GateError('Flower participant protocol rejected') from exc
            content=reply.content
            if stage==Stage.UNMASK:self.completed=True
        self.check_consent()
        metadata=Metadata(self.profile.run_id,str(uuid4()),self.profile.node_id,0,message.metadata.message_id,message.metadata.group_id,time.time(),60,'train')
        return Message(content=content,metadata=metadata)

    def close(self):
        self.server.close()


class ProfileGrid:
    """Coordinator speaks only authenticated Flower frames to enrolled endpoints.

    Any transport failure aborts the entire round. This conservative policy does not
    treat a rejected consent or identity as an ordinary dropout and then release.
    """
    def __init__(self,profile:TransportProfile,artifacts:RunArtifacts):
        artifacts.check_profile(profile)
        self.client=profile.client();self.run_id=profile.run_id;self.artifacts=artifacts;self.transcript=[]

    def send_and_receive(self,messages,*,timeout=None):
        messages=list(messages);replies=[];stage=None
        # Global stage deadline supplements each bounded TLS connect/frame deadline.
        deadline=time.monotonic()+min(30,float(timeout or 30))
        for outgoing in messages:
            if time.monotonic()>=deadline:
                raise GateError('Protocol stage deadline exceeded')
            node=outgoing.metadata.dst_node_id
            stage=outgoing.content.config_records[RECORD_KEY_CONFIGS][Key.STAGE]
            content=deepcopy(outgoing.content)
            content.config_records[BINDING_RECORD]=ConfigRecord(self.artifacts.binding)
            metadata=Metadata(self.run_id,str(uuid4()),0,node,'',self.artifacts.recipe['roundId'],time.time(),60,'train')
            reply=self.client.exchange(node,Message(content=content,metadata=metadata))
            if time.monotonic()>=deadline:
                raise GateError('Protocol stage deadline exceeded')
            if stage==Stage.COLLECT_MASKED_VECTORS:
                if any(len(a)>0 for a in reply.content.array_records.values()) or compat.recorddict_to_fitres(reply.content,True).metrics:
                    raise GateError('Individual update or client telemetry rejected')
            replies.append(reply)
        self.transcript.append({'stage':stage,'requested':len(messages),'received':len(replies)})
        return replies

    def transport_report(self):
        return {'transport':'TLS 1.3 mutual authentication + pinned profile/node/run bindings; separate endpoints','tlsConnections':self.client.connections}

    def final_consent_checkpoint(self,candidate_sha256:str):
        deadline=time.monotonic()+30
        for node in self.artifacts.participants:
            if time.monotonic()>=deadline:raise GateError('Final consent checkpoint deadline exceeded')
            content=RecordDict({BINDING_RECORD:ConfigRecord(self.artifacts.binding),RELEASE_RECORD:ConfigRecord({'candidateSha256':candidate_sha256})})
            metadata=Metadata(self.run_id,str(uuid4()),0,node,'',self.artifacts.recipe['roundId'],time.time(),60,'train')
            reply=self.client.exchange(node,Message(content=content,metadata=metadata))
            if time.monotonic()>=deadline:raise GateError('Final consent checkpoint deadline exceeded')
            if dict(reply.content.config_records.get(RELEASE_RECORD,{}))!={'candidateSha256':candidate_sha256,'consentCurrent':True}:
                raise GateError('Authenticated final participant consent checkpoint rejected')


def coordinate(profile:TransportProfile,artifacts:RunArtifacts,governance:Governance,authority:Ed25519PrivateKey,output:Path,*,campaign:str='separate-process-lab') -> dict:
    """One non-resumable round; candidate only after budget, protocol and consent gates.

    Does not launch endpoints, grant consent, access partner datasets, or promote a
    model. This reusable path uses configured profiles; the lab wrapper is loopback.
    """
    if profile.node_id!=0 or public_key(authority)!=artifacts.trusted_key:
        raise GateError('Pinned coordinator/signing authority required')
    artifacts.check_profile(profile)
    _claim_session(profile.admission_ledger,0,profile.run_id)
    output.mkdir(mode=0o700,parents=True,exist_ok=False)
    entries=list(artifacts.participants.values())
    partners=[p['partnerId'] for p in entries];datasets={p['partnerId']:p['datasetSha256'] for p in entries}
    privacy=governance.reserve(campaign,artifacts.recipe['roundId'],partners,datasets,4.0,len(entries))
    agents=[LocalAgent(p['nodeId'],None,governance.local_consent_guard(p['partnerId'],p['datasetSha256'])) for p in entries]
    grid=ProfileGrid(profile,artifacts)
    aggregate,protocol=_run_aggregate(agents,grid,artifacts.recipe['clipNorm'])
    sensitivity=2*(artifacts.recipe['clipNorm']+protocol['quantizationL2Slack'])/protocol['contributors']
    noise=np.array([random.SystemRandom().gauss(0,4.0*sensitivity) for _ in aggregate])
    weights=artifacts.weights+aggregate+noise
    for agent in agents:agent.check_consent()
    candidate_evaluation=evaluate(weights)
    quality=release_gates(evaluate(artifacts.weights),candidate_evaluation)
    payload={'schema':'proofcollective-candidate/v1','purpose':PURPOSE,'scope':SCOPE,'featureOrder':FEATURES,'model':weights.tolist(),'modelSha256':digest(weights.tolist()),'parentSha256':digest(artifacts.weights.tolist()),'datasetManifestSha256':digest(datasets),'holdoutManifestSha256':digest({'generator':'quality-v1','holdoutPartnerGroups':[100,120,140],'separateSeed':100000,'examples':3072}),'privacy':privacy,'qualityGate':quality,'evaluation':candidate_evaluation,'recipeSha256':digest(artifacts.recipe),'productionReleaseAuthorized':False,'reviewStatus':'EXTERNAL_PRIVACY_SECURITY_AND_PARTNER_VALIDATION_REQUIRED','rollbackModelSha256':digest(artifacts.weights.tolist())}
    signed=sign(payload,authority)
    grid.final_consent_checkpoint(digest(payload))
    # Last fresh consent gate immediately precedes the only candidate write.
    for agent in agents:agent.check_consent()
    registry=ModelRegistry(output/'models',artifacts.trusted_key)
    try:
        candidate_id=registry.store(signed)
    finally:registry.db.close()
    # Deliberately no promotion. Existing signature/quality/privacy promotion and
    # rollback gates remain available for separately reviewed laboratory action.
    report={'schema':'proofcollective-process-lab/v1','runId':profile.run_id,'scope':SCOPE,'independentOrganizations':0,'productionReleaseAuthorized':False,'modelPromoted':False,'privacyMode':'central; coordinator sees pre-noise aggregate','privacy':privacy,'qualityGate':quality,'protocol':protocol,'finalConsentCheckpoints':len(entries),'tlsConnectionsIncludingCheckpoints':grid.client.connections,'candidateDigest':candidate_id,'candidateArtifact':f'models/{candidate_id}.json','candidateSha256':hashlib.sha256(canonical(signed)).hexdigest()}
    (output/'report.json').write_bytes(canonical(report))
    return report


def _partner_process(configuration:Path,ready,stop):
    """Child IPC reports readiness only. Flower content travels exclusively over TLS."""
    endpoint=None
    try:
        logging.getLogger('flwr').setLevel(logging.ERROR)
        config=_json(configuration)
        profile=load_transport_profile(Path(config['profile']))
        artifacts=RunArtifacts(_json(Path(config['model'])),_json(Path(config['recipe'])),bytes.fromhex(config['trustKey']),profile)
        endpoint=PartnerEndpoint(profile,artifacts,Path(config['dataset']),Path(config['consentLedger']))
        ready.send({'status':'ready','nodeId':profile.node_id,'pid':os.getpid()})
        deadline=time.monotonic()+ENDPOINT_SECONDS
        while not stop.value and time.monotonic()<deadline:time.sleep(.1)
    except Exception:
        # Fixed diagnostics: never export exception content, data, keys or updates.
        ready.send({'status':'rejected'})
    finally:
        if endpoint is not None:endpoint.close()
        ready.close()


class PartnerProcesses:
    def __init__(self,configurations:list[Path]):
        if not MIN_CONTRIBUTORS<=len(configurations)<=64:
            raise GateError('Process cohort must contain 20..64 endpoints')
        # Forkserver imports only code/dependencies, not caller data/keys/DB handles.
        # Copy-on-write imports bound memory on Linux. This is not an OS sandbox.
        method='forkserver' if 'forkserver' in multiprocessing.get_all_start_methods() else 'spawn'
        self.context=multiprocessing.get_context(method)
        if method=='forkserver':self.context.set_forkserver_preload(['proofcollective.process_runner'])
        # One-writer byte signal: unlike Event/Condition, it has no waiter lock that
        # a killed endpoint can strand and deadlock the parent's cleanup path.
        self.stop=self.context.RawValue('b',False);self.processes=[];self.readiness=[];self.pipes=[]
        deadline=time.monotonic()+STARTUP_SECONDS
        try:
            for configuration in configurations:
                reader,writer=self.context.Pipe(duplex=False)
                self.pipes.append(reader)
                process=self.context.Process(target=_partner_process,args=(configuration,writer,self.stop))
                try:
                    process.start();self.processes.append(process)
                finally:writer.close()
            for reader in self.pipes:
                if not reader.poll(max(0,deadline-time.monotonic())):
                    raise GateError('Partner process startup deadline exceeded')
                result=reader.recv()
                if result.get('status')!='ready':raise GateError('Partner process admission rejected')
                self.readiness.append(result)
            if len({p['pid'] for p in self.readiness})!=len(configurations) or os.getpid() in {p['pid'] for p in self.readiness}:
                raise GateError('Distinct partner processes required')
        except Exception:
            self.close();raise

    def close(self):
        self.stop.value=True;deadline=time.monotonic()+8
        for process in self.processes:process.join(max(0,deadline-time.monotonic()))
        for process in self.processes:
            if process.is_alive():process.terminate()
        for process in self.processes:process.join(2)
        for process in self.processes:
            if process.is_alive():process.kill();process.join(2)
        for reader in self.pipes:reader.close()
        if any(p.is_alive() for p in self.processes):raise GateError('Partner process cleanup failed')


def prepare_lab(root:Path,temporary:Path,run_id:int,clients:int=20) -> tuple[Path,list[Path],Ed25519PrivateKey]:
    """Generate explicitly synthetic fixtures, never enrollment of real partners."""
    if type(run_id) is not int or not 1<=run_id<2**63 or type(clients) is not int or not MIN_CONTRIBUTORS<=clients<=64:
        raise GateError('Invalid bounded lab run/cohort')
    _private_directory(root);_private_directory(temporary)
    governance=Governance(root/'privacy-ledger.sqlite')
    authority=Ed25519PrivateKey.generate();trusted=public_key(authority)
    nodes=list(range(1,clients+1));identities=create_lab_pki(temporary/'pki',nodes)
    participants=[];ports=[]
    # Reserve loopback ports until the roster is complete, then endpoints bind them.
    # A local competing process can cause startup failure, never bypass TLS pinning.
    import socket
    sockets=[]
    try:
        for _ in [0,*nodes]:
            sock=socket.socket();sock.bind(('127.0.0.1',0));sockets.append(sock);ports.append(sock.getsockname()[1])
    finally:
        for sock in sockets:sock.close()
    try:
        for node in nodes:
            local=root/f'node-{node}';_private_directory(local)
            path=local/'synthetic-quality.npz'
            provenance=local/'synthetic-provenance.json'
            partner=f'synthetic-partner-{node:02d}'
            fresh=not path.exists()
            if fresh:
                if provenance.exists() or governance.db.execute('SELECT 1 FROM consents WHERE partner=?',(partner,)).fetchone():
                    raise GateError('Existing synthetic enrollment requires intact dataset/provenance')
                x,y=synthetic_dataset(node)
                with path.open('xb') as handle:
                    np.savez(handle,sharpness=(x[:,0]+1)*500,glare_fraction=(x[:,1]+1)/2,contrast=(x[:,2]+1)/2,usable=y)
            dataset=hashlib.sha256(path.read_bytes()).hexdigest()
            expected={'generator':'quality-v1','partner':node,'sha256':dataset,'scope':SCOPE}
            if fresh:
                with provenance.open('xb') as handle:handle.write(canonical(expected))
                governance.consent(partner,dataset)
            elif not provenance.is_file() or _json(provenance)!=expected:
                raise GateError('Existing dataset lacks exact synthetic lab provenance')
            governance.require_consent(partner,dataset)
            participants.append({'nodeId':node,'partnerId':partner,'datasetSha256':dataset})
    finally:
        governance.db.close()
    coordinator_pin=pin_certificate(identities[0].certificate)
    peers=[{'nodeId':node,'host':'127.0.0.1','port':ports[node],'serverName':'localhost','certificateSha256':pin_certificate(identities[node].certificate)} for node in nodes]
    model={'schema':'proofcollective-model/v1','purpose':PURPOSE,'scope':SCOPE,'weights':[.6,-.4,0.,0.]}
    recipe={'schema':'proofcollective-recipe/v1','purpose':PURPOSE,'scope':SCOPE,'featureOrder':FEATURES,'modelDigest':digest(model['weights']),'inputModelArtifactDigest':digest(model),'transportEnrollmentSha256':digest({'coordinatorCertificateSha256':coordinator_pin,'peers':peers}),'localSteps':32,'learningRate':.5,'clipNorm':1.,'weighting':'equal-partner','runId':run_id,'roundId':f'process-lab-{run_id}','participants':participants}
    (temporary/'model.json').write_bytes(canonical(sign(model,authority)))
    (temporary/'recipe.json').write_bytes(canonical(sign(recipe,authority)))
    (temporary/'trust-key.hex').write_text(trusted.hex())
    configs=[]
    for node in [0,*nodes]:
        state=root/'coordinator' if node==0 else root/f'node-{node}';_private_directory(state)
        identity=identities[node]
        profile={'schema':'proofcollective-mtls-profile/v1','scope':'RESEARCH_ONLY','productionReleaseAuthorized':False,'purpose':PURPOSE,'expiresAtUnix':time.time()+600,'runId':run_id,'localNodeId':node,'identity':{'certificate':str(identity.certificate),'privateKey':str(identity.private_key),'ca':str(identity.ca)},'coordinatorCertificateSha256':pin_certificate(identities[0].certificate),'peers':peers,'bind':{'host':'127.0.0.1','port':ports[node]},'admissionLedger':str(state/'admission.sqlite')}
        profile_path=temporary/f'profile-{node}.json';profile_path.write_bytes(canonical(profile))
        if node:
            config={'profile':str(profile_path),'model':str(temporary/'model.json'),'recipe':str(temporary/'recipe.json'),'trustKey':trusted.hex(),'dataset':str(state/'synthetic-quality.npz'),'consentLedger':str(root/'privacy-ledger.sqlite')}
            config_path=temporary/f'endpoint-{node}.json';config_path.write_bytes(canonical(config));configs.append(config_path)
    return temporary/'profile-0.json',configs,authority


def run_process_lab(root:Path,run_id:int,clients:int=20) -> dict:
    """One local operator, synthetic data, actual child processes and TLS only."""
    root=root.resolve()
    with tempfile.TemporaryDirectory(prefix='proofcollective-process-lab-') as scratch:
        temporary=Path(scratch)
        profile_path,configs,authority=prepare_lab(root,temporary,run_id,clients)
        profile=load_transport_profile(profile_path)
        artifacts=RunArtifacts(_json(temporary/'model.json'),_json(temporary/'recipe.json'),public_key(authority),profile)
        governance=Governance(root/'privacy-ledger.sqlite')
        processes=None
        try:
            processes=PartnerProcesses(configs)
            report=coordinate(profile,artifacts,governance,authority,root/f'run-{run_id}')
            report['execution']={'partnerProcesses':len(processes.readiness),'distinctProcessIdsVerified':True,'operatorCount':1,'isolation':'separate process memory; same local operator/filesystem; not an OS sandbox'}
            destination=root/f'run-{run_id}'
            for name in ('model.json','recipe.json','trust-key.hex'):(destination/name).write_bytes((temporary/name).read_bytes())
            (destination/'report.json').write_bytes(canonical(report))
            return report
        finally:
            governance.db.close()
            if processes is not None:processes.close()
