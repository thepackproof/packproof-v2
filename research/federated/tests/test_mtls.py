"""Real socket/certificate exercises, with no raw model or protobuf logging."""
from dataclasses import replace
import json
import socket
import ssl
import struct
import threading
import time
from uuid import uuid4
import numpy as np
import pytest
from flwr.app import ConfigRecord, Message, Metadata, RecordDict
from flwr.common.serde import message_to_proto
from proofcollective.governance import GateError, Governance
from proofcollective.mtls import (MAX_FRAME, Peer, TLSMessageClient, TLSMessageServer,
    create_lab_pki, pin_certificate, receive_frame, send_frame)
from proofcollective.protocol import LocalAgent, secure_aggregate


def message(node=1,run=1):
    return Message(content=RecordDict({'fixture':ConfigRecord({'kind':'synthetic protocol check'})}),metadata=Metadata(run,str(uuid4()),0,node,'','round-1',time.time(),60,'train'))


def reply(request):
    return Message(content=request.content,metadata=Metadata(request.metadata.run_id,str(uuid4()),request.metadata.dst_node_id,0,request.metadata.message_id,request.metadata.group_id,time.time(),60,'train'))


@pytest.fixture
def endpoint(tmp_path):
    identities=create_lab_pki(tmp_path/'pki',[1,2])
    handled=[]
    def handler(request):
        handled.append(request.metadata.message_id)
        return reply(request)
    server=TLSMessageServer(identities[1],pin_certificate(identities[0].certificate),1,handler)
    peer=Peer(1,*server.address,'localhost',pin_certificate(identities[1].certificate))
    client=TLSMessageClient(identities[0],{1:peer})
    try:yield identities,server,peer,client,handled
    finally:server.close()


def wait_for(predicate):
    deadline=time.monotonic()+3
    while not predicate():
        if time.monotonic()>deadline:raise AssertionError('Bounded socket observation timed out')
        threading.Event().wait(.005)


def test_actual_mtls_messages_mutual_authentication_and_replay(endpoint,monkeypatch,tmp_path):
    identities,server,peer,client,handled=endpoint
    monkeypatch.setenv('SSLKEYLOGFILE',str(tmp_path/'tls-secrets.log'))
    isolated_context=identities[0].context(server=False)
    assert isolated_context.keylog_filename is None
    assert not (tmp_path/'tls-secrets.log').exists()
    request=message();response=client.exchange(1,request)
    assert response.metadata.reply_to_message_id==request.metadata.message_id
    assert server.handshakes==1 and client.connections==1 and len(handled)==1
    with pytest.raises(GateError):client.exchange(1,request)
    assert len(handled)==1


def test_wrong_certificate_pin_ca_hostname_and_missing_client_cert_denied(endpoint,tmp_path):
    identities,server,peer,client,handled=endpoint
    wrong_pin=TLSMessageClient(identities[0],{1:replace(peer,certificate_sha256=pin_certificate(identities[2].certificate))})
    with pytest.raises(GateError):wrong_pin.exchange(1,message())
    wrong_hostname=TLSMessageClient(identities[0],{1:replace(peer,server_name='unapproved.example')})
    with pytest.raises(GateError):wrong_hostname.exchange(1,message())
    other=create_lab_pki(tmp_path/'untrusted-ca',[1])
    with pytest.raises(GateError):TLSMessageClient(other[0],{1:peer}).exchange(1,message())
    # CA-valid client certificate still fails the server's explicit coordinator pin.
    old_pin=server.pin;server.pin=pin_certificate(identities[2].certificate)
    with pytest.raises(GateError):client.exchange(1,message())
    server.pin=old_pin
    # A TLS client with the trusted CA but no client certificate cannot send a message.
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);context.minimum_version=ssl.TLSVersion.TLSv1_3
    context.load_verify_locations(cafile=str(identities[0].ca));context.set_alpn_protocols(['packproof-flower-v1'])
    with pytest.raises((OSError,GateError)):
        with socket.create_connection(server.address,timeout=3) as raw,context.wrap_socket(raw,server_hostname='localhost') as connection:
            send_frame(connection,message_to_proto(message()).SerializeToString())
            receive_frame(connection)
    assert not handled


