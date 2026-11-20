import { ipcMain, type BrowserWindow } from 'electron';
import type { ConnectStatus } from '../ui/types';
import { trustedRenderer } from './security';
import { workspaceParams } from './approval-target';
import { openHumanDashboard, closeHumanDashboard } from './human-dashboard';
import type { HumanDashboardIdentity } from './dashboard-grant';

export interface FacilityScope { installationId: string; organizationId: string; environment: string }
interface Access { canConfigure: boolean; organizationId: string; environment: string; locationId: string | null; userId: string }
interface HumanSession {
  user(): string | null;
  dashboardIdentity(): HumanDashboardIdentity;
  access(scope: FacilityScope): Promise<Access>;
  suggest(scope: FacilityScope, input: unknown): Promise<unknown>;
}
type LocalRead = (operation: string) => Promise<unknown>;
const enrollment = new Set(['getStatus','beginEnrollment','pollEnrollment','refresh','openApproval','openWorkspaceApproval']);
export class HostedSession {
  constructor(private human: HumanSession, private read: LocalRead, private portal: string) {}
  private signedIn() {
    const user = this.human.user();
    if (!user) throw Error('Sign in to PackProof to open Logistics.');
    return user;
  }
  async scope() {
    const current = await this.read('status') as ConnectStatus;
    if (!current.installationId) return null;
    const query = workspaceParams(current);
    const organizationId = query.get('organizationId'), environment = query.get('environment');
    if (!organizationId || !environment) throw Error('Reconnect the installation to its facility.');
    return { installationId: current.installationId, organizationId, environment };
  }
  async verify(scope: FacilityScope, user: string) {
    const access = await this.human.access(scope);
    if (access.userId !== user || this.human.user() !== user || scope.organizationId !== access.organizationId || scope.environment !== access.environment)
      throw Error('Your workspace changed. Open Logistics again.');
    return access;
  }
  async choices() {
    const user = this.signedIn(), scope = await this.scope();
    if (!scope) return { setup: true, orders: false };
    const access = await this.verify(scope, user);
    return { setup: access.canConfigure, orders: true };
  }
  async guard(method: string) {
    const user = this.signedIn(), scope = await this.scope();
    if (!scope) {
      if (!enrollment.has(method)) throw Error('Connect this computer to a facility first.');
    } else if (!(await this.verify(scope, user)).canConfigure) throw Error('Facility setup requires an authorized administrator.');
    if (this.human.user() !== user) throw Error('Your session changed.');
    return user;
  }
  present(method: string, value: unknown) {
    if (!value || typeof value !== 'object' || !('health' in value && 'state' in value)) return value;
    const current = value as ConnectStatus;
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
    const access = await this.verify(scope, user);
    return openHumanDashboard(this.portal, { ...scope, locationId: access.locationId, expectedUserId: user }, target, this.human.dashboardIdentity());
  }
  bindAssistant(window: () => BrowserWindow | null) {
    ipcMain.handle('host:suggest', async (event, input: { draftId?: unknown; revision?: unknown }) => {
      const win = window();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
          !trustedRenderer(event.senderFrame.url)) throw Error('Open setup in the signed-in application.');
      const user = await this.guard('suggest'), scope = await this.scope();
      if (!scope) throw Error('Connect this facility first.');
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
  close() { closeHumanDashboard(); }
}
