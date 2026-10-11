import type {ContextForm} from '../copy/forms';
import type {TransactionWriteInput} from '../v2-api';
export type ManualOperation={fingerprint:string;key:string;id?:string;form:ContextForm;request:TransactionWriteInput};
/** An uncertain request is recovered before different entered details may create another transaction. */
export function manualDraftMatches(operation:ManualOperation|null|undefined,form:ContextForm):boolean {
  return !operation||Object.keys(operation.form).every(key=>operation.form[key as keyof ContextForm]===form[key as keyof ContextForm]);
}
