"""Separate endpoint processes, actual TLS/SecAgg+ and fail-closed governance.

These are synthetic local operators, never independently enrolled organizations.
POSIX execution is required by the existing private-file TLS/admission controls.
"""
from copy import deepcopy
import json
import multiprocessing
import os
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from flwr.app import ConfigRecord, Message, Metadata, RecordDict
from flwr.common.secure_aggregation.secaggplus_constants import Key, Stage, RECORD_KEY_CONFIGS

from proofcollective.governance import GateError, Governance, ModelRegistry, PURPOSE, digest, public_key, sign, verify
from proofcollective.model import FEATURES
from proofcollective.mtls import Peer, load_transport_profile
from proofcollective.process_runner import (
    BINDING_RECORD, SCOPE, PartnerEndpoint, PartnerProcesses, ProfileGrid, RunArtifacts,
    _enrollment, coordinate, prepare_lab, run_process_lab,
)
import proofcollective.process_runner as runner

posix=pytest.mark.skipif(os.name!='posix',reason='Existing TLS private-file controls require POSIX; Linux CI executes this case')


def signed_inputs():
    authority=Ed25519PrivateKey.generate()
    model={'schema':'proofcollective-model/v1','purpose':PURPOSE,'scope':SCOPE,'weights':[.6,-.4,0.,0.]}
    recipe={'schema':'proofcollective-recipe/v1','purpose':PURPOSE,'scope':SCOPE,'featureOrder':FEATURES,'weighting':'equal-partner','runId':7,'roundId':'round-seven','localSteps':32,'learningRate':.5,'clipNorm':1.,'modelDigest':digest(model['weights']),'inputModelArtifactDigest':digest(model),'participants':[{'nodeId':i,'partnerId':f'synthetic-{i}','datasetSha256':digest({'fixture':i})} for i in range(1,21)]}
    profile=SimpleNamespace(run_id=7,coordinator_pin='0'*64,peers={i:Peer(i,'127.0.0.1',20000+i,'localhost',f'{i:064x}') for i in range(1,21)})
    recipe['transportEnrollmentSha256']=digest(_enrollment(profile))
    return authority,model,recipe,profile


@pytest.mark.parametrize('change',[
    lambda m,r:r.update(runId=8),
    lambda m,r:r.update(scope='PRODUCTION'),
    lambda m,r:r.update(purpose='different-purpose'),
    lambda m,r:r.update(modelDigest='0'*64),
    lambda m,r:r.update(inputModelArtifactDigest='0'*64),
    lambda m,r:r.update(weighting='sample-count'),
    lambda m,r:r.update(localSteps=65),
    lambda m,r:r.update(clipNorm=float('inf')),
    lambda m,r:r.update(participants=r['participants'][:19]),
    lambda m,r:r['participants'][-1].update(nodeId=1),
    lambda m,r:r['participants'][-1].update(partnerId='synthetic-1'),
    lambda m,r:r['participants'][-1].update(datasetSha256='../dataset'),
    lambda m,r:m.update(scope='PRODUCTION'),
])
def test_signed_governed_binding_rejects_incompatible_authorized_payload(change):
    authority,model,recipe,profile=signed_inputs()
    change(model,recipe)
    # Non-finite signed JSON is rejected at canonicalization, before transport too.
    with pytest.raises((GateError,ValueError)):
        RunArtifacts(sign(model,authority),sign(recipe,authority),public_key(authority),profile)


def test_signature_and_exact_enrolled_roster_and_input_model_are_required():
    authority,model,recipe,profile=signed_inputs()
    signed_model=sign(model,authority);signed_recipe=sign(recipe,authority)
    accepted=RunArtifacts(signed_model,signed_recipe,public_key(authority),profile)
    assert accepted.binding['runId']==7 and len(accepted.participants)==20
    changed=deepcopy(signed_recipe);changed['payload']['localSteps']=1
    with pytest.raises(GateError):RunArtifacts(signed_model,changed,public_key(authority),profile)
    with pytest.raises(GateError):RunArtifacts(signed_model,signed_recipe,public_key(Ed25519PrivateKey.generate()),profile)
    profile.peers[21]=Peer(21,'127.0.0.1',20021,'localhost',f'{21:064x}')
    with pytest.raises(GateError,match='enrollment binding'):RunArtifacts(signed_model,signed_recipe,public_key(authority),profile)


