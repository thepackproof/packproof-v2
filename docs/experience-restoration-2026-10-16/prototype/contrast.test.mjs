import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('./review.template.html',import.meta.url),'utf8');
const light=Object.fromEntries([...html.match(/:root\{([^}]+)\}/)[1].matchAll(/--([\w-]+):(#\w{6})/g)].map(m=>[m[1],m[2]]));
const dark={...light,...Object.fromEntries([...html.match(/:root\[data-theme=dark\]\{([^}]+)\}/)[1].matchAll(/--([\w-]+):(#\w{6})/g)].map(m=>[m[1],m[2]]))};
function luminance(hex){const rgb=hex.slice(1).match(/../g).map(h=>parseInt(h,16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722}
function contrast(a,b){const l=[luminance(a),luminance(b)].sort((a,b)=>b-a);return (l[0]+.05)/(l[1]+.05)}
for(const [name,colors] of [['light',light],['dark',dark]]){
 for(const [fg,bg] of [['ink','paper'],['ink','canvas'],['secondary','paper'],['secondary','canvas'],['action','paper'],['success','success-tint'],['attention','attention-tint'],['danger','danger-tint']]){
  test(`${name} ${fg} on ${bg} normal text contrast`,()=>{const ratio=contrast(colors[fg],colors[bg]);assert.ok(ratio>=4.5,`${ratio.toFixed(2)}:1`)});
 }
 for(const bg of ['paper','canvas'])test(`${name} control boundaries on ${bg}`,()=>assert.ok(contrast(colors.control,colors[bg])>=3));
}
test('primary action uses readable white text in both themes',()=>assert.ok(contrast('#ffffff','#245fc4')>=4.5));
