import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {UploadRecoveryCards} from '../components/UploadRecoveryCards';
import {canonicalProof} from './fixtures';
import type {PackProofApi} from '../api/client';
const mocks=vi.hoisted(()=>({list:vi.fn(),resume:vi.fn(),discard:vi.fn()}));
vi.mock('../capture-queue',()=>({listRecoverableRecordings:mocks.list,resumeLocalRecording:mocks.resume,discardLocalRecording:mocks.discard}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
const api={recoveryScope:'https://api.test',discardIncompleteEvidence:vi.fn()} as unknown as PackProofApi;
const proof={...canonicalProof,evidence:[{...canonicalProof.evidence[0],evidenceId:'original',submittedBy:'seller',validationStatus:'PENDING' as const}]};
it('shows Resume and Discard directly on an interrupted recording card and resumes that record',async()=>{
  const item={key:'saved',proofId:proof.proofId,evidenceId:'original',available:true,active:false,kind:'ordinary',accepted:true};mocks.list.mockResolvedValue([item]);
  render(<UploadRecoveryCards api={api} userId="seller" proof={proof}/>);
  expect(await screen.findByText('Upload interrupted')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Discard recording'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Resume upload'}));await waitFor(()=>expect(mocks.resume).toHaveBeenCalledWith(api,'seller',item));
});
it('a pending server row without local bytes never claims an active upload',async()=>{
  mocks.list.mockResolvedValue([]);render(<UploadRecoveryCards api={api} userId="seller" proof={proof}/>);
  expect(await screen.findByText('Upload could not be completed')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Discard incomplete evidence'})).toBeTruthy();expect(screen.queryByText('Uploading')).toBeNull();expect(screen.queryByRole('button',{name:'Resume upload'})).toBeNull();
});
it('committed evidence never offers discard even with missing bytes',async()=>{
  mocks.list.mockResolvedValue([{key:'saved',proofId:proof.proofId,evidenceId:'original',available:false,kind:'ordinary',accepted:true}]);
  render(<UploadRecoveryCards api={api} userId="seller" proof={{...proof,evidence:[{...proof.evidence[0],validationStatus:'COMMITTED'}]}}/>);
  expect(await screen.findByText('Recording received')).toBeTruthy();expect(screen.queryByRole('button',{name:/Discard/})).toBeNull();
});