@pytest.mark.parametrize('field',['certificate','coordinator','host','port','run'])
def test_same_node_ids_cannot_rebind_enrollment_after_artifact_admission(field):
    authority,model,recipe,profile=signed_inputs()
    accepted=RunArtifacts(sign(model,authority),sign(recipe,authority),public_key(authority),profile)
    changed=deepcopy(profile)
    if field=='coordinator':changed.coordinator_pin='f'*64
    elif field=='run':changed.run_id+=1
    else:
        peer=changed.peers[1]
        changed.peers[1]=Peer(1,'127.0.0.2' if field=='host' else peer.host,20002 if field=='port' else peer.port,peer.server_name,'f'*64 if field=='certificate' else peer.certificate_sha256)
    with pytest.raises(GateError,match='transport profile'):accepted.check_profile(changed)


def test_protocol_binding_denied_before_any_flower_or_consent_work():
    authority,model,recipe,profile=signed_inputs()
    endpoint=object.__new__(PartnerEndpoint)
    endpoint.artifacts=RunArtifacts(sign(model,authority),sign(recipe,authority),public_key(authority),profile)
    endpoint.check_consent=lambda:pytest.fail('Wrong recipe must fail before local processing')
    message=Message(content=RecordDict({BINDING_RECORD:ConfigRecord(dict(endpoint.artifacts.binding,runId=8))}),metadata=Metadata(7,'message',0,1,'','round-seven',1.,60,'train'))
    with pytest.raises(GateError,match='signed run binding'):endpoint.respond(message)


def test_process_roster_rejects_nineteen_before_starting_any_child():
    with pytest.raises(GateError,match='20..64'):PartnerProcesses([Path('unused')]*19)


def test_final_exchange_cannot_be_accepted_after_stage_deadline(monkeypatch):
    authority,model,recipe,profile=signed_inputs()
    grid=object.__new__(ProfileGrid);grid.run_id=7;grid.transcript=[]
    grid.artifacts=RunArtifacts(sign(model,authority),sign(recipe,authority),public_key(authority),profile)
    grid.client=SimpleNamespace(exchange=lambda *args:Message(content=RecordDict(),reply_to=args[1]))
    clock=iter([0.,0.,31.])
    monkeypatch.setattr(runner,'time',SimpleNamespace(monotonic=lambda:next(clock),time=lambda:1.))
    message=Message(content=RecordDict({RECORD_KEY_CONFIGS:ConfigRecord({Key.STAGE:Stage.SETUP})}),metadata=Metadata(7,'message',0,1,'','round-seven',1.,60,'train'))
    with pytest.raises(GateError,match='stage deadline'):grid.send_and_receive([message],timeout=30)
    assert not grid.transcript


def test_process_start_failure_closes_both_control_pipe_ends(monkeypatch):
    closed=[]
    reader=SimpleNamespace(close=lambda:closed.append('reader'))
    writer=SimpleNamespace(close=lambda:closed.append('writer'))
    def fail_start():raise OSError('Synthetic process startup failure')
    context=SimpleNamespace(Event=lambda:SimpleNamespace(set=lambda:None),Pipe=lambda **kwargs:(reader,writer),Process=lambda **kwargs:SimpleNamespace(start=fail_start),set_forkserver_preload=lambda modules:None)
    monkeypatch.setattr(runner.multiprocessing,'get_context',lambda method:context)
    with pytest.raises(OSError,match='startup failure'):PartnerProcesses([Path('unused')]*20)
    assert sorted(closed)==['reader','writer']


def _prepared(tmp_path,run_id=1):
    root=tmp_path/'state';scratch=tmp_path/f'scratch-{run_id}'
    profile_path,configs,authority=prepare_lab(root,scratch,run_id,20)
    profile=load_transport_profile(profile_path)
    artifacts=RunArtifacts(json.loads((scratch/'model.json').read_text()),json.loads((scratch/'recipe.json').read_text()),public_key(authority),profile)
    governance=Governance(root/'privacy-ledger.sqlite')
    return root,scratch,configs,authority,profile,artifacts,governance


