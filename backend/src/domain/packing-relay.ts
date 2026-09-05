import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { Database } from '../db/database.js';
import { newId } from '../ids.js';
import { sha256Hex } from '../hash.js';
import { DomainError } from './errors.js';
import { loadProof, requireParticipant, assertNotFinalized } from './proof-access.js';
import { loadCaptureSession, captureSessionView, assertCaptureRecoverable, CAPTURE_POLICY_VERSION } from './capture-sessions.js';
import { asRequiredIso } from './types.js';
interface Station {
  id:string;actor_user_id:string;controller_token_hash:string;camera_token_hash:string|null;
  pairing_token_hash:string;pairing_expires_at:string|Date;expires_at:string|Date;created_at:string|Date;
  camera_paired_at:string|Date|null;last_sequence:number;acknowledged_sequence:number;
  active_proof_id:string|null;active_capture_session_id:string|null;state:string;
}
const LEASE_MS=8*60*60*1000;
function secret(){return randomBytes(32).toString('base64url');}
function matches(token: string, hash: string|null) { return !!hash && typeof token==='string' && token.length<=256 && timingSafeEqual(Buffer.from(sha256Hex(token)),Buffer.from(hash)); }
async function stationAccess(db:Database,clock:Clock,actor:string,id:string,token:string,role:'CONTROLLER'|'CAMERA'|'EITHER',lock=false) {
  const row=(await db.query<Station>(`SELECT * FROM packing_relay_stations WHERE id=$1 AND actor_user_id=$2${lock?' FOR UPDATE':''}`,[id,actor])).rows[0];
  if (!row || !((role!=='CAMERA' && matches(token,row.controller_token_hash)) || (role!=='CONTROLLER' && matches(token,row.camera_token_hash))))
    throw new DomainError('RELAY_NOT_AUTHORIZED','Authenticate as the paired station participant on this device',403);
  if (row.state==='CANCELLED' || new Date(row.expires_at).getTime()<clock.now().getTime()) throw new DomainError('RELAY_LEASE_EXPIRED','Station lease expired. Pending recordings remain bound to their original orders.',409);
  return row;
}
function view(s:Station){return {id:s.id,state:s.state,paired:!!s.camera_paired_at,expiresAt:asRequiredIso(s.expires_at),pairingExpiresAt:asRequiredIso(s.pairing_expires_at),lastSequence:s.last_sequence,acknowledgedSequence:s.acknowledged_sequence,proofId:s.active_proof_id,captureSessionId:s.active_capture_session_id};}
export async function createRelayStation(db:Database,clock:Clock,actor:string) {
  const controllerToken=secret(),pairingToken=secret(),now=clock.now();
  const row=(await db.query<Station>(`INSERT INTO packing_relay_stations(id,actor_user_id,controller_token_hash,pairing_token_hash,pairing_expires_at,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[newId('relay'),actor,sha256Hex(controllerToken),sha256Hex(pairingToken),new Date(now.getTime()+5*60*1000).toISOString(),new Date(now.getTime()+LEASE_MS).toISOString(),now.toISOString()])).rows[0];
  return {...view(row),controllerToken,pairingToken};
}
export async function pairRelayCamera(db:Database,clock:Clock,actor:string,id:string,pairingToken:string) {
  return db.transaction(async tx=>{
    const s=(await tx.query<Station>('SELECT * FROM packing_relay_stations WHERE id=$1 AND actor_user_id=$2 FOR UPDATE',[id,actor])).rows[0];
    if(!s || !matches(pairingToken,s.pairing_token_hash)) throw new DomainError('RELAY_PAIRING_INVALID','This pairing request does not belong to your account',403);
    if(s.camera_paired_at) throw new DomainError('RELAY_ALREADY_PAIRED','This station already has a camera',409);
    if(new Date(s.pairing_expires_at).getTime()<clock.now().getTime() || s.state==='CANCELLED') throw new DomainError('RELAY_PAIRING_EXPIRED','Pairing expired. Start a new pairing from the controller.',409);
    const cameraToken=secret();
    const row=(await tx.query<Station>("UPDATE packing_relay_stations SET camera_token_hash=$2,camera_paired_at=$3,state='READY' WHERE id=$1 RETURNING *",[id,sha256Hex(cameraToken),clock.now().toISOString()])).rows[0];
    return {...view(row),cameraToken};
  });
}
export async function getRelayStation(db:Database,clock:Clock,actor:string,id:string,token:string) {
  const s=await stationAccess(db,clock,actor,id,token,'EITHER');
  const commands=(await db.query<{sequence:number;command_json:string;acknowledged_at:string|null}>('SELECT sequence,command_json,acknowledged_at FROM packing_relay_commands WHERE station_id=$1 AND sequence>$2 ORDER BY sequence',[id,s.acknowledged_sequence])).rows.map(c=>({...JSON.parse(c.command_json),acknowledgedAt:c.acknowledged_at}));
  const capture=s.active_capture_session_id && s.active_proof_id ? captureSessionView(await loadCaptureSession(db,actor,s.active_proof_id,s.active_capture_session_id)):null;
  return {...view(s),commands,capture};
}
export async function sendRelayCommand(db:Database,clock:Clock,actor:string,id:string,token:string,input:{sequence:number;idempotencyKey:string;type:string;proofId?:string}) {
  if ((input.proofId !== undefined && typeof input.proofId !== 'string') || !Number.isSafeInteger(input.sequence) || input.sequence<1 || typeof input.idempotencyKey!=='string' || !input.idempotencyKey.trim() || input.idempotencyKey.length>200 || !['SELECT_ORDER','START','FINISH','NEXT'].includes(input.type)) throw new DomainError('RELAY_COMMAND_INVALID','Use a valid deliberate station command with a sequence and retry key',400);
  const payload={sequence:input.sequence,type:input.type,proofId:input.proofId??null,idempotencyKey:input.idempotencyKey};
  const json=JSON.stringify(payload);
  return db.transaction(async tx=>{
    let s=await stationAccess(tx,clock,actor,id,token,'CONTROLLER',true);
    const replay=(await tx.query<{command_json:string}>('SELECT command_json FROM packing_relay_commands WHERE station_id=$1 AND (sequence=$2 OR idempotency_key=$3)',[id,input.sequence,input.idempotencyKey])).rows;
    if(replay.length) {
      if(replay.length!==1 || replay[0].command_json!==json) throw new DomainError('RELAY_COMMAND_CONFLICT','A repeated command cannot change its sequence or order',409);
      return {...view(s),command:payload,replayed:true};
    }
    if(!s.camera_paired_at) throw new DomainError('RELAY_CAMERA_REQUIRED','Pair the camera before issuing commands',409);
    if(input.sequence!==s.last_sequence+1) throw new DomainError('RELAY_SEQUENCE_CONFLICT','Resume from the station’s last accepted sequence',409);
    if(s.acknowledged_sequence!==s.last_sequence) throw new DomainError('RELAY_ACK_REQUIRED','Wait for the camera to acknowledge the preceding command',409);
    if (input.type==='SELECT_ORDER' || input.type==='NEXT') {
      if (s.active_capture_session_id && s.active_proof_id) {
        const previous=await loadCaptureSession(tx,actor,s.active_proof_id,s.active_capture_session_id);
        if(previous.state!=='COMMITTED') throw new DomainError('RELAY_SAVE_REQUIRED','Save the current recording before moving to another order',409);
      } else if (!['READY','SELECTED','SAVED'].includes(s.state)) throw new DomainError('RELAY_SAVE_REQUIRED','Finish saving the current order first',409);
      if(!input.proofId) throw new DomainError('RELAY_ORDER_REQUIRED','Choose the intended order',400);
      const proof=await loadProof(tx,input.proofId,true);assertNotFinalized(proof);
      const p=await requireParticipant(tx,input.proofId,actor);
      if(p.role!=='SELLER') throw new DomainError('PARTICIPANT_NOT_AUTHORIZED','Only seller orders can enter this station',403);
      if(!['READY_FOR_EVIDENCE','EVIDENCE_COMMITTED'].includes(proof.status)) throw new DomainError('INVALID_PROOF_TRANSITION','This order is not ready for recording',422);
      s=(await tx.query<Station>("UPDATE packing_relay_stations SET state='SELECTED',active_proof_id=$2,active_capture_session_id=NULL WHERE id=$1 RETURNING *",[id,input.proofId])).rows[0];
    } else if(input.type==='START') {
      if(s.state!=='SELECTED' || !s.active_proof_id) throw new DomainError('RELAY_ORDER_REQUIRED','Confirm the same selected order on both devices before starting',409);
      if(input.proofId && input.proofId!==s.active_proof_id) throw new DomainError('RELAY_ORDER_CONFLICT','This command targets a different order',409);
    } else if(input.type==='FINISH') {
      if(s.state!=='RECORDING' || !s.active_capture_session_id) throw new DomainError('RELAY_RECORDING_REQUIRED','The camera has not acknowledged recording',409);
      if(input.proofId && input.proofId!==s.active_proof_id) throw new DomainError('RELAY_ORDER_CONFLICT','This command targets a different order',409);
      await tx.query("UPDATE packing_relay_stations SET state='SAVING' WHERE id=$1",[id]);
    }
    await tx.query('INSERT INTO packing_relay_commands(station_id,sequence,idempotency_key,command_type,command_json,created_at) VALUES($1,$2,$3,$4,$5,$6)',[id,input.sequence,input.idempotencyKey,input.type,json,clock.now().toISOString()]);
    s=(await tx.query<Station>('UPDATE packing_relay_stations SET last_sequence=$2 WHERE id=$1 RETURNING *',[id,input.sequence])).rows[0];
    return {...view(s),command:payload,replayed:false};
  });
}
export async function acknowledgeRelayCommand(db:Database,clock:Clock,actor:string,id:string,token:string,input:{sequence:number;captureSessionId?:string}) {
  return db.transaction(async tx=>{
    let s=await stationAccess(tx,clock,actor,id,token,'CAMERA',true);
    if(!Number.isSafeInteger(input.sequence) || input.sequence<1 || input.sequence>s.last_sequence) throw new DomainError('RELAY_SEQUENCE_CONFLICT','No such accepted station command',409);
    const command=(await tx.query<{command_type:string;created_at:string|Date;capture_session_id:string|null}>('SELECT command_type,created_at,capture_session_id FROM packing_relay_commands WHERE station_id=$1 AND sequence=$2',[id,input.sequence])).rows[0];
    if(input.sequence<=s.acknowledged_sequence) {
      const boundCapture=command.command_type==='START'?command.capture_session_id:s.active_capture_session_id;
      if(input.captureSessionId && input.captureSessionId!==boundCapture) throw new DomainError('RELAY_ORDER_CONFLICT','An acknowledgement cannot rebind a recording',409);
      return {...view(s),replayed:true};
    }
    if(input.sequence!==s.acknowledged_sequence+1) throw new DomainError('RELAY_SEQUENCE_CONFLICT','Acknowledge commands in order',409);
    if(command.command_type==='START') {
      if(!input.captureSessionId || !s.active_proof_id) throw new DomainError('CAPTURE_SESSION_REQUIRED','The camera must start an authorized session for this order',422);
      const capture=await loadCaptureSession(tx,actor,s.active_proof_id,input.captureSessionId,true);
      if(capture.stage_id || capture.workflow_step!=='PACKING' || capture.policy_version!==CAPTURE_POLICY_VERSION || new Date(capture.created_at).getTime()<new Date(command.created_at).getTime())
        throw new DomainError('CAPTURE_SESSION_CONFLICT','The recording must belong to this order and have been authorized after this START command',409);
      if(capture.state==='ISSUED') {
        if(new Date(capture.expires_at).getTime()<clock.now().getTime()) throw new DomainError('CAPTURE_SESSION_EXPIRED','Start a fresh capture session before acknowledging record',409);
      } else if(capture.state!=='COMMITTED') assertCaptureRecoverable(capture,clock);
      const used=await tx.query('SELECT station_id FROM packing_relay_commands WHERE capture_session_id=$1 AND (station_id<>$2 OR sequence<>$3)',[capture.id,id,input.sequence]);
      if(used.rows.length) throw new DomainError('CAPTURE_SESSION_ALREADY_USED','This recording belongs to another station',409);
      await tx.query('UPDATE packing_relay_commands SET capture_session_id=$3 WHERE station_id=$1 AND sequence=$2',[id,input.sequence,capture.id]);
      const state=capture.state==='ISSUED'?'RECORDING':capture.state==='COMMITTED'?'SAVED':'SAVING';
      s=(await tx.query<Station>('UPDATE packing_relay_stations SET state=$3,active_capture_session_id=$2 WHERE id=$1 RETURNING *',[id,capture.id,state])).rows[0];
    } else if(command.command_type==='FINISH') {
      if(!s.active_proof_id || !s.active_capture_session_id) throw new DomainError('CAPTURE_SESSION_REQUIRED','No current recording',409);
      const capture=await loadCaptureSession(tx,actor,s.active_proof_id,s.active_capture_session_id);
      if(!['RECORDED','UPLOADING','COMMITTED'].includes(capture.state)) throw new DomainError('RELAY_SAVE_REQUIRED','Persist the current recording before acknowledging finish',409);
      if(capture.state==='COMMITTED') await tx.query("UPDATE packing_relay_stations SET state='SAVED' WHERE id=$1",[id]);
    }
    await tx.query('UPDATE packing_relay_commands SET acknowledged_at=$3 WHERE station_id=$1 AND sequence=$2',[id,input.sequence,clock.now().toISOString()]);
    s=(await tx.query<Station>('UPDATE packing_relay_stations SET acknowledged_sequence=$2 WHERE id=$1 RETURNING *',[id,input.sequence])).rows[0];
    return {...view(s),replayed:false};
  });
}
export async function renewRelayStation(db:Database,clock:Clock,actor:string,id:string,token:string) {
  return db.transaction(async tx=>{
    await stationAccess(tx,clock,actor,id,token,'EITHER',true);
    const row=(await tx.query<Station>('UPDATE packing_relay_stations SET expires_at=$2 WHERE id=$1 RETURNING *',[id,new Date(clock.now().getTime()+LEASE_MS).toISOString()])).rows[0];
    return view(row);
  });
}
