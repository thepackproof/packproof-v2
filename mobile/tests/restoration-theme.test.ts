import test from 'node:test';
import assert from 'node:assert/strict';
import { restorationColors } from '../src/theme/restoration-colors';
import type { ThemeColors } from '../src/theme/tokens';

function luminance(hex: string): number {
  const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2];
}
function ratio(a:string,b:string) {const [hi,lo]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (hi+0.05)/(lo+0.05);}
for(const scheme of ['light','dark'] as const) {
  test(`${scheme} restoration text, saved states, and buttons have readable contrast`,()=>{
    const c=restorationColors(scheme);
    const pairs:[keyof ThemeColors,keyof ThemeColors][]=[['textPrimary','background'],['textSecondary','background'],['textPrimary','surface'],['textSecondary','surface'],['textSecondary','surfacePressed'],['textOnPrimary','primary'],['textOnPrimary','primaryPressed'],['accentText','surface'],['accentText','accentSoft'],['successText','surface'],['successText','successSoft'],['warningText','warningSoft'],['error','errorSoft']];
    for(const [fg,bg] of pairs)assert.ok(ratio(c[fg],c[bg])>=4.5,`${fg}/${bg}: ${ratio(c[fg],c[bg])}`);
  });
  test(`${scheme} restoration controls remain identifiable on paper and canvas`,()=>{
    const c=restorationColors(scheme);
    for(const bg of ['surface','background'] as const)assert.ok(ratio(c.controlBorder,c[bg])>=3,`${bg} control boundary`);
  });
}