def test_tls_party_binding_cross_run_and_bounded_frames_denied_before_handler(endpoint):
    identities,server,peer,client,handled=endpoint
    for raw in [message_to_proto(message(node=2)).SerializeToString(),message_to_proto(message(run=2)).SerializeToString(),b'not a protobuf']:
        with pytest.raises((OSError,GateError)):
            with socket.create_connection(server.address,timeout=3) as plain,identities[0].context(server=False).wrap_socket(plain,server_hostname='localhost') as connection:
                send_frame(connection,raw);receive_frame(connection)
    with pytest.raises((OSError,GateError)):
        with socket.create_connection(server.address,timeout=3) as plain,identities[0].context(server=False).wrap_socket(plain,server_hostname='localhost') as connection:
            connection.sendall(struct.pack('!I',MAX_FRAME+1));receive_frame(connection)
    # A pinned certificate for a different node cannot masquerade as this registry row.
    with pytest.raises(GateError):TLSMessageClient(identities[0],{1:replace(peer,node_id=2)})
    assert not handled


class TamperProxy:
    """Test-only TCP proxy: flip a TLS ciphertext byte after the real handshake."""
    def __init__(self,target):
        self.target=target;self.arm=threading.Event();self.changed=threading.Event();self.sockets=[]
        self.listener=socket.socket();self.listener.bind(('127.0.0.1',0));self.listener.listen(1);self.listener.settimeout(3)
        self.address=self.listener.getsockname()
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
    def exact(self,connection,n):
        data=b''
        while len(data)<n:
            part=connection.recv(n-len(data))
            if not part:return None
            data+=part
        return data
    def pump(self,source,target,tamper):
        try:
            while True:
                if tamper:
                    head=self.exact(source,5)
                    if head is None:return
                    body=self.exact(source,int.from_bytes(head[3:5],'big'))
                    if body is None:return
                    if self.arm.is_set() and not self.changed.is_set() and head[0]==23:
                        body=body[:-1]+bytes([body[-1]^1]);self.changed.set()
                    target.sendall(head+body)
                else:
                    data=source.recv(65536)
                    if not data:return
                    target.sendall(data)
        except OSError:pass
        finally:
            try:target.shutdown(socket.SHUT_WR)
            except OSError:pass
    def run(self):
        try:
            client,_=self.listener.accept();upstream=socket.create_connection(self.target,timeout=3)
            client.settimeout(3);self.sockets=[client,upstream]
            downstream=threading.Thread(target=self.pump,args=(upstream,client,False),daemon=True);downstream.start()
            self.pump(client,upstream,True);downstream.join(3)
        except OSError:pass
    def close(self):
        self.listener.close()
        for connection in self.sockets:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            connection.close()
        self.thread.join(4)


def test_actual_tls_ciphertext_tamper_aborts_before_flower_handler(endpoint):
    identities,server,peer,client,handled=endpoint
    proxy=TamperProxy(server.address)
    try:
        with socket.create_connection(proxy.address,timeout=3) as raw,identities[0].context(server=False).wrap_socket(raw,server_hostname='localhost') as connection:
            wait_for(lambda:server.handshakes==1)
            proxy.arm.set()
            with pytest.raises((OSError,GateError)):
                send_frame(connection,message_to_proto(message()).SerializeToString())
                receive_frame(connection)
        assert proxy.changed.is_set()
        wait_for(lambda:server.rejected>=1)
        assert not handled
    finally:proxy.close()


