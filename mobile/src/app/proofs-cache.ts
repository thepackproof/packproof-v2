import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ProofCollectionItem, ProofView } from '../v2-api';
import { DEFAULT_PROOFS_LIBRARY, type ProofsLibraryState } from './navigation';
export const proofsCacheKey = (api:string,user:string) => `packproof.proofs:v1:${encodeURIComponent(api.replace(/\/+$/,''))}:${user}`;
export type ProofsCache = { library:ProofsLibraryState; offsetY:number; rows:ProofCollectionItem[]; records:Record<string,ProofView> };
export const emptyProofsCache = ():ProofsCache => ({library:{...DEFAULT_PROOFS_LIBRARY},offsetY:0,rows:[],records:{}});
export async function loadProofsCache(api:string,user:string):Promise<ProofsCache> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(proofsCacheKey(api,user))) || 'null');
    if (!parsed) return emptyProofsCache();
    return { library:{...DEFAULT_PROOFS_LIBRARY,...parsed.library,view:['all','attention','completed'].includes(parsed.library?.view) ? parsed.library.view : 'all'},offsetY:Number.isFinite(parsed.offsetY)?Math.max(0,parsed.offsetY):0,rows:Array.isArray(parsed.rows)?parsed.rows:[],records:parsed.records && typeof parsed.records==='object'?parsed.records:{}};
  } catch {return emptyProofsCache();}
}
export async function saveProofsCache(api:string,user:string,value:ProofsCache) { await AsyncStorage.setItem(proofsCacheKey(api,user),JSON.stringify(value)); }
export async function clearProofsCache(api:string,user:string) { await AsyncStorage.removeItem(proofsCacheKey(api,user)); }
