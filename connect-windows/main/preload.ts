import {contextBridge,ipcRenderer} from 'electron';
import type {ConnectBridge} from '../ui/types';
const call=(method:string,...args:unknown[])=>ipcRenderer.invoke(`connect:${method}`,...args).then(result=>{if(!result?.ok)throw Error(result?.error||'The background service needs attention.');return result.value;});
const bridge:ConnectBridge={
 chooseWorkspaceRelatedSource:(id,generation,role,related)=>call('chooseWorkspaceRelatedSource',id,generation,role,related),
 confirmWorkspaceOrderMap:(id,generation,profile)=>call('confirmWorkspaceOrderMap',id,generation,profile),
 workspaceSearchOrders:query=>call('workspaceSearchOrders',query),
 workspaceAttention:()=>call('workspaceAttention'),
 openWorkspaceReview:()=>call('openWorkspaceReview'),
 openWorkspaceOrder:(id,revision)=>call('openWorkspaceOrder',id,revision),
 getWorkspaceStatus:()=>call('getWorkspaceStatus'),addWorkspaceDirectSource:name=>name ? call('addWorkspaceDirectSource',name) : call('addWorkspaceDirectSource'),copyWorkspaceDirectProfile:id=>call('copyWorkspaceDirectProfile',id),
 workspaceDraftPreview:()=>call('workspaceDraftPreview'),
 workspaceOrderDetail:(id,revision)=>call('workspaceOrderDetail',id,revision),
 chooseWorkspaceFolder:role=>call('chooseWorkspaceFolder',role),
 reuseWorkspaceFolder:(id,role)=>call('reuseWorkspaceFolder',id,role),
 removeWorkspaceRole:(id,role)=>call('removeWorkspaceRole',id,role),
 inspectWorkspaceSource:id=>call('inspectWorkspaceSource',id),
 saveWorkspaceStep:step=>call('saveWorkspaceStep',step),
 chooseWorkspaceOutput:()=>call('chooseWorkspaceOutput'),
 activateWorkspace:pending=>pending ? call('activateWorkspace',true) : call('activateWorkspace'),
 pauseWorkspaceSource:id=>call('pauseWorkspaceSource',id),
 resumeWorkspaceSource:id=>call('resumeWorkspaceSource',id),
 openWorkspaceApproval:()=>call('openWorkspaceApproval'),
 openWorkspaceOutput:()=>call('openWorkspaceOutput'),
 chooseBackfillFiles:input=>call('chooseBackfillFiles',input),proposeBackfill:input=>call('proposeBackfill',input),pauseBackfill:input=>call('pauseBackfill',input),resumeBackfill:input=>call('resumeBackfill',input),openBackfillApproval:input=>call('openBackfillApproval',input),chooseNewSubscriptionFolder:()=>call('chooseNewSubscriptionFolder'),inspectSubscriptionDraft:name=>call('inspectSubscriptionDraft',name),proposeSubscription:input=>call('proposeSubscription',input),chooseSubscriptionFolder:id=>call('chooseSubscriptionFolder',id),inspectSubscriptionFile:input=>call('inspectSubscriptionFile',input),previewSubscription:input=>call('previewSubscription',input),commitSubscription:input=>call('commitSubscription',input),verifySubscription:id=>call('verifySubscription',id),pauseSubscription:id=>call('pauseSubscription',id),resumeSubscription:id=>call('resumeSubscription',id),openSubscriptionApproval:id=>call('openSubscriptionApproval',id),openSubscriptionCase:id=>call('openSubscriptionCase',id),getStatus:()=>call('getStatus'),analyzeLocal:input=>call('analyzeLocal',input),startSetup:consent=>call('startSetup',consent),recoverEnrollment:consent=>call('recoverEnrollment',consent),checkComputer:()=>call('checkComputer'),beginEnrollment:()=>call('beginEnrollment'),pollEnrollment:()=>call('pollEnrollment'),chooseFolder:()=>call('chooseFolder'),previewLocal:name=>call('previewLocal',name),proposeConfiguration:config=>call('proposeConfiguration',config),previewCloud:consent=>call('previewCloud',consent),commitBatch:consent=>call('commitBatch',consent),verifyImport:()=>call('verifyImport'),proposeActivation:()=>call('proposeActivation'),activate:()=>call('activate'),pause:()=>call('pause'),resume:()=>call('resume'),refresh:()=>call('refresh'),openApproval:()=>call('openApproval'),openRecord:id=>call('openRecord',id),openPortal:()=>call('openPortal'),exportDiagnostics:()=>call('exportDiagnostics')};
contextBridge.exposeInMainWorld('packproofConnect',bridge);
