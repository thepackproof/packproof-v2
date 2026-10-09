import type { ContextForm } from "../copy/forms";
import { EMPTY_FORM } from "../copy/forms";
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ProofCollectionItem, ProofView } from '../v2-api';
import { DEFAULT_PROOFS_LIBRARY, type ProofsLibraryState } from './navigation';
export const proofsCacheKey = (api:string,user:string) => `packproof.proofs:v1:${encodeURIComponent(api.replace(/\/+$/,''))}:${user}`;
export type ProofsCache = { draft?:ContextForm; fetchedAt?:string|null; interactions?:Record<string,number>; library:ProofsLibraryState; offsetY:number; rows:ProofCollectionItem[]; records:Record<string,ProofView> };
export const emptyProofsCache = ():ProofsCache => ({library:{...DEFAULT_PROOFS_LIBRARY},offsetY:0,rows:[],records:{}});
export async function loadProofsCache(api:string,user:string):Promise<ProofsCache> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(proofsCacheKey(api,user))) || 'null');
    if (!parsed) return emptyProofsCache();
    return { draft:parsed.draft && typeof parsed.draft==='object'?Object.fromEntries(Object.keys(EMPTY_FORM).map(key=>[key,typeof parsed.draft[key]==='string'?parsed.draft[key]:''])) as unknown as ContextForm:undefined, fetchedAt:typeof parsed.fetchedAt==='string'?parsed.fetchedAt:null, interactions:Object.fromEntries(Object.entries(parsed.interactions??{}).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)).slice(-200)) as Record<string,number>, library:{...DEFAULT_PROOFS_LIBRARY,...parsed.library,view:['all','attention','completed'].includes(parsed.library?.view) ? parsed.library.view : DEFAULT_PROOFS_LIBRARY.view},offsetY:Number.isFinite(parsed.offsetY)?Math.max(0,parsed.offsetY):0,rows:Array.isArray(parsed.rows)?parsed.rows:[],records:parsed.records && typeof parsed.records==='object'?parsed.records:{}};
  } catch {return emptyProofsCache();}
}
export async function saveProofsCache(api:string,user:string,value:ProofsCache) { await AsyncStorage.setItem(proofsCacheKey(api,user),JSON.stringify(value)); }
export async function clearProofsCache(api:string,user:string) { await AsyncStorage.removeItem(proofsCacheKey(api,user)); }
