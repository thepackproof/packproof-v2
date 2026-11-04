import {it,expect,vi} from 'vitest';
import {Readable} from 'node:stream';
import {once} from 'node:events';
import {guardAuthorizedStream} from '../src/domain/authorized-stream.js';

it('closes an already-open source when response aborts before the first read',async()=>{
 const source=new Readable({read(){throw Error('Aborted response must not read its original');}}),authorize=vi.fn(async()=>{}),response=guardAuthorizedStream(source,authorize);
 const closed=once(response,'close');response.destroy();await closed;
 expect(source.destroyed).toBe(true);expect(authorize).not.toHaveBeenCalled();
});
it('closes the underlying source when current authorization fails before bytes are sent',async()=>{
 const source=Readable.from([Buffer.from('private original')]),response=guardAuthorizedStream(source,async()=>{throw Error('revoked');});
 await expect(async()=>{for await(const _ of response){};}).rejects.toThrow('revoked');expect(source.destroyed).toBe(true);
});
