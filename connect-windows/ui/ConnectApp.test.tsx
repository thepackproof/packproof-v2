// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ConnectApp } from './ConnectApp';
import { analysis, bridgeFor, selected, configuration } from './test-fixtures';
import type { ConnectStatus } from './types';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('fails closed when the installed bridge is absent',()=>{
 render(<ConnectApp/>);expect(screen.getByRole('alert')).toHaveTextContent('secure Windows helper');expect(screen.getByRole('button',{name:'Sign in and approve this computer'})).toBeDisabled();
});
it('shows the service-validated shipment without technical inputs or a blanket correctness checkbox',async()=>{
 const bridge=bridgeFor(selected);render(<ConnectApp bridge={bridge}/>);
 expect(await screen.findByRole('heading',{name:'Does this shipment look right?'})).toBeVisible();
 expect(screen.getByRole('heading',{name:'PP-TEST-20261113-001'})).toBeVisible();expect(screen.getByText('<script>alert(1)</script> =SUM(1)')).toBeVisible();expect(document.querySelector('script')).toBeNull();
 expect(screen.queryByLabelText(/software version|polling|time zone/i)).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();expect(bridge.previewCloud).not.toHaveBeenCalled();expect(bridge.startSetup).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Continue'}));
 expect(screen.getByText(/entire original report is uploaded and preserved/)).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Approve and connect'}));await waitFor(()=>expect(bridge.startSetup).toHaveBeenCalledWith({wholeFileUploadApproved:true,draftRevision:1}));expect(bridge.commitBatch).not.toHaveBeenCalled();
});
it('blocks a stale bad mapping and asks only for the unresolved detail',async()=>{
 const bad={...analysis,ready:false,decisions:analysis.decisions.map(d=>d.field==='quantity'?{...d,state:'incompatible' as const,sourceColumnId:'Shipment date',reasonCodes:['VALUE_TYPE_OR_RANGE'],candidates:['Quantity']}:d)};
 render(<ConnectApp bridge={bridgeFor({...selected,analysis:bad})}/>);await screen.findByRole('heading',{name:'Review quantity'});expect(screen.getByRole('button',{name:'Continue'})).toBeDisabled();expect(screen.queryByText(/7 of 7 matched/)).toBeNull();
});
it('a queued receipt never unlocks active collection or implies a canonical record',async()=>{
 const current:ConnectStatus={...selected,setup:{running:true,phase:'first_import_pending'},preview:{id:'import-fixture',previewVersion:'v',state:'queued',original:{sha256:'b'.repeat(64),byteSize:200},counts:{valid:1},rows:[],recordIds:[]}};
 render(<ConnectApp bridge={bridgeFor(current)}/>);await screen.findByRole('heading',{name:'Complete your browser review'});expect(screen.queryByRole('heading',{name:'Your connection is active'})).toBeNull();expect(screen.getByText(/Record creation has not yet been confirmed/)).toBeVisible();expect(screen.queryByRole('button',{name:'Open shipment records'})).toBeNull();
});
it('requires informed preservation consent before installation recovery',async()=>{
 const current={...selected,state:'revoked',recoveryAvailable:true};const bridge=bridgeFor(current);render(<ConnectApp bridge={bridge}/>);await screen.findByRole('heading',{name:'Recover this installation'});const button=screen.getByRole('button',{name:'Begin approved recovery'});expect(button).toBeDisabled();fireEvent.click(screen.getByRole('checkbox',{name:/Preserve former pending work/}));fireEvent.click(button);await waitFor(()=>expect(bridge.recoverEnrollment).toHaveBeenCalledWith({preservePendingWorkApproved:true}));
});
it('presents three stages and explains folder access without reading the filesystem',async()=>{
 const bridge=bridgeFor({...selected,source:undefined,analysis:undefined});render(<ConnectApp bridge={bridge}/>);await screen.findByRole('heading',{name:'Choose your shipment folder'});expect(screen.getByRole('navigation',{name:'Setup progress'}).querySelectorAll('li')).toHaveLength(3);fireEvent.click(screen.getByText('Help finding your shipment reports'));expect(bridge.chooseFolder).not.toHaveBeenCalled();expect(screen.getByText(/Network shares and direct database connections/)).toBeVisible();
});
it('shows non-destructive repair guidance when the helper cannot be reached',async()=>{
 render(<ConnectApp bridge={bridgeFor(selected,{getStatus:vi.fn(async()=>{throw Error('Helper stopped');})})}/>);await screen.findByRole('heading',{name:'The background helper needs attention.'});expect(screen.getByRole('button',{name:'Check again'})).toBeEnabled();expect(screen.getByText(/Keep the protected data folder/)).toBeVisible();
});
it('observes browser enrollment and advances without a check-approval action',async()=>{
 vi.useFakeTimers();const waiting:ConnectStatus={state:'needs_approval',environment:'sandbox',health:{serviceOnline:true,queueCount:0},enrollment:{id:'fixture',comparisonCode:'CODE-123',expiresAt:'2026-12-01T00:00:00Z',state:'pending'}};
 const bridge=bridgeFor(waiting,{pollEnrollment:vi.fn(async()=>({...selected,source:undefined,analysis:undefined}))});render(<ConnectApp bridge={bridge}/>);await act(async()=>{await Promise.resolve();await Promise.resolve();});expect(screen.getByText(/This window checks automatically/)).toBeVisible();await act(async()=>{vi.advanceTimersByTime(6000);await Promise.resolve();await Promise.resolve();});expect(bridge.pollEnrollment).toHaveBeenCalledTimes(1);expect(screen.getByRole('heading',{name:'Choose your shipment folder'})).toBeVisible();expect(screen.queryByRole('button',{name:/Check approval/})).toBeNull();
});
it('requires current verification plus the service active acknowledgement for completion',async()=>{
 const current:ConnectStatus={...selected,config:configuration,configRevision:1,state:'active',verification:{complete:true,recordId:'proof-fixture',configRevision:1,fileSha256:selected.source!.fileSha256}};
 const bridge=bridgeFor(current);render(<ConnectApp bridge={bridge}/>);await screen.findByRole('heading',{name:'Your connection is active'});fireEvent.click(screen.getByRole('button',{name:'Open shipment records'}));expect(bridge.openRecord).toHaveBeenCalledWith('proof-fixture');
});
