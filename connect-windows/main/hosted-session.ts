import { ipcMain, type BrowserWindow } from 'electron';
import type { ConnectStatus } from '../ui/types';
import { trustedRenderer } from './security';
import { installationReviewPath, workspaceParams } from './approval-target';
import { openHumanDashboard, closeHumanDashboard } from './human-dashboard';
import type { HumanDashboardIdentity } from './dashboard-grant';
import { FacilityDraftLease } from './facility-draft-lease';
import type { FacilityDraft } from '../ui/guided-workflow-types';

export interface FacilityScope { installationId: string; organizationId: string; environment: string }
interface Access { canConfigure: boolean; organizationId: string; environment: string; locationId: string | null; userId: string }
interface PendingFileReview { proposalSha256:string; fileName:string; expiresAt:string }
interface SetupAccess extends FacilityScope { locationId: string | null; userId: string; state: string; pendingFileReview?:PendingFileReview }
interface BoundScope extends FacilityScope { locationId: string | null; operatorMembershipId: string; integrationAccountId: string }
interface Authority {
  user: string; epoch: number; scopeKey: string; offline: boolean;
  mode: 'enrollment' | 'bootstrap' | 'facility'; canConfigure: boolean; canReadOrders: boolean;
  installationId?: string; enrollmentId?: string; scope?: BoundScope; setup?: SetupAccess; canRecover?: boolean;
}
interface HumanSession {
  user(): string | null;
  dashboardIdentity(): HumanDashboardIdentity;
  access(scope: FacilityScope): Promise<Access>;
  setupAccess(locator: { installationId: string; environment: 'sandbox' | 'live'; organizationId?: string }): Promise<SetupAccess>;
  suggest(scope: FacilityScope, input: unknown): Promise<unknown>;
  review(scope: FacilityScope, input: unknown): Promise<void>;
}
type LocalRead = (operation: string) => Promise<unknown>;
const enrollment = new Set(['getStatus','getWorkspaceStatus','beginEnrollment','pollEnrollment','refresh','openApproval','openWorkspaceApproval']);
const bootstrap = new Set(['choices','getStatus','getWorkspaceStatus','pollEnrollment','refresh','openApproval','openWorkspaceApproval','recoverEnrollment','refreshPendingFileReview']);
const completingEnrollment = new Set(['pollEnrollment','getStatus','refresh']);
const isMissing = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 404;
function reviewMetadata(authority:Authority):PendingFileReview|undefined {
  const setup=authority.setup, review=setup?.pendingFileReview;
  if(authority.mode!=='bootstrap'||authority.offline||authority.canRecover||setup?.state!=='setup'||setup.locationId!==null||!review||
     typeof review.proposalSha256!=='string'||!/^[a-f0-9]{64}$/.test(review.proposalSha256)||
     typeof review.fileName!=='string'||!/^.{1,251}\.csv$/i.test(review.fileName)||/[\x00-\x1f\x7f/\\:]/.test(review.fileName)||
     typeof review.expiresAt!=='string'||!Number.isFinite(Date.parse(review.expiresAt))) return;
  return {proposalSha256:review.proposalSha256,fileName:review.fileName,expiresAt:review.expiresAt};
}
export class HostedSession {
  private lease=new FacilityDraftLease();
  private sessionEpoch=0;
  constructor(private human: HumanSession, private read: LocalRead, private portal: string, private parentWindow?:()=>BrowserWindow|null) {}
  private signedIn() {
    const user = this.human.user();
    if (!user) {this.lease.clear();throw Error('Sign in to PackProof to open Logistics.');}
    return user;
  }
  private localScope(current: ConnectStatus): BoundScope | null {
    if (!current.installationId) {this.lease.clear();return null;}
    if (!current.binding || ['revoked','permission_required'].includes(current.state)) {this.lease.clear();return null;}
    const query = workspaceParams(current);
    const organizationId = query.get('organizationId'), environment = query.get('environment');
    if (!organizationId || !environment) throw Error('Reconnect the installation to its facility.');
    return { installationId: current.installationId, organizationId, environment,locationId:current.binding.locationId,
      operatorMembershipId:current.binding.operatorMembershipId,integrationAccountId:current.binding.integrationAccountId };
  }
  async scope() { return this.localScope(await this.read('status') as ConnectStatus); }
  async verify(scope: BoundScope, user:string,method:string) {
    const binding={user,...scope};
    const epoch=this.sessionEpoch;
    try {
      const access=await this.human.access(scope);
      if (this.sessionEpoch!==epoch || access.userId!==user || this.human.user()!==user || scope.organizationId!==access.organizationId ||
          scope.environment!==access.environment || scope.locationId!==access.locationId) throw Error('Your workspace changed. Open Logistics again.');
      this.lease.observe(binding,access.canConfigure);
      return {...access,offline:false};
    } catch(error) {
      if(this.sessionEpoch===epoch && this.human.user()===user && this.lease.allows(binding,method,error))
        return {...scope,userId:user,canConfigure:true,offline:true};
      throw error;
    }
  }
  private async authority(method: string): Promise<Authority> {
    const user = this.signedIn(), epoch = this.sessionEpoch;
    const current = await this.read('status') as ConnectStatus, scope = this.localScope(current);
    const stable = () => { if (this.human.user() !== user || this.sessionEpoch !== epoch) throw Error('Your session changed.'); };
    stable();
    const base = {user,epoch,installationId:current.installationId,enrollmentId:current.enrollment?.id};
    if (!current.installationId) {
      if (method !== 'choices' && !enrollment.has(method)) throw Error('Connect this computer to a facility first.');
      return {...base,mode:'enrollment',scopeKey:'null',offline:false,canConfigure:false,canReadOrders:false};
    }
    if (scope) {
      try {
        const access = await this.verify(scope,user,method); stable();
        return {...base,mode:'facility',scopeKey:JSON.stringify(scope),scope,offline:access.offline,
          canConfigure:access.canConfigure,canReadOrders:!access.offline};
      } catch (error) {
        stable();
        if (!isMissing(error) || !bootstrap.has(method)) throw error;
      }
    }
    this.lease.clear();
    if (!bootstrap.has(method)) throw Error('Review this computer’s connection before choosing records.');
    if (!['development','staging','sandbox','live','production'].includes(current.environment)) throw Error('Refresh this computer’s connection.');
    const environment = current.environment === 'live' || current.environment === 'production' ? 'live' : 'sandbox';
    const setup = await this.human.setupAccess({installationId:current.installationId,environment,...(scope ? {organizationId:scope.organizationId} : {})});
    stable();
    if (setup.userId !== user || setup.installationId !== current.installationId || setup.environment !== environment ||
        (scope && (setup.organizationId !== scope.organizationId || setup.locationId !== scope.locationId))) throw Error('Your workspace changed. Open Logistics again.');
    const canRecover = current.recoveryAvailable === true;
    const localDenied=['revoked','permission_required'].includes(current.state) ||
      current.transport?.state==='forbidden' || current.transport?.state==='unauthenticated';
    if (method === 'recoverEnrollment' && !canRecover) throw Error('Review this installation in PackProof before replacing its approval.');
    return {...base,mode:'bootstrap',scopeKey:JSON.stringify([setup.installationId,setup.organizationId,setup.environment,setup.locationId]),
      offline:false,canConfigure:false,canReadOrders:false,setup:localDenied?{...setup,pendingFileReview:undefined}:setup,canRecover};
  }
  async choices() {
    const access = await this.authority('choices');
    return {setup:access.mode !== 'facility' || access.canConfigure,orders:access.canReadOrders};
  }
  async guard(method: string) {
    const access = await this.authority(method);
    if (access.mode === 'facility' && !access.canConfigure) throw Error('Facility setup requires an authorized administrator.');
    return access;
  }
  assertTransition(method: string, started: Authority, ended: Authority) {
    if (started.user !== ended.user || this.human.user() !== started.user || started.epoch !== ended.epoch ||
        this.sessionEpoch !== started.epoch) throw Error('Your account changed.');
    if (started.scopeKey === ended.scopeKey && (started.enrollmentId === ended.enrollmentId || method === 'beginEnrollment')) return;
    // These are the only expected identity changes in the native enrollment protocol.
    if (method === 'recoverEnrollment' && started.mode === 'bootstrap' && started.canRecover &&
        ended.mode === 'enrollment' && !ended.installationId && !ended.enrollmentId) return;
    if (completingEnrollment.has(method) && started.mode === 'enrollment' && started.enrollmentId &&
        ended.installationId && ended.enrollmentId === started.enrollmentId) return;
    throw Error('Your workspace changed. Open Logistics again.');
  }
  installationReviewPath(access: Authority) {
    if (access.mode !== 'bootstrap' || !access.setup || access.epoch !== this.sessionEpoch || this.human.user() !== access.user)
      throw Error('Refresh this computer’s connection before opening its review.');
    return installationReviewPath(access.setup,true);
  }
  async openPendingFileReview(start:Authority,input:{wholeFileUploadApproved:boolean;expectedProposalSha256:string},
    renew:(payload:Record<string,unknown>)=>Promise<unknown>,open:(path:string)=>Promise<void>) {
    const pending=reviewMetadata(start), scope=start.setup;
    if (!scope || !pending || pending.proposalSha256!==input.expectedProposalSha256 || this.human.user()!==start.user || this.sessionEpoch!==start.epoch)
      throw Error('The saved file review changed. Check the connection again.');
    let target=pending.proposalSha256;
    if (Date.parse(pending.expiresAt)<=Date.now()) {
      if(input.wholeFileUploadApproved!==true)throw Error('Confirm that PackProof may recheck this saved file before renewing its review.');
      const result=await renew({installationId:scope.installationId,organizationId:scope.organizationId,environment:scope.environment,
        expectedProposalSha256:target,wholeFileUploadApproved:true});
      const updated=result as Partial<FacilityScope & {proposalSha256:string}>|null;
      if(!updated||updated.installationId!==scope.installationId||updated.organizationId!==scope.organizationId||updated.environment!==scope.environment||
         typeof updated.proposalSha256!=='string'||!/^[a-f0-9]{64}$/.test(updated.proposalSha256)||updated.proposalSha256===target)
        throw Error('The renewed file review could not be verified. Check the connection again.');
      target=updated.proposalSha256;
    }
    const end=await this.guard('refreshPendingFileReview');
    this.assertTransition('refreshPendingFileReview',start,end);
    const verified=reviewMetadata(end);
    if(!end.setup||!verified||verified.proposalSha256!==target||verified.fileName!==pending.fileName||Date.parse(verified.expiresAt)<=Date.now())
      throw Error('The current file review could not be verified. Check the connection again.');
    await open(installationReviewPath(end.setup));
  }
  present(method: string, value: unknown, authority: Authority) {
    const offline = authority.offline;
    if(offline && (method==='getFacilityDraft' || method==='saveFacilityNotes')) {
      const d=value as FacilityDraft;
      return {id:d.id,revision:d.revision,scopeKey:d.scopeKey,steps:d.steps,examples:d.examples,rules:[],excludedSourceIds:[],replay:null,notesOnly:true};
    }
    if (!value || typeof value !== 'object' || !('health' in value && 'state' in value)) return value;
    const current = value as ConnectStatus;
    if (current.installationId !== authority.installationId) throw Error('The installation changed. Open Logistics again.');
    if (authority.mode === 'bootstrap') return {state:current.state,installationId:current.installationId,environment:current.environment,
      installedVersion:current.installedVersion,recoveryAvailable:authority.canRecover,
      setupAccess:{...(reviewMetadata(authority) ? {pendingFileReview:reviewMetadata(authority)} : {}),reason:authority.canRecover || authority.setup?.state === 'revoked' ? 'reapproval_required' :
        authority.setup?.locationId === null ? 'facility_required' : 'facility_unavailable'},
      health:{serviceOnline:current.health.serviceOnline,queueCount:null},
      workspace:{phase:'draft',step:'order',sources:[],canReadOrders:false}};
    if(offline) return {state:current.state,installationId:current.installationId,environment:current.environment,
      health:{serviceOnline:current.health.serviceOnline,queueCount:null},workspace:{phase:'draft',step:'order',sources:[],
      guidedSetupAvailable:current.workspace?.guidedSetupAvailable,offlineDraftOnly:true}};
    if (!current.installationId) {
      if (!enrollment.has(method) && method !== 'recoverEnrollment') throw Error('Enroll this computer first.');
      return {state:current.state, environment:current.environment, enrollment:current.enrollment,
        setupAccess:{reason:'enrollment_required'},
        health:{serviceOnline:current.health.serviceOnline,queueCount:null}, workspace:{phase:'draft',step:'order',sources:[]}};
    }
    // Daily records are returned by the human session. Setup only needs collection configuration.
    return {...current,workspace: current.workspace && {...current.workspace,orders:[],canReadOrders:false}};
  }
  async daily(target?: { proofId?: string; revision?: number; subject?: string }) {
    const access = await this.authority('daily');
    if (!access.canReadOrders || access.mode !== 'facility' || !access.scope) throw Error('Connect this computer to an authorized facility before opening orders.');
    return openHumanDashboard(this.portal, { ...access.scope, expectedUserId: access.user }, target, this.human.dashboardIdentity(), this.parentWindow?.()??undefined);
  }
  bindAssistant(window: () => BrowserWindow | null) {
    for (const action of ['suggest','review'] as const) ipcMain.handle('host:'+action, async (event, input: { draftId?: unknown; revision?: unknown }) => {
      const win = window();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
          !trustedRenderer(event.senderFrame.url)) throw Error('Open setup in the signed-in application.');
      const {user} = await this.guard('suggest'), scope = await this.scope();
      if (!scope) throw Error('Connect this facility first.');
      if (action === 'review') return this.human.review(scope,input);
      const check = async () => {
        const draft = await this.read('getFacilityDraft') as {id: string; revision: number};
        if (user !== this.human.user() || draft.id !== input?.draftId || draft.revision !== input?.revision)
          throw Error('The setup draft changed.');
      };
      await check();
      const result = await this.human.suggest(scope, input);
      await check();
      return result;
    });
  }
  close() {this.sessionEpoch++;this.lease.clear(); closeHumanDashboard(); }
}