@posix
def test_actual_twenty_processes_tls_secagg_and_monotonic_fresh_restart(tmp_path):
    root=tmp_path/'lab'
    first=run_process_lab(root,1,20)
    assert first['execution']['partnerProcesses']==20 and first['execution']['distinctProcessIdsVerified']
    assert first['protocol']['contributors']==20 and first['protocol']['tlsConnections']==80
    assert [stage['received'] for stage in first['protocol']['stages']]==[20]*4
    assert first['independentOrganizations']==0 and first['modelPromoted'] is False and first['productionReleaseAuthorized'] is False
    candidate_path=root/'run-1'/first['candidateArtifact']
    candidate_bytes=candidate_path.read_bytes()
    candidate=json.loads(candidate_bytes)
    verified=verify(candidate,bytes.fromhex((root/'run-1'/'trust-key.hex').read_text()))
    assert set(verified)=={'schema','scope','purpose','featureOrder','model','modelSha256','parentSha256','recipeSha256','datasetManifestSha256','holdoutManifestSha256','privacy','qualityGate','evaluation','productionReleaseAuthorized','reviewStatus','rollbackModelSha256'}
    assert len(verified['model'])==4 and verified['privacy']['epsilonMaxCumulative']<=3
    assert first['finalConsentCheckpoints']==20 and first['tlsConnectionsIncludingCheckpoints']==100
    registry=ModelRegistry(root/'run-1'/'models',bytes.fromhex((root/'run-1'/'trust-key.hex').read_text()))
    try:
        assert registry.get(first['candidateDigest'])==verified and registry.active is None
        if not verified['qualityGate']['passed']:
            with pytest.raises(GateError,match='release gate'):registry.promote_lab(first['candidateDigest'])
    finally:registry.db.close()
    assert not any(p.is_alive() and p.name!='SyncManager' for p in multiprocessing.active_children())
    # Endpoints, not only the coordinator, consume persistent admission IDs.
    with pytest.raises(GateError,match='admission rejected'):run_process_lab(root,1,20)
    second=run_process_lab(root,2,20)
    assert second['privacy']['epsilonMaxCumulative']>first['privacy']['epsilonMaxCumulative']
    assert candidate_path.read_bytes()==candidate_bytes


@posix
def test_real_process_withdrawal_after_masked_collection_aborts_before_unmask(tmp_path,monkeypatch):
    root,scratch,configs,authority,profile,artifacts,governance=_prepared(tmp_path)
    processes=PartnerProcesses(configs)
    original=ProfileGrid.send_and_receive;stages=[]
    def withdrawing(self,messages,**kwargs):
        replies=original(self,messages,**kwargs)
        stage=self.transcript[-1]['stage'];stages.append(stage)
        if stage==Stage.COLLECT_MASKED_VECTORS:governance.withdraw('synthetic-partner-01')
        return replies
    monkeypatch.setattr(ProfileGrid,'send_and_receive',withdrawing)
    try:
        with pytest.raises(GateError,match='withdrawn'):coordinate(profile,artifacts,governance,authority,root/'candidate-run')
        assert Stage.COLLECT_MASKED_VECTORS in stages and Stage.UNMASK not in stages
        assert not (root/'candidate-run'/'models').exists()
        assert governance.db.execute('SELECT COUNT(*) FROM spend').fetchone()[0]==20
    finally:processes.close();governance.db.close()
    assert not any(p.is_alive() for p in processes.processes)


@posix
def test_killed_endpoint_cannot_resume_partial_run_and_unavailability_aborts(tmp_path,monkeypatch):
    root,scratch,configs,authority,profile,artifacts,governance=_prepared(tmp_path)
    processes=PartnerProcesses(configs)
    original=ProfileGrid.send_and_receive;stages=[]
    def killing(self,messages,**kwargs):
        replies=original(self,messages,**kwargs)
        stage=self.transcript[-1]['stage'];stages.append(stage)
        if stage==Stage.SETUP:
            processes.processes[0].terminate();processes.processes[0].join(3)
            config=json.loads(configs[0].read_text())
            participant_profile=load_transport_profile(Path(config['profile']))
            with pytest.raises(GateError,match='fresh increasing run'):
                PartnerEndpoint(participant_profile,artifacts,Path(config['dataset']),Path(config['consentLedger']))
        return replies
    monkeypatch.setattr(ProfileGrid,'send_and_receive',killing)
    try:
        with pytest.raises(GateError,match='TLS exchange rejected'):coordinate(profile,artifacts,governance,authority,root/'candidate-run')
        assert stages==[Stage.SETUP]
        assert not (root/'candidate-run'/'models').exists()
        assert governance.db.execute('SELECT COUNT(*) FROM spend').fetchone()[0]==20
    finally:processes.close();governance.db.close()


