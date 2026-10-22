import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {CreateProofScreen} from '../screens/CreateProofScreen';
import {creationOperation,draftStorageKey,pendingCreationRequest,rejectCreationValidation,saveDraft} from '../first-experience/state';
import type {TransactionWriteInput} from '../api/types';
beforeEach(()=>{localStorage.clear();});afterEach(()=>{cleanup();vi.restoreAllMocks();});
const original:TransactionWriteInput={itemTitle:'Original camera',externalReference:null,itemDescription:null,currency:'USD',quantity:1,transactionValue:null,shipping:{carrier:null,trackingNumber:null},metadata:{intake:{source:'PARTICIPANT_SUPPLIED',confirmed:true}}};
function props(draftKey:string){return {draftKey,busy:false,error:'The connection closed.',development:false,ebayConnected:false,onCancel:vi.fn(),onScan:vi.fn(),onOpenAccount:vi.fn(),onAcceptInvitation:vi.fn(),onCreate:vi.fn(),onCreateGrading:vi.fn(),onImportPurchase:vi.fn(),onListEbayOrders:vi.fn(),onImportEbayOrder:vi.fn(),onConfirmImport:vi.fn()};}
it('persists the original fields with the stable operation and rejects substituting newer form edits',()=>{
 const key=draftStorageKey('/api','alice');const identity=creationOperation(key,original);
 expect(pendingCreationRequest(key)).toEqual(original);
 expect(creationOperation(key,{...original,shipping:{trackingNumber:null,carrier:null}})).toBe(identity);
 expect(()=>creationOperation(key,{...original,itemTitle:'Changed item'})).toThrow('Recover the submitted draft');
 expect(pendingCreationRequest(key)).toEqual(original);
 expect(pendingCreationRequest(draftStorageKey('/api','bob'))).toBeNull();
});
it('offers recovery of the exact submitted request after edits or reopening without creating a new operation',()=>{
 const key=draftStorageKey('/api','alice');const identity=creationOperation(key,original);
 saveDraft(key,{title:'New unsent title',reference:'',description:'',currency:'USD',quantity:'1',amount:'',carrier:'',tracking:'',intake:null});
 const options=props(key);render(<CreateProofScreen {...options}/>);
 expect(screen.getByRole('textbox',{name:'Item name'})).toHaveValue('New unsent title');
 expect(screen.getByRole('button',{name:/Continue to camera/})).toBeDisabled();
 expect(screen.getByText('Original camera')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'Recover submitted draft'}));
 expect(options.onCreate).toHaveBeenCalledExactlyOnceWith(original);
 expect(creationOperation(key,original)).toBe(identity);
});
it('allows corrected details only after a definitive creation validation rejection',()=>{
 const key=draftStorageKey('/api','alice');const identity=creationOperation(key,original);
 rejectCreationValidation(key);
 const corrected={...original,itemTitle:'Corrected item'};
 expect(creationOperation(key,corrected)).not.toBe(identity);expect(pendingCreationRequest(key)).toEqual(corrected);
});
it('can replay a previously persisted request when further storage writes are unavailable',()=>{
 const key=draftStorageKey('/api','alice');const identity=creationOperation(key,original);
 vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw new Error('Storage full');});
 expect(creationOperation(key,original)).toBe(identity);
 expect(()=>creationOperation(draftStorageKey('/api','bob'),original)).toThrow('Storage full');
});
