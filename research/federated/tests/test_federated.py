from copy import deepcopy
import json
import sqlite3
import time
from pathlib import Path
import numpy as np
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from flwr.app import Message,Metadata,RecordDict,ConfigRecord
from proofcollective.governance import Governance,GateError,MIN_CONTRIBUTORS,PURPOSE,ModelRegistry,public_key,sign,verify,digest,release_gates
from proofcollective.model import synthetic_dataset,train_update,FEATURES
from proofcollective.protocol import LocalAgent,secure_aggregate,SimulatedLink
from proofcollective.cli import require_privacy_mode


def enrollment(tmp_path,n=24):
    gov=Governance(tmp_path/'ledger.sqlite')
    partners=[f'p{i}' for i in range(n)]
    datasets={p:f'dataset-{p}' for p in partners}
    for p in partners:gov.consent(p,datasets[p])
    return gov,partners,datasets


def test_consent_purpose_and_withdrawal(tmp_path):
    gov,ps,ds=enrollment(tmp_path)
    gov.require_consent(ps[0],ds[ps[0]])
    with pytest.raises(GateError):gov.require_consent(ps[0],'wrong-dataset')
    with pytest.raises(GateError):gov.require_consent(ps[0],ds[ps[0]],'fraud-propensity')
    gov.withdraw(ps[0])
    with pytest.raises(GateError):gov.reserve('c','1',ps,ds,4,24)
    assert gov.db.execute('SELECT count(*) FROM spend').fetchone()[0]==0
    with pytest.raises(sqlite3.DatabaseError):gov.db.execute('DELETE FROM consents')


def test_cumulative_budget_cannot_reset_campaign(tmp_path):
    gov,ps,ds=enrollment(tmp_path)
    for i in range(5):
        spend=gov.reserve(f'new-campaign-{i}',str(i),ps,ds,4,24)
    assert 2.7<spend['epsilonMaxCumulative']<3
    with pytest.raises(GateError,match='budget exhausted'):
        gov.reserve('attempted-reset','6',ps,ds,4,24)
    assert len(gov.db.execute('SELECT * FROM spend').fetchall())==120
    # Persistence after re-opening the process does not reset exposure.
    reopened=Governance(tmp_path/'ledger.sqlite')
    with pytest.raises(GateError):reopened.reserve('another','7',ps,ds,4,24)
    with pytest.raises(sqlite3.DatabaseError):gov.db.execute('UPDATE spend SET sigma=999')


def test_population_delta_and_small_cohort(tmp_path):
    gov,ps,ds=enrollment(tmp_path)
    with pytest.raises(GateError):gov.reserve('c','1',ps[:19],ds,4,24)
    with pytest.raises(GateError):gov.reserve('c','1',[ps[0]]*24,ds,4,24)
    result=gov.reserve('c','2',ps,ds,4,1000)
    assert result['delta']==1e-7
    # Later smaller eligible population may not relax an already stricter delta.
    result2=gov.reserve('c','3',ps,ds,4,24)
    assert gov.exposure(ps[0])[1]==1e-7


def test_signed_recipe_model_and_bounded_update():
    key=Ed25519PrivateKey.generate(); trusted=public_key(key)
    model=np.array([.6,-.4,0.,0.])
    payload={'purpose':PURPOSE,'featureOrder':FEATURES,'modelDigest':digest(model.tolist()),'localSteps':32,'learningRate':.5,'clipNorm':1.}
    signed=sign(payload,key);x,y=synthetic_dataset(1)
    update=train_update(x,y,model,signed,trusted)
    assert np.linalg.norm(update)<=1.0000001
    altered=deepcopy(signed);altered['payload']['localSteps']=1000
    with pytest.raises(GateError):train_update(x,y,model,altered,trusted)
    with pytest.raises(GateError):train_update(x,y,model+1,signed,trusted)
    with pytest.raises(GateError):verify(signed,public_key(Ed25519PrivateKey.generate()))
    with pytest.raises(GateError):train_update(x,y,model,sign({**payload,'localSteps':1000},key),trusted)


def test_real_secagg_dropout_and_no_clear_updates():
    agents=[LocalAgent(i,lambda i=i:np.array([i/100,0.,0.,0.]),lambda:None) for i in range(1,25)]
    result,report=secure_aggregate(agents,dropout={23,24})
    assert np.allclose(result,np.array([.115,0,0,0]),atol=1e-6)
    assert report['contributors']==22
    assert [s['stage'] for s in report['stages']]==['setup','share_keys','collect_masked_vectors','unmask']
    assert report['individualUpdatesLogged']==0