def test_twenty_real_contributors_aggregate_over_tls_without_update_logging(capsys):
    vectors={i:np.array([i/100,0,.1,0]) for i in range(1,23)}
    agents=[LocalAgent(i,lambda i=i:vectors[i],lambda:None) for i in vectors]
    aggregate,report=secure_aggregate(agents,dropout={21,22},transport='local-mtls')
    assert np.allclose(aggregate,np.mean([vectors[i] for i in range(1,21)],axis=0),atol=1e-6)
    assert report['contributors']==20 and report['tlsConnections']==84
    assert report['independentOrganizations']==0
    assert report['rawSamplesUploaded']==report['individualUpdatesLogged']==0
    captured=capsys.readouterr()
    assert not captured.out and not captured.err
    assert [stage['received'] for stage in report['stages']]==[22,22,20,20]
    assert 'TLS 1.3' in report['transport']


def test_thread_consent_guard_observes_withdrawal_without_cached_permission(tmp_path):
    governance=Governance(tmp_path/'ledger.sqlite')
    governance.consent('lab-partner','dataset')
    guard=governance.local_consent_guard('lab-partner','dataset')
    failures=[]
    def call():
        try:guard()
        except GateError:failures.append('denied')
    thread=threading.Thread(target=call);thread.start();thread.join(3)
    assert not thread.is_alive() and not failures
    governance.withdraw('lab-partner')
    thread=threading.Thread(target=call);thread.start();thread.join(3)
    assert not thread.is_alive() and failures==['denied']


def test_operational_profile_pins_entire_current_cohort_and_local_identity(tmp_path):
    from proofcollective.mtls import load_transport_profile
    identities=create_lab_pki(tmp_path/'pki',list(range(1,21)))
    profile={'schema':'proofcollective-mtls-profile/v1','scope':'RESEARCH_ONLY','productionReleaseAuthorized':False,'purpose':'capture-frame-usefulness/v1','expiresAtUnix':time.time()+3600,'runId':1,'localNodeId':0,'identity':{'certificate':str(identities[0].certificate),'privateKey':str(identities[0].private_key),'ca':str(identities[0].ca)},'coordinatorCertificateSha256':pin_certificate(identities[0].certificate),'peers':[{'nodeId':i,'host':'127.0.0.1','port':24000+i,'serverName':'localhost','certificateSha256':pin_certificate(identities[i].certificate)} for i in range(1,21)],'bind':{'host':'127.0.0.1','port':24000}}
    path=tmp_path/'profile.json'
    profile['admissionLedger']=str(tmp_path/'transport-admission.sqlite')
    def save(value):path.write_text(json.dumps(value));return load_transport_profile(path)
    loaded=save(profile)
    assert len(loaded.client().peers)==20
    with pytest.raises(GateError):loaded.server(reply)
    for altered in [dict(profile,expiresAtUnix=time.time()-1),dict(profile,productionReleaseAuthorized=True),dict(profile,localNodeId=1),dict(profile,peers=profile['peers'][:19]),dict(profile,peers=[profile['peers'][0]]*20)]:
        with pytest.raises(GateError):save(altered)


def test_live_profile_expiry_and_durable_restart_admission(endpoint,tmp_path):
    identities,server,peer,client,handled=endpoint
    client.expires_at=time.time()-1
    with pytest.raises(GateError,match='expired'):client.exchange(1,message())
    client.expires_at=time.time()+60;server.expires_at=time.time()-1
    with pytest.raises(GateError):client.exchange(1,message())
    assert not handled
    private=tmp_path/'state';private.mkdir(mode=0o700);ledger=private/'admission.sqlite'
    def start(run):return TLSMessageServer(identities[1],pin_certificate(identities[0].certificate),1,reply,run_id=run,admission_ledger=ledger,expires_at=time.time()+60)
    first=start(11);first.close()
    for reused in [11,10]:
        with pytest.raises(GateError,match='fresh increasing run'):start(reused)
    second=start(12)
    try:
        current=Peer(1,*second.address,'localhost',pin_certificate(identities[1].certificate))
        request=message(run=12)
        response=TLSMessageClient(identities[0],{1:current},run_id=12).exchange(1,request)
        assert response.metadata.reply_to_message_id==request.metadata.message_id
    finally:second.close()
