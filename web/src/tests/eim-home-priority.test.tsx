import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MobileHomeScreen } from '../mobile-task/MobileHomeScreen';
import { classifyProofPresentation } from '../../../backend/src/domain/proof-presentation';
import type { LocalRecordingSummary } from '../capture-queue';
import { summary } from './fixtures';
afterEach(cleanup);
it('keeps a second Proof recovery ahead of a passive upload without changing its identity',()=>{
 const first={...summary,presentation:classifyProofPresentation(summary)};
 const second={...first,proofId:'proof_second',transaction:{...first.transaction,itemTitle:'Second packing record'}};
 const base={key:'active-operation',proofId:first.proofId,kind:'station',file:new Blob(['fixture'],{type:'video/webm'}),available:true,accepted:true,committed:false,finalized:false,preserved:false} as LocalRecordingSummary;
 const action=vi.fn(),go=vi.fn();
 render(<MobileHomeScreen proofs={[first,second]} recordings={[{...base,active:true},{...base,key:'interrupted-second',proofId:second.proofId,accepted:false,interrupted:true}]} queue={[]} loading={false} recordingsLoaded error={null} refreshedAt="2026-10-24T12:00:00Z" busy={false} notice={null} interactions={{}} onGo={go} onRetry={()=>{}} onAction={action} onOpen={()=>{}}/>);
 fireEvent.click(screen.getByRole('button',{name:'Review recovery'}));
 expect(action).toHaveBeenCalledWith(expect.objectContaining({kind:'review_upload',targetId:second.proofId,sessionId:'interrupted-second'}));
 expect(screen.queryByRole('button',{name:'View upload progress'})).not.toBeInTheDocument();
 expect(go).not.toHaveBeenCalled();
});
