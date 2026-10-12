"""TLS 1.3 transport for bounded Flower protobuf messages.

Python's maintained ssl/OpenSSL implementation supplies encryption/authentication.
Certificate pinning binds an enrolled node to a certificate, in addition to CA, EKU,
hostname and validity verification. No TLS implementation or custom cryptography.
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import math
import os
from pathlib import Path
import socket
import ssl
import sqlite3
import struct
import tempfile
import threading
import time
from contextlib import closing
from typing import Callable
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from flwr.app import Message
from flwr.common.serde import message_from_proto, message_to_proto
from flwr.proto.message_pb2 import Message as ProtoMessage
from .governance import GateError

ALPN='packproof-flower-v1'
MAX_FRAME=2*1024*1024
SOCKET_TIMEOUT=5
MAX_MESSAGES=256


def identity_uri(node_id:int) -> str:
    return f'urn:packproof:proofcollective:node:{node_id}'


def pin_certificate(path:Path) -> str:
    cert=x509.load_pem_x509_certificate(path.read_bytes())
    return cert.fingerprint(hashes.SHA256()).hex()


def _valid_pin(pin:str) -> None:
    if not isinstance(pin,str) or len(pin)!=64 or any(c not in '0123456789abcdef' for c in pin):
        raise GateError('An exact enrolled certificate SHA-256 pin is required')


@dataclass(frozen=True)
class TlsIdentity:
    certificate:Path
    private_key:Path
    ca:Path

    def context(self,*,server:bool) -> ssl.SSLContext:
        # Keys are intentionally never read into logs, frames or diagnostic reports.
        info=self.private_key.lstat()
        if not self.private_key.is_file() or self.private_key.is_symlink() or info.st_mode&0o077 or info.st_nlink!=1:
            raise GateError('TLS private key must be a private regular file')
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER if server else ssl.PROTOCOL_TLS_CLIENT)
        context.minimum_version=ssl.TLSVersion.TLSv1_3
        context.maximum_version=ssl.TLSVersion.TLSv1_3
        context.verify_mode=ssl.CERT_REQUIRED
        context.load_verify_locations(cafile=str(self.ca))
        context.load_cert_chain(str(self.certificate),str(self.private_key))
        context.set_alpn_protocols([ALPN])
        context.options|=ssl.OP_NO_COMPRESSION
        if server:
            context.num_tickets=0
        # SSLContext does not opt into SSLKEYLOGFILE. Secret key logging stays disabled.
        if context.keylog_filename is not None:
            raise GateError('TLS secret logging must remain disabled')
        return context


@dataclass(frozen=True)
class Peer:
    node_id:int
    host:str
    port:int
    server_name:str
    certificate_sha256:str

    def __post_init__(self):
        _valid_pin(self.certificate_sha256)
        if type(self.node_id) is not int or not 1<=self.node_id<=2**63-1 or type(self.port) is not int or not 1<=self.port<=65535 or not isinstance(self.host,str) or not 0<len(self.host)<=253 or not isinstance(self.server_name,str) or not 0<len(self.server_name)<=253:
            raise GateError('Invalid enrolled TLS peer')


def _peer_binding(connection:ssl.SSLSocket,pin:str,node_id:int) -> None:
    if connection.version()!='TLSv1.3' or connection.selected_alpn_protocol()!=ALPN:
        raise GateError('TLS protocol binding rejected')
    cert=connection.getpeercert(binary_form=True)
    uris=[value for kind,value in connection.getpeercert().get('subjectAltName',()) if kind=='URI']
    if not cert or not hmac.compare_digest(hashlib.sha256(cert).hexdigest(),pin) or uris!=[identity_uri(node_id)]:
        raise GateError('Enrolled certificate/participant binding rejected')


def _read_exact(connection:ssl.SSLSocket,size:int,deadline:float) -> bytes:
    chunks=bytearray()
    while len(chunks)<size:
        remaining=deadline-time.monotonic()
        if remaining<=0:
            raise GateError('TLS frame deadline exceeded')
        connection.settimeout(remaining)
        part=connection.recv(size-len(chunks))
        if not part:
            raise GateError('Truncated TLS message')
        chunks.extend(part)
    return bytes(chunks)


def receive_frame(connection:ssl.SSLSocket) -> bytes:
    deadline=time.monotonic()+SOCKET_TIMEOUT
    size=struct.unpack('!I',_read_exact(connection,4,deadline))[0]
    if not 0<size<=MAX_FRAME:
        raise GateError('TLS message size limit rejected')
    return _read_exact(connection,size,deadline)


def send_frame(connection:ssl.SSLSocket,raw:bytes) -> None:
    if not 0<len(raw)<=MAX_FRAME:
        raise GateError('TLS message size limit rejected')
    connection.sendall(struct.pack('!I',len(raw))+raw)


def _decode(raw:bytes) -> Message:
    try:
        proto=ProtoMessage();proto.ParseFromString(raw)
        return message_from_proto(proto)
    except Exception as exc:
        raise GateError('Invalid Flower protobuf') from exc


def _message_binding(message:Message,node_id:int,run_id:int,*,reply_to:Message|None=None) -> None:
    meta=message.metadata;now=time.time()
    if meta.run_id!=run_id or meta.message_type!='train' or not meta.message_id or len(meta.message_id)>128 or len(meta.group_id)>128 or not math.isfinite(meta.created_at) or not math.isfinite(meta.ttl) or not 0<meta.ttl<=60 or meta.created_at>now+5 or meta.created_at+meta.ttl<=now:
        raise GateError('Flower message session/expiry binding rejected')
    if reply_to is None:
        valid=meta.src_node_id==0 and meta.dst_node_id==node_id and not meta.reply_to_message_id
    else:
        valid=meta.src_node_id==node_id and meta.dst_node_id==0 and meta.reply_to_message_id==reply_to.metadata.message_id and meta.group_id==reply_to.metadata.group_id
    if not valid:
        raise GateError('Flower participant/request binding rejected')


def _current_profile(expires_at:float|None) -> None:
    if expires_at is not None and (not math.isfinite(expires_at) or time.time()>=expires_at):
        raise GateError('Transport enrollment profile expired')


def _claim_session(path:Path,node_id:int,run_id:int) -> None:
    """Operational restarts consume a new monotonic run; no in-memory replay reset."""
    parent=path.parent
    if parent.is_symlink() or not parent.is_dir() or parent.stat().st_mode&0o077:
        raise GateError('Transport admission ledger requires a private directory')
    try:
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)
    except FileExistsError:
        pass
    info=path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_mode&0o077 or info.st_nlink!=1:
        raise GateError('Transport admission ledger must be a private regular file')
    with closing(sqlite3.connect(path,timeout=5,isolation_level=None)) as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS sessions(node_id INTEGER NOT NULL,run_id INTEGER NOT NULL,started_at REAL NOT NULL,PRIMARY KEY(node_id,run_id));
        CREATE TRIGGER IF NOT EXISTS sessions_no_update BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT,'append-only session admission'); END;
        CREATE TRIGGER IF NOT EXISTS sessions_no_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'append-only session admission'); END;''')
        db.execute('BEGIN IMMEDIATE')
        prior=db.execute('SELECT MAX(run_id) FROM sessions WHERE node_id=?',(node_id,)).fetchone()[0]
        if prior is not None and run_id<=prior:
            db.execute('ROLLBACK')
            raise GateError('A fresh increasing run ID is required after endpoint restart')
        db.execute('INSERT INTO sessions VALUES(?,?,?)',(node_id,run_id,time.time()))
        db.execute('COMMIT')


class TLSMessageServer:
    """One independently stateful partner endpoint; handler receives authenticated messages.

    The loopback lab uses one server thread per synthetic partner. The same adapter
    accepts dedicated identities/hosts for separately governed operators; using it
    does not itself authorize partner enrollment or a pilot deployment.
    """
    def __init__(self,identity:TlsIdentity,coordinator_pin:str,node_id:int,handler:Callable[[Message],Message],*,run_id:int=1,bind:tuple[str,int]=('127.0.0.1',0),expires_at:float|None=None,admission_ledger:Path|None=None):
        _valid_pin(coordinator_pin)
        if node_id<1:
            raise GateError('Partner node identity required')
        self.context=identity.context(server=True)
        _current_profile(expires_at)
        if admission_ledger is not None:
            _claim_session(admission_ledger,node_id,run_id)
        self.expires_at=expires_at
        self.pin=coordinator_pin;self.node_id=node_id;self.handler=handler;self.run_id=run_id
        self.seen=set();self.accepted=0;self.rejected=0;self.handshakes=0;self.current=None
        self.stop=threading.Event()
        self.listener=socket.socket(socket.AF_INET,socket.SOCK_STREAM)
        self.listener.bind(bind);self.listener.listen(8);self.listener.settimeout(.1)
        self.address=self.listener.getsockname()
        self.thread=threading.Thread(target=self._serve,name=f'proofcollective-tls-{node_id}',daemon=True)
        self.thread.start()

    def _serve(self):
        while not self.stop.is_set():
            try:
                raw,_=self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                self.current=raw
                raw.settimeout(SOCKET_TIMEOUT)
                with raw, self.context.wrap_socket(raw,server_side=True) as connection:
                    self.current=connection
                    _peer_binding(connection,self.pin,0)
                    _current_profile(self.expires_at)
                    self.handshakes+=1
                    request=_decode(receive_frame(connection))
                    _message_binding(request,self.node_id,self.run_id)
                    identity=request.metadata.message_id
                    if identity in self.seen or len(self.seen)>=MAX_MESSAGES:
                        raise GateError('Replayed message or session limit exceeded')
                    self.seen.add(identity)
                    _current_profile(self.expires_at)
                    response=self.handler(request)
                    _current_profile(self.expires_at)
                    _message_binding(response,self.node_id,self.run_id,reply_to=request)
                    send_frame(connection,message_to_proto(response).SerializeToString(deterministic=True))
                    self.accepted+=1
            except Exception:
                # No protobuf, model, labels, exception text or peer identity is logged.
                self.rejected+=1
                raw.close()
            finally:
                self.current=None

    def close(self):
        self.stop.set();self.listener.close()
        current=self.current
        if current is not None:
            try:current.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            current.close()
        self.thread.join(SOCKET_TIMEOUT+1)
        if self.thread.is_alive():
            raise GateError('TLS endpoint did not stop within its bound')


class TLSMessageClient:
    def __init__(self,identity:TlsIdentity,peers:dict[int,Peer],*,run_id:int=1,expires_at:float|None=None):
        _current_profile(expires_at)
        self.context=identity.context(server=False)
        if any(node!=peer.node_id for node,peer in peers.items()):
            raise GateError('Peer registry participant mismatch')
        self.peers=dict(peers);self.run_id=run_id;self.seen=set();self.connections=0;self.expires_at=expires_at

    def exchange(self,node_id:int,message:Message) -> Message:
        _current_profile(self.expires_at)
        if node_id not in self.peers:
            raise GateError('Unenrolled TLS participant')
        if len(self.seen)>=MAX_MESSAGES*len(self.peers):
            raise GateError('TLS client session message limit exceeded')
        _message_binding(message,node_id,self.run_id)
        peer=self.peers[node_id]
        try:
            with socket.create_connection((peer.host,peer.port),timeout=SOCKET_TIMEOUT) as raw:
                with self.context.wrap_socket(raw,server_hostname=peer.server_name) as connection:
                    _peer_binding(connection,peer.certificate_sha256,node_id)
                    _current_profile(self.expires_at)
                    send_frame(connection,message_to_proto(message).SerializeToString(deterministic=True))
                    response=_decode(receive_frame(connection))
                    _current_profile(self.expires_at)
                    _message_binding(response,node_id,self.run_id,reply_to=message)
                    if response.metadata.message_id in self.seen:
                        raise GateError('Replayed TLS response')
                    self.seen.add(response.metadata.message_id);self.connections+=1
                    return response
        except (OSError,ValueError) as exc:
            raise GateError('Authenticated TLS exchange rejected') from exc


def create_lab_pki(directory:Path,node_ids:list[int]) -> dict[int,TlsIdentity]:
    """Ephemeral synthetic test authority; never supplies production certificates."""
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    now=datetime.now(timezone.utc)
    ca_key=ec.generate_private_key(ec.SECP256R1())
    ca_name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'ProofCollective synthetic TLS lab only')])
    ca=(x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(hours=2)).add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True).add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False),critical=True).sign(ca_key,hashes.SHA256()))
    ca_file=directory/'ca.pem';ca_file.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    identities={}
    for node_id in [0,*node_ids]:
        key=ec.generate_private_key(ec.SECP256R1())
        name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,f'Synthetic node {node_id}')])
        cert=(x509.CertificateBuilder().subject_name(name).issuer_name(ca_name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(hours=1)).add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True).add_extension(x509.KeyUsage(True,False,False,False,False,False,False,False,False),critical=True).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH if node_id==0 else ExtendedKeyUsageOID.SERVER_AUTH]),critical=True).add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.UniformResourceIdentifier(identity_uri(node_id))]),critical=False).sign(ca_key,hashes.SHA256()))
        key_file=directory/f'node-{node_id}.key.pem';cert_file=directory/f'node-{node_id}.cert.pem'
        with key_file.open('xb') as handle:
            key_file.chmod(0o600)
            handle.write(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
        cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        identities[node_id]=TlsIdentity(cert_file,key_file,ca_file)
    return identities


class LocalMtlsLink:
    """Actual loopback TLS sockets; all parties still share one lab operator/process."""
    description='TLS 1.3 mutual certificate authentication + pinned node IDs; loopback threaded synthetic lab'
    def __init__(self,handlers:dict[int,Callable[[Message],Message]]):
        self.temporary=tempfile.TemporaryDirectory(prefix='packproof-f10-mtls-')
        self.servers={}
        try:
            identities=create_lab_pki(Path(self.temporary.name),list(handlers))
            pin=pin_certificate(identities[0].certificate)
            peers={}
            for node_id,handler in handlers.items():
                server=TLSMessageServer(identities[node_id],pin,node_id,handler)
                self.servers[node_id]=server
                peers[node_id]=Peer(node_id,*server.address,'localhost',pin_certificate(identities[node_id].certificate))
            self.client=TLSMessageClient(identities[0],peers)
        except Exception:
            self.close();raise

    def exchange(self,node_id:int,message:Message) -> Message:
        return self.client.exchange(node_id,message)

    def close(self):
        # Signal every endpoint before joining, avoiding N sequential accept timeouts.
        for server in self.servers.values():
            server.stop.set();server.listener.close()
        for server in self.servers.values():
            server.close()
        self.temporary.cleanup()


@dataclass(frozen=True)
class TransportProfile:
    """Governed operational configuration, separate from experimental release authority."""
    identity:TlsIdentity
    node_id:int
    run_id:int
    coordinator_pin:str
    peers:dict[int,Peer]
    bind:tuple[str,int]
    expires_at:float
    admission_ledger:Path

    def client(self) -> TLSMessageClient:
        if self.node_id!=0:
            raise GateError('Only the pinned coordinator profile may initiate protocol requests')
        return TLSMessageClient(self.identity,self.peers,run_id=self.run_id,expires_at=self.expires_at)

    def server(self,handler:Callable[[Message],Message]) -> TLSMessageServer:
        if self.node_id==0:
            raise GateError('A partner profile is required to host local training')
        return TLSMessageServer(self.identity,self.coordinator_pin,self.node_id,handler,run_id=self.run_id,bind=self.bind,expires_at=self.expires_at,admission_ledger=self.admission_ledger)


def load_transport_profile(path:Path) -> TransportProfile:
    """Load a current, explicit roster. Does not enroll participants or authorize a pilot."""
    import json
    from .governance import PURPOSE, MIN_CONTRIBUTORS
    if path.stat().st_size>65536:
        raise GateError('Transport profile exceeds its bound')
    profile=json.loads(path.read_text())
    keys={'schema','scope','productionReleaseAuthorized','purpose','expiresAtUnix','runId','localNodeId','identity','coordinatorCertificateSha256','peers','bind','admissionLedger'}
    if set(profile)!=keys or profile['schema']!='proofcollective-mtls-profile/v1' or profile['scope']!='RESEARCH_ONLY' or profile['productionReleaseAuthorized'] is not False or profile['purpose']!=PURPOSE:
        raise GateError('Transport profile scope/purpose rejected')
    expiry=profile['expiresAtUnix'];node_id=profile['localNodeId'];run_id=profile['runId']
    if type(expiry) not in (int,float) or not time.time()<expiry<=time.time()+90*86400 or type(node_id) is not int or node_id<0 or type(run_id) is not int or not 1<=run_id<2**63:
        raise GateError('Transport enrollment profile is stale or invalid')
    coordinator_pin=profile['coordinatorCertificateSha256'];_valid_pin(coordinator_pin)
    files=profile['identity']
    if not isinstance(files,dict) or set(files)!={'certificate','privateKey','ca'} or not all(isinstance(v,str) and v for v in files.values()):
        raise GateError('Explicit local TLS identity files required')
    identity=TlsIdentity((path.parent/files['certificate']).absolute(),(path.parent/files['privateKey']).absolute(),(path.parent/files['ca']).absolute())
    roster=profile['peers']
    if not isinstance(roster,list) or not MIN_CONTRIBUTORS<=len(roster)<=64:
        raise GateError('Transport roster requires 20..64 distinct enrolled partners')
    peers={};pins=set()
    for entry in roster:
        if not isinstance(entry,dict) or set(entry)!={'nodeId','host','port','serverName','certificateSha256'}:
            raise GateError('Invalid transport peer record')
        peer=Peer(entry['nodeId'],entry['host'],entry['port'],entry['serverName'],entry['certificateSha256'])
        if peer.node_id in peers or peer.certificate_sha256 in pins:
            raise GateError('Duplicate transport participant/certificate')
        peers[peer.node_id]=peer;pins.add(peer.certificate_sha256)
    expected_pin=coordinator_pin if node_id==0 else peers.get(node_id).certificate_sha256 if node_id in peers else None
    if pin_certificate(identity.certificate)!=expected_pin:
        raise GateError('Local certificate does not match its enrolled node')
    bind=profile['bind']
    if not isinstance(bind,dict) or set(bind)!={'host','port'} or not isinstance(bind['host'],str) or not bind['host'] or type(bind['port']) is not int or not 1024<=bind['port']<=65535:
        raise GateError('Explicit bounded partner listen address required')
    if not isinstance(profile['admissionLedger'],str) or not profile['admissionLedger']:
        raise GateError('Persistent local transport admission ledger required')
    ledger=(path.parent/profile['admissionLedger']).absolute()
    return TransportProfile(identity,node_id,run_id,coordinator_pin,peers,(bind['host'],bind['port']),expiry,ledger)
