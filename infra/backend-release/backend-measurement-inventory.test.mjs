import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedMeasurementInventory,MEASUREMENT_MIGRATION} from './backend-measurement-inventory.mjs';
const before=Array.from({length:76},(_,n)=>({id:String(n),checksum:'a'.repeat(64)}));
const after=[...before,MEASUREMENT_MIGRATION],compatibility=JSON.stringify(MEASUREMENT_MIGRATION);
test('permits only the frozen 076 delta on the compatible predecessor, or the identical 77 inventory',()=>{
 assert.equal(reviewedMeasurementInventory(after,before,compatibility),true);
 assert.equal(reviewedMeasurementInventory(after,after),true);
 assert.equal(reviewedMeasurementInventory(after,before),false);
 assert.equal(reviewedMeasurementInventory(after.map((row,n)=>n===1?{...row,checksum:'b'.repeat(64)}:row),before,compatibility),false);
 assert.equal(reviewedMeasurementInventory([...before,{...MEASUREMENT_MIGRATION,checksum:'b'.repeat(64)}],before,compatibility),false);
 assert.equal(reviewedMeasurementInventory([...after,{id:'077_unreviewed',checksum:'a'.repeat(64)}],before,compatibility),false);
 assert.equal(reviewedMeasurementInventory([before[1],...after.slice(1)],before,compatibility),false);
});
