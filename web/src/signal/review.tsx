/** Internal visual review only. This entry is not a production build input. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, useTheme } from '../theme/ThemeProvider';
import { MobileNavigation } from '../mobile-task/MobileNavigation';
import { MobileHomeScreen } from '../mobile-task/MobileHomeScreen';
import { SignalGuide, SignalProgress, SignalReceipt } from './Signal';
import { WorkspaceProofRecord } from '../components/WorkspaceProofRecord';
import { canonicalProof, summary } from '../tests/fixtures';
import { sampleChronology } from '../site/sampleData';
import { classifyProofPresentation } from '../../../backend/src/domain/proof-presentation';
import type { WebSession } from '../auth/session';
import '../styles.css';
import '../mobile-task/mobile-task.css';
import '../components/workspace-proof-record.css';
import './signal.css';
const session = {userId:'design-fixture',displayName:'Design review',username:'fixture',apiBaseUrl:'',authMode:'dev',token:'fixture',refreshToken:null,accessExpiresAt:null,subject:'design-fixture'} as WebSession;
const proof = {...canonicalProof,chronology:sampleChronology};
const item = {...summary,presentation:classifyProofPresentation(summary)};
function Review() {
 const [screen,setScreen]=useState('Home'); const theme=useTheme();
 return <><div className="eim-review-toolbar"><strong>Synthetic design fixtures · Visual review only</strong><label>Screen <select value={screen} onChange={e=>setScreen(e.target.value)}>{['Home','Guide','Upload','Confirming','Paused','Receipt','Record'].map(v=><option key={v}>{v}</option>)}</select></label><button onClick={()=>theme.setPreference(theme.scheme==='light'?'dark':'light')}>Theme: {theme.scheme}</button><label>Motion <select value={theme.motionPreference} onChange={e=>theme.setMotionPreference(e.target.value as 'system'|'reduced'|'off')}><option value="system">System</option><option value="reduced">Reduced</option><option value="off">Off</option></select></label></div><div className="app-shell workspace-shell signal-shell mobile-task-shell"><MobileNavigation session={session} route={screen==='Home'?'home':'proof'} adminAllowed={false} onGo={()=>setScreen('Home')} onSignOut={()=>{}}/>{screen==='Home'?<MobileHomeScreen proofs={[item]} recordings={[]} queue={[]} loading={false} recordingsLoaded error={null} refreshedAt="2026-10-24T12:00:00Z" busy={false} notice={null} interactions={{}} onGo={()=>setScreen('Guide')} onRetry={()=>{}} onAction={()=>setScreen('Guide')} onOpen={()=>setScreen('Record')}/>:screen==='Record'?<main className="page eim-proof-page"><WorkspaceProofRecord proof={proof} currentUserId="user_seller" role="SELLER"/></main>:<main className="page packing-page signal-capture">{screen==='Guide'?<SignalGuide onStart={()=>{}} disabled/>:screen==='Receipt'?<SignalReceipt title="Synthetic packing fixture" proofId="proof_design_fixture" savedAt="2026-10-24T12:00:00Z" duration="1:24" onView={()=>setScreen('Record')} onHome={()=>setScreen('Home')}/>:<SignalProgress percent={screen==='Upload'?42:null} confirming={screen==='Confirming'} paused={screen==='Paused'}><button className="btn btn-secondary" onClick={()=>setScreen('Home')}>Continue to Home</button></SignalProgress>}</main>}</div></>;
}
const root=document.getElementById('root');if(root)createRoot(root).render(<ThemeProvider><Review/></ThemeProvider>);

import './review.css';
