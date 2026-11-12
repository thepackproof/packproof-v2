import {describe,it,expect} from 'vitest';
import {preparedExportPath,canOfferPreparedFolder} from '../main/source-choice';
describe('prepared export source',()=>{
 it('uses the installer development folder',()=>expect(preparedExportPath('development','D:\\ProgramData')).toBe('D:\\ProgramData\\PackProof\\Exports\\development'));
 it('maps production channel to live storage environment',()=>expect(preparedExportPath('production')).toBe('C:\\ProgramData\\PackProof\\Exports\\live'));
 it('does not accept network or relative defaults',()=>{expect(preparedExportPath('staging','\\\\server\\share')).toBe('C:\\ProgramData\\PackProof\\Exports\\staging');expect(preparedExportPath('development','relative')).toBe('C:\\ProgramData\\PackProof\\Exports\\development');});
 it('rejects unknown installed environments',()=>expect(()=>preparedExportPath('../private')).toThrow());
 it('offers an explicit fallback only for source-access failures',()=>{for(const code of ['SOURCE_ACCESS_DENIED','SOURCE_NOT_FOUND','SOURCE_READ_FAILED'])expect(canOfferPreparedFolder(new Error(`Unable to read source (Code: ${code})`))).toBe(true);});
 it('never disguises internal storage, integrity, clock or network failures as a source choice',()=>{for(const code of ['LOCAL_STORAGE_ACCESS_DENIED','LOCAL_STORAGE_BUSY','SPOOL_KEY_MISSING','SOURCE_CHANGED','SOURCE_BUSY','CLOCK_UNCERTAIN','NETWORK_UNAVAILABLE'])expect(canOfferPreparedFolder(new Error(code))).toBe(false);expect(canOfferPreparedFolder('SOURCE_ACCESS_DENIED')).toBe(false);});
});