@posix
def test_exhausted_privacy_never_constructs_transport_or_writes_candidate(tmp_path,monkeypatch):
    root,scratch,configs,authority,profile,artifacts,governance=_prepared(tmp_path)
    partners=[p['partnerId'] for p in artifacts.participants.values()]
    datasets={p['partnerId']:p['datasetSha256'] for p in artifacts.participants.values()}
    for i in range(100):
        try:governance.reserve('prior-campaign',f'prior-{i}',partners,datasets,4.,20)
        except GateError:break
    else:pytest.fail('Budget must be finite')
    monkeypatch.setattr('proofcollective.process_runner.ProfileGrid',lambda *args:pytest.fail('Budget must precede transport'))
    try:
        with pytest.raises(GateError,match='privacy budget exhausted'):coordinate(profile,artifacts,governance,authority,root/'candidate-run')
        assert not (root/'candidate-run'/'models').exists()
    finally:governance.db.close()


@posix
def test_exact_dataset_bytes_rechecked_by_participant_at_training(tmp_path):
    root,scratch,configs,authority,profile,artifacts,governance=_prepared(tmp_path)
    config=json.loads(configs[0].read_text());participant_profile=load_transport_profile(Path(config['profile']))
    endpoint=PartnerEndpoint(participant_profile,artifacts,Path(config['dataset']),Path(config['consentLedger']))
    try:
        legitimate=endpoint.train()
        assert np.linalg.norm(legitimate)<=1
        Path(config['dataset']).write_bytes(Path(config['dataset']).read_bytes()+b'altered')
        with pytest.raises(GateError,match='exact-byte consent'):endpoint.train()
        governance.withdraw('synthetic-partner-01')
        with pytest.raises(GateError,match='withdrawn'):endpoint.check_consent()
    finally:endpoint.close();governance.db.close()


@posix
def test_partner_local_withdrawal_after_unmask_denies_final_authenticated_checkpoint(tmp_path,monkeypatch):
    root,scratch,configs,authority,profile,artifacts,governance=_prepared(tmp_path)
    config=json.loads(configs[0].read_text());local_ledger=root/'node-1'/'local-consent.sqlite'
    local=Governance(local_ledger)
    entry=artifacts.participants[1]
    local.consent(entry['partnerId'],entry['datasetSha256'])
    config['consentLedger']=str(local_ledger);configs[0].write_text(json.dumps(config))
    processes=PartnerProcesses(configs);original=ProfileGrid.send_and_receive;stages=[]
    def withdrawing(self,messages,**kwargs):
        replies=original(self,messages,**kwargs)
        stages.append(self.transcript[-1]['stage'])
        if stages[-1]==Stage.UNMASK:local.withdraw(entry['partnerId'])
        return replies
    monkeypatch.setattr(ProfileGrid,'send_and_receive',withdrawing)
    try:
        with pytest.raises(GateError,match='TLS exchange rejected'):coordinate(profile,artifacts,governance,authority,root/'candidate-run')
        assert Stage.UNMASK in stages
        governance.require_consent(entry['partnerId'],entry['datasetSha256'])
        assert not (root/'candidate-run'/'models').exists()
        assert governance.db.execute('SELECT COUNT(*) FROM spend').fetchone()[0]==20
    finally:processes.close();governance.db.close();local.db.close()


@posix
def test_lab_never_grants_consent_to_preexisting_unprovenanced_bytes(tmp_path):
    root=tmp_path/'lab';local=root/'node-1';local.mkdir(mode=0o700,parents=True)
    root.chmod(0o700)
    (local/'synthetic-quality.npz').write_bytes(b'not a generated synthetic dataset')
    with pytest.raises(GateError,match='synthetic lab provenance'):prepare_lab(root,tmp_path/'scratch',1,20)
    governance=Governance(root/'privacy-ledger.sqlite')
    try:assert governance.db.execute('SELECT COUNT(*) FROM consents').fetchone()[0]==0
    finally:governance.db.close()
