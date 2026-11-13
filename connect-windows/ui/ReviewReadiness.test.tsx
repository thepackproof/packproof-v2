// @vitest-environment jsdom
import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {ConnectApp} from './ConnectApp';
import {bridgeFor,selected,configuration} from './test-fixtures';
afterEach(cleanup);
it('does not offer browser approval when no validated analysis or saved request exists',async()=>{
 const bridge=bridgeFor({...selected,analysis:undefined});render(<ConnectApp bridge={bridge}/>);await screen.findByRole('heading',{name:'Choose a report to review'});expect(screen.queryByRole('button',{name:'Resume saved approval'})).toBeNull();expect(bridge.openApproval).not.toHaveBeenCalled();expect(bridge.startSetup).not.toHaveBeenCalled();
});
it('reopens an exact saved request without fabricating upload consent or committing a batch',async()=>{
 const bridge=bridgeFor({...selected,pendingProposal:configuration});render(<ConnectApp bridge={bridge}/>);await screen.findByRole('button',{name:'Resume saved approval'});fireEvent.click(screen.getByRole('button',{name:'Resume saved approval'}));expect(bridge.openApproval).toHaveBeenCalledTimes(1);expect(bridge.startSetup).not.toHaveBeenCalled();expect(bridge.previewCloud).not.toHaveBeenCalled();expect(bridge.commitBatch).not.toHaveBeenCalled();
});
