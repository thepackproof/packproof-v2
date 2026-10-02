"""Unmodified Flower SecAgg+ over simulated links or actual local mutual-TLS sockets.

No custom masking, key sharing, reconstruction or cryptographic aggregation is used.
The process controls all lab nodes, so this exercises a protocol and does not establish
organizational independence or coordinator isolation from local process memory.
"""
from __future__ import annotations
from copy import deepcopy
from dataclasses import dataclass
import logging
import time
from uuid import uuid4
import numpy as np
from cryptography.fernet import Fernet, InvalidToken
from flwr.supercore.task_identity import TaskIdentity
from flwr.app import ConfigRecord, Context, Message, Metadata, RecordDict
from flwr.client.mod import secaggplus_mod
from flwr.common import Code, FitRes, Status, ndarrays_to_parameters, parameters_to_ndarrays
from flwr.common.serde import message_to_proto, message_from_proto
from flwr.proto.message_pb2 import Message as ProtoMessage
from flwr.common.secure_aggregation.secaggplus_constants import Key, Stage, RECORD_KEY_CONFIGS
from flwr.compat.common import recorddict_compat as compat
from flwr.server.client_manager import SimpleClientManager
from flwr.server.compat.grid_client_proxy import GridClientProxy
from flwr.server.compat.legacy_context import LegacyContext
from flwr.server.strategy import FedAvg
from flwr.server.workflow import SecAggPlusWorkflow
from flwr.server.workflow.secure_aggregation.secaggplus_workflow import WorkflowState
from flwr.server.workflow.constant import MAIN_CONFIGS_RECORD, MAIN_PARAMS_RECORD, Key as WorkflowKey
from .governance import GateError, MIN_CONTRIBUTORS
from .mtls import LocalMtlsLink

QUANTIZATION_RANGE=2**22
MODULUS_RANGE=2**32

@dataclass
class LocalAgent:
    node_id: int
    train: object
    check_consent: object

    def fit(self,msg:Message,context:Context) -> Message:
        self.check_consent()
        update=np.asarray(self.train(),dtype=np.float64)
        # Every partner contributes exactly one clipped vector; sample counts are private.
        res=FitRes(Status(Code.OK,''),ndarrays_to_parameters([update]),1,{})
        return Message(compat.fitres_to_recorddict(res,keep_input=True),reply_to=msg)

class SimulatedLink:
    """Fernet authenticated encryption of real Flower protobuf bytes, no sockets.

    Pinned keys are generated in memory per lab client. Select local-mtls for real
    socket/certificate tests; any pilot still requires separate approved enrollment.
    """
    def __init__(self,node_ids:list[int]):
        self.keys={nid:Fernet(Fernet.generate_key()) for nid in node_ids}
        self.seen:set[tuple[str,str]]=set()

    def seal(self,nid:int,msg:Message) -> bytes:
        return self.keys[nid].encrypt(message_to_proto(msg).SerializeToString(deterministic=True))

    def open(self,nid:int,token:bytes,direction:str) -> Message:
        try:
            raw=self.keys[nid].decrypt(token,ttl=60)
        except (InvalidToken,KeyError) as exc:
            raise GateError('Authenticated transport rejected message') from exc
        proto=ProtoMessage();proto.ParseFromString(raw)
        msg=message_from_proto(proto)
        if (direction=='request' and msg.metadata.dst_node_id!=nid) or (direction=='reply' and msg.metadata.src_node_id!=nid):
            raise GateError('Participant routing mismatch')
        identity=(direction,msg.metadata.message_id)
        if not identity[1] or identity in self.seen:
            raise GateError('Replayed or unidentified message')
        self.seen.add(identity)
        return msg

class LocalSimulationGrid:
    def __init__(self,agents:list[LocalAgent],dropout:set[int]|None=None,tamper:bool=False,transport:str="simulated"):
        self.agents={a.node_id:a for a in agents}
        self.contexts={nid:Context(run_id=1,node_id=nid,node_config={},state=RecordDict(),run_config={}) for nid in self.agents}
        if transport not in ("simulated","local-mtls"):
            raise GateError("Unknown transport")
        self.link=LocalMtlsLink({nid:lambda msg,nid=nid:self._respond(nid,msg) for nid in self.agents}) if transport=="local-mtls" else SimulatedLink(list(self.agents))
        self.dropout=dropout or set()
        self.tamper=tamper
        self.transcript=[]

    def send_and_receive(self,messages,*,timeout=None):
        replies=[]
        for outgoing in messages:
            nid=outgoing.metadata.dst_node_id
            if nid not in self.agents:
                raise GateError('Unenrolled participant')
            stage=outgoing.content.config_records[RECORD_KEY_CONFIGS][Key.STAGE]
            if stage in (Stage.COLLECT_MASKED_VECTORS,Stage.UNMASK) and nid in self.dropout:
                continue
            self.agents[nid].check_consent()
            # Message metadata is assigned by the real Grid/SuperLink in deployment.
            metadata=Metadata(1,str(uuid4()),0,nid,'',outgoing.metadata.group_id,time.time(),60,'train')
            msg=Message(content=deepcopy(outgoing.content),metadata=metadata)
            if isinstance(self.link,LocalMtlsLink):
                decoded=self.link.exchange(nid,msg)
            else:
                msg=self.link.open(nid,self.link.seal(nid,msg),'request')
                response=self._respond(nid,msg)
                decoded=self.link.open(nid,self.link.seal(nid,response),'reply')
            if stage==Stage.COLLECT_MASKED_VECTORS:
                if any(len(a)>0 for a in decoded.content.array_records.values()):
                    raise GateError('Unmasked individual model leaked in reply')
                metrics=compat.recorddict_to_fitres(decoded.content,True).metrics
                if metrics:
                    raise GateError('Unexpected client telemetry; labels/updates must not be logged')
            replies.append(decoded)
        self.transcript.append({'stage':stage,'requested':len(messages),'received':len(replies)})
        return replies

    def _respond(self,nid:int,msg:Message) -> Message:
        stage=msg.content.config_records[RECORD_KEY_CONFIGS][Key.STAGE]
        if self.tamper and stage==Stage.COLLECT_MASKED_VECTORS:
            cfg=msg.content.config_records[RECORD_KEY_CONFIGS]
            ciphertexts=list(cfg[Key.CIPHERTEXT_LIST])
            if ciphertexts:
                ciphertexts[0]=bytes([ciphertexts[0][0]^1])+ciphertexts[0][1:]
                cfg[Key.CIPHERTEXT_LIST]=ciphertexts
        try:
            response=secaggplus_mod(msg,self.contexts[nid],self.agents[nid].fit)
        except Exception as exc:
            raise GateError(f'Flower SecAgg+ rejected {stage}') from exc
        meta=Metadata(1,str(uuid4()),nid,0,msg.metadata.message_id,msg.metadata.group_id,time.time(),60,'train')
        return Message(content=response.content,metadata=meta)

    def close(self):
        if isinstance(self.link,LocalMtlsLink):
            self.link.close()


