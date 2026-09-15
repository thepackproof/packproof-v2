/** Only fixed app destinations may be selected by a consumed OAuth attempt. */
export function connectSurface(value:unknown):'ios'|'android'|'web' {
  return value==='ios'||value==='android'?value:'web';
}

export function connectedAccountReturnUrl(webReturnUrl:string,provider:string,surface:unknown):string {
  return connectSurface(surface)==='web' ? webReturnUrl : `packproof-v2://connections/${encodeURIComponent(provider)}`;
}
