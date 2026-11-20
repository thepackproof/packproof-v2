import { ipcMain, type BrowserWindow } from 'electron';
import type { ConnectStatus } from '../ui/types';
import { trustedRenderer } from './security';
import { workspaceParams } from './approval-target';
import { openHumanDashboard, closeHumanDashboard } from './human-dashboard';
import type { HumanDashboardIdentity } from './dashboard-grant';
import { FacilityDraftLease } from './facility-draft-lease';
import type { FacilityDraft } from '../ui/guided-workflow-types';

export interface FacilityScope { installationId: string; organizationId: string; environment: string }
interface Access { canConfigure: boolean; organizationId: string; environment: string; locationId: string | null; userId: string }
interface HumanSession {
  user(): string | null;
  dashboardIdentity(): HumanDashboardIdentity;
  access(scope: FacilityScope): Promise<Access>;
  suggest(scope: FacilityScope, input: unknown): Promise<unknown>;
  review(scope: FacilityScope, input: unknown): Promise<void>;
}
type LocalRead = (operation: string) => Promise<unknown>;
const enrollment = new Set(['getStatus','beginEnrollment','pollEnrollment','refresh','openApproval','openWorkspaceApproval']);
export class HostedSession {
  private lease=new FacilityDraftLease();
  private sessionEpoch=0;
  constructor(private human: HumanSession, private read: LocalRead, private portal: string) {}
  private signedIn() {
    const user = this.human.user();
    if (!user) {this.lease.clear();throw Error('Sign in to PackProof to open Logistics.');}
    return user;
  }
  async scope() {
    const current = await this.read('status') as ConnectStatus;
    if (!current.installationId) {this.lease.clear();return null;}
    if (!current.binding || ['revoked','permission_required'].includes(current.state)) {this.lease.clear();throw Error('Reconnect this computer to its authorized facility.');}
    const query = workspaceParams(current);
    const organizationId = query.get('organizationId'), environment = query.get('environment');
    if (!organizationId || !environment) throw Error('Reconnect the installation to its facility.');
    return { installationId: current.installationId, organizationId, environment,locationId:current.binding.locationId,
      operatorMembershipId:current.binding.operatorMembershipId,integrationAccountId:current.binding.integrationAccountId };
  }
  async verify(scope: NonNullable<Awaited<ReturnType<HostedSession['scope']>>>, user:string,method:string) {
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
  async choices() {
    const user = this.signedIn(), scope = await this.scope();
    if (!scope) return { setup: true, orders: false };
    const access = await this.verify(scope, user,'choices');
    return { setup: access.canConfigure, orders: !access.offline };
  }
  async guard(method: string) {
    const user = this.signedIn(), scope = await this.scope();
    let offline=false;
    if (!scope) {
      if (!enrollment.has(method)) throw Error('Connect this computer to a facility first.');
    } else {
      const access=await this.verify(scope,user,method);
      if(!access.canConfigure) throw Error('Facility setup requires an authorized administrator.');
      offline=access.offline;
    }
    if (this.human.user() !== user) throw Error('Your session changed.');
    return {user,scopeKey:JSON.stringify(scope),offline};
  }
  present(method: string, value: unknown,offline=false) {
    if(offline && (method==='getFacilityDraft' || method==='saveFacilityNotes')) {
      const d=value as FacilityDraft;
      return {id:d.id,revision:d.revision,scopeKey:d.scopeKey,steps:d.steps,examples:d.examples,rules:[],excludedSourceIds:[],replay:null,notesOnly:true};
    }
    if (!value || typeof value !== 'object' || !('health' in value && 'state' in value)) return value;
    const current = value as ConnectStatus;
    if(offline) return {state:current.state,installationId:current.installationId,environment:current.environment,
      health:{serviceOnline:current.health.serviceOnline,queueCount:null},workspace:{phase:'draft',step:'order',sources:[],
      guidedSetupAvailable:current.workspace?.guidedSetupAvailable,offlineDraftOnly:true}};
    if (!current.installationId) {
      if (!enrollment.has(method)) throw Error('Enroll this computer first.');
      return {state:current.state, environment:current.environment, enrollment:current.enrollment,
        health:{serviceOnline:current.health.serviceOnline,queueCount:null}, workspace:{phase:'draft',step:'order',sources:[]}};
    }
    // Daily records are returned by the human session. Setup only needs collection configuration.
    return {...current,workspace: current.workspace && {...current.workspace,orders:[],canReadOrders:false}};
  }
  async daily(target?: { proofId?: string; revision?: number; subject?: string }) {
    const user = this.signedIn(), scope = await this.scope();
    if (!scope) throw Error('Connect this computer to a facility first.');
    const access = await this.verify(scope, user,'daily');
    return openHumanDashboard(this.portal, { ...scope, locationId: access.locationId, expectedUserId: user }, target, this.human.dashboardIdentity());
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