def secure_aggregate(agents:list[LocalAgent],*,dropout:set[int]|None=None,tamper:bool=False,clip:float=1.0,transport:str="simulated") -> tuple[np.ndarray,dict]:
    if len(agents)<MIN_CONTRIBUTORS or len(agents)>64 or len(set(a.node_id for a in agents))!=len(agents):
        raise GateError('Cohort must contain 20..64 distinct contributors')
    TaskIdentity.run_id=1; TaskIdentity.node_id=0; TaskIdentity.task_id=0
    grid=LocalSimulationGrid(agents,dropout,tamper,transport)
    try:
        return _run_aggregate(agents,grid,clip)
    finally:
        grid.close()


def _run_aggregate(agents:list[LocalAgent],grid:LocalSimulationGrid,clip:float) -> tuple[np.ndarray,dict]:
    manager=SimpleClientManager()
    for agent in agents:
        manager.register(GridClientProxy(agent.node_id,grid,1))
    strategy=FedAvg(fraction_fit=1,min_fit_clients=len(agents),min_available_clients=len(agents),fraction_evaluate=0,accept_failures=True,fit_metrics_aggregation_fn=lambda _: {})
    ctx=LegacyContext(Context(1,0,{},RecordDict(),{}),strategy=strategy,client_manager=manager)
    ctx.state.config_records[MAIN_CONFIGS_RECORD]=ConfigRecord({WorkflowKey.CURRENT_ROUND:1})
    ctx.state.array_records[MAIN_PARAMS_RECORD]=compat.parameters_to_arrayrecord(ndarrays_to_parameters([np.zeros(4)]),True)
    workflow=SecAggPlusWorkflow(num_shares=len(agents),reconstruction_threshold=(1.0 if len(agents)==MIN_CONTRIBUTORS else MIN_CONTRIBUTORS),max_weight=1.0,clipping_range=float(clip),quantization_range=QUANTIZATION_RANGE,modulus_range=MODULUS_RANGE,timeout=30)
    state=WorkflowState()
    logging.getLogger('flwr').setLevel(logging.ERROR)
    for step in (workflow.setup_stage,workflow.share_keys_stage,workflow.collect_masked_vectors_stage):
        if not step(grid,ctx,state):
            raise GateError('Secure aggregation threshold not met')
    contributors=len(state.active_node_ids)
    if contributors<MIN_CONTRIBUTORS:
        raise GateError('Minimum contributor floor violated before unmask')
    # Consent withdrawal after local training still aborts publication of this aggregate.
    for agent in agents:
        if agent.node_id in state.active_node_ids:
            agent.check_consent()
    if not workflow.unmask_stage(grid,ctx,state):
        raise GateError('Secure aggregation reconstruction threshold not met')
    aggregate=parameters_to_ndarrays(compat.arrayrecord_to_parameters(ctx.state.array_records[MAIN_PARAMS_RECORD],True))[0]
    slack=np.sqrt(aggregate.size)*2*clip/QUANTIZATION_RANGE
    if not np.isfinite(aggregate).all() or np.linalg.norm(aggregate)>clip+slack:
        raise GateError('Aggregate sanity limit exceeded; malicious clipping not verifiable')
    return aggregate,{'protocol':'Flower 1.39.0 SecAggPlusWorkflow + secaggplus_mod','contributors':contributors,'independentOrganizations':0,'topology':'all-to-all shares','reconstructionThreshold':MIN_CONTRIBUTORS,'quantizationRange':QUANTIZATION_RANGE,'quantizationL2Slack':float(slack),'transport':grid.link.description if isinstance(grid.link,LocalMtlsLink) else 'Fernet authenticated encrypted protobuf in process; simulation only','tlsConnections':grid.link.client.connections if isinstance(grid.link,LocalMtlsLink) else 0,'stages':grid.transcript,'rawSamplesUploaded':0,'individualUpdatesLogged':0}
