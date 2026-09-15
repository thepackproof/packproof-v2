import { render,screen,fireEvent,cleanup } from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {IdentifierDetails} from '../components/IdentifierDetails';
import type {IdentifierResolution} from '../../../backend/src/identifiers/types';
afterEach(cleanup);
const row={observationId:'one',state:'MATCH',identifiers:[{type:'GTIN',normalizedValue:'00036000291452',value:'036000291452',validationResult:'VALID'}],product:{title:'Real imported title',sku:'Blue-001',variant:null,sourceKind:'ORDER_SNAPSHOT',sourceRef:'order-line-1',sourceRevision:'7'},expected:[{title:'Expected title',sku:'Blue-001',gtin:'00036000291452'}],receivedAt:'2026-09-09T10:00:00Z',decision:null,observation:{rawText:'<script>fetch("https://invalid.test")</script>',captureSessionId:'session-1',source:'LIVE_CAMERA_ANALYSIS',timestampOrigin:'MONOTONIC_APPROXIMATE',mediaTimeMs:2100},supplemental:false} as unknown as IdentifierResolution;
it('shows source-backed observed and expected identifiers without exposing or executing raw payloads',()=>{
  const jump=vi.fn();const {container}=render(<IdentifierDetails value={{schemaVersion:1,coverage:'PARTIAL',reviewRequired:false,observations:[row]}} onJump={jump}/>);
  expect(screen.getByText(/revision 7/)).toBeInTheDocument();
  expect(screen.getByText(/approximate video moment 0:02/)).toBeInTheDocument();
  expect(screen.getByText(/Expected on the order/)).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();expect(container.innerHTML).not.toContain('invalid.test');
  expect(screen.queryByRole('button')).toBeNull();
});
it('only offers a video jump when the server supplies an evidence association',()=>{
  const jump=vi.fn();render(<IdentifierDetails value={{schemaVersion:1,coverage:'COMPLETE',reviewRequired:false,observations:[{...row,evidenceId:'evidence-1'} as IdentifierResolution]}} onJump={jump}/>);
  fireEvent.click(screen.getByText('View this moment (approximate)'));
  expect(jump).toHaveBeenCalledWith('session-1',2100);
});