def test_real_secagg_threshold_failure():
    agents=[LocalAgent(i,lambda:np.zeros(4),lambda:None) for i in range(1,25)]
    with pytest.raises(GateError,match='threshold'):
        secure_aggregate(agents,dropout={20,21,22,23,24})


def test_real_secagg_encrypted_share_tamper():
    agents=[LocalAgent(i,lambda:np.zeros(4),lambda:None) for i in range(1,25)]
    with pytest.raises(GateError,match='Flower SecAgg'):
        secure_aggregate(agents,tamper=True)


def test_real_secagg_poisoned_aggregate_rejected():
    agents=[LocalAgent(i,lambda:np.ones(4),lambda:None) for i in range(1,25)]
    with pytest.raises(GateError,match='sanity'):
        secure_aggregate(agents)


def test_authenticated_transport_tamper_replay_and_wrong_partner():
    link=SimulatedLink([1,2])
    msg=Message(content=RecordDict({'test':ConfigRecord({'kind':'fixture'})}),metadata=Metadata(1,'unique',0,1,'','1',time.time(),60,'train'))
    token=link.seal(1,msg)
    with pytest.raises(GateError):link.open(2,token,'request')
    with pytest.raises(GateError):link.open(1,token[:-5]+b'abcde','request')
    assert link.open(1,token,'request').metadata.dst_node_id==1
    with pytest.raises(GateError,match='Replayed'):link.open(1,token,'request')


def test_withdrawal_aborts_during_protocol(tmp_path):
    gov,ps,ds=enrollment(tmp_path)
    agents=[]
    for i,p in enumerate(ps,1):
        def train(p=p):
            gov.withdraw(p)
            return np.zeros(4)
        agents.append(LocalAgent(i,train,lambda p=p:gov.require_consent(p,ds[p])))
    with pytest.raises(GateError,match='withdrawn'):
        secure_aggregate(agents)


def test_signed_candidate_gate_and_rollback(tmp_path):
    key=Ed25519PrivateKey.generate();registry=ModelRegistry(tmp_path/'models',public_key(key))
    def candidate(version,passed=True):
        return sign({'version':version,'scope':'SYNTHETIC_LOCAL_RESEARCH','qualityGate':{'passed':passed},'privacy':{'epsilonMaxCumulative':1.1}},key)
    old=registry.store(candidate(1));new=registry.store(candidate(2));bad=registry.store(candidate(3,False))
    registry.promote_lab(old);registry.promote_lab(new)
    assert registry.active==new
    registry.rollback(old);assert registry.active==old
    with pytest.raises(GateError):registry.promote_lab(bad)
    with pytest.raises(GateError):registry.rollback(bad)
    artifact=tmp_path/'models'/f'{new}.json'
    data=json.loads(artifact.read_text());data['payload']['version']=999;artifact.write_text(json.dumps(data))
    with pytest.raises(GateError):registry.get(new)


def test_group_gate_and_distributed_branch_fail_closed():
    baseline={'accuracy':.7,'groups':{'a':.8,'b':.6}}
    bad={'accuracy':.78,'groups':{'a':.77,'b':.79}}
    assert not release_gates(baseline,bad)['passed']
    with pytest.raises(GateError):require_privacy_mode('distributed')


def test_local_dataset_requires_exact_consent_and_preprocessing(tmp_path):
    import hashlib
    from proofcollective.model import load_consented_local_quality
    path=tmp_path/'quality.npz'
    np.savez(path,sharpness=np.ones(32)*500,glare_fraction=np.zeros(32),contrast=np.ones(32),usable=np.ones(32))
    gov=Governance(tmp_path/'local.sqlite')
    with pytest.raises(GateError):load_consented_local_quality(path,'partner',gov)
    gov.consent('partner',hashlib.sha256(path.read_bytes()).hexdigest())
    x,y=load_consented_local_quality(path,'partner',gov)
    assert x.shape==(32,4) and np.array_equal(x[0],[0,-1,1,1])
    gov.withdraw('partner')
    with pytest.raises(GateError):load_consented_local_quality(path,'partner',gov)


def test_exact_minimum_cohort_can_aggregate():
    agents=[LocalAgent(i,lambda:np.array([.25,0,0,0]),lambda:None) for i in range(1,21)]
    model,report=secure_aggregate(agents)
    assert np.allclose(model,[.25,0,0,0],atol=1e-6)
    assert report['contributors']==20
