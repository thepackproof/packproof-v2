import {RndReview} from '../../../web/src/rnd/RndReview';
import type {CanonicalProof} from '../shared/contracts';
export function RndDesktopPanel({proof}:{proof:CanonicalProof}) {
 if(import.meta.env.VITE_PACKPROOF_RND!=='1')return null;
 return <RndReview proofId={proof.proofId} transport={window.packproof.rnd} openSource={async id=>window.packproof.rnd.source(proof.proofId,id)} saveExport={async()=>{}}/>;
}
