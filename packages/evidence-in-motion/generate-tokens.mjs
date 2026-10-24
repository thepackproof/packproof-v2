import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../..');
const sourceBytes=await readFile(path.join(directory,'tokens.v1.json'),'utf8');
const source=JSON.parse(sourceBytes);
if(source.schema!=='packproof.presentation.tokens/v1'||!/^1\./.test(source.version))throw Error('Unsupported token schema/version');
const digest=createHash('sha256').update(sourceBytes.replaceAll('\r\n','\n')).digest('hex');
function resolve(value,seen=[]){
  if(typeof value==='string'){
    const match=value.match(/^\{([\w.]+)\}$/);if(!match)return value;
    if(seen.includes(match[1]))throw Error(`Cyclic token ${match[1]}`);
    let next=source;for(const key of match[1].split('.'))next=next?.[key];
    if(next===undefined)throw Error(`Missing token ${match[1]}`);
    return resolve(next,[...seen,match[1]]);
  }
  if(Array.isArray(value))return value.map(item=>resolve(item,seen));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item,seen)]));
  return value;
}
const data=resolve(source);
const header=`Generated from tokens.v1.json v${data.version}; SHA-256 ${digest}. Do not edit.`;
const exports={eimTokenVersion:data.version,eimTokenDigest:digest,eimPrimitives:data.primitives,eimPalette:data.palette,eimColors:data.colors,eimTypography:data.typography,eimLayout:data.layout,eimMotion:data.motion};
const ts=`// ${header}\n`+Object.entries(exports).map(([key,value])=>`export const ${key} = ${JSON.stringify(value,null,2)} as const;`).join('\n\n')+'\n';
const kebab=value=>value.replace(/[A-Z]/g,match=>'-'+match.toLowerCase());
function declarations(values,prefix){return Object.entries(values).map(([key,value])=>`  --${prefix}${kebab(key)}: ${value};`).join('\n');}
const aliases={canvas:'background',paper:'surface',ink:'textPrimary',secondary:'textSecondary',line:'border',wash:'surfacePressed',primary:'primary',pressed:'primaryPressed',mintInk:'successText',cobaltWash:'accentSoft',cobaltInk:'accentText'};
function colorBlock(mode){
  return declarations(data.colors[mode],'eim-')+'\n'+Object.entries(aliases).map(([key,value])=>`  --signal-${kebab(key)}: var(--eim-${kebab(value)});`).join('\n');
}
const css=`/* ${header} */\n.signal-shell {\n${declarations(data.primitives,'eim-')}\n${colorBlock('light')}\n  --signal-mint: var(--eim-mint);\n  --signal-navy: var(--eim-navy);\n  --signal-midnight: var(--eim-midnight);\n  --signal-cyan: var(--eim-cyan);\n  --eim-text: var(--eim-text-primary);\n  --eim-secondary: var(--eim-text-secondary);\n  --eim-control-radius: ${data.layout.radii.sm}px;\n  --eim-card-radius: ${data.layout.radii.md}px;\n  --eim-sheet-radius: ${data.layout.radii.lg}px;\n  --eim-primary-height: ${data.layout.primaryHeight}px;\n  --eim-icon-touch: ${data.layout.iconTouch}px;\n  --eim-phone-gutter: ${data.layout.phoneGutter}px;\n  --eim-desktop-rail: ${data.layout.desktopRail}px;\n  --eim-desktop-gutter: ${data.layout.desktopGutter}px;\n  --eim-ease: cubic-bezier(${data.motion.ease.join(',')});\n${Object.entries(data.motion).filter(([key])=>key!=='ease').map(([key,value])=>`  --eim-motion-${key}: ${value}ms;`).join('\n')}\n}\n[data-theme=dark] .signal-shell {\n${colorBlock('dark')}\n}\n`;
const outputs=[['tokens.generated.ts',ts],['tokens.generated.css',css]];
const check=process.argv.includes('--check');
for(const [name,content]of outputs){
  const target=path.join(directory,name);
  if(check){const current=await readFile(target,'utf8').catch(()=>null);if(current?.replaceAll('\r\n','\n')!==content)throw Error(`Token output drift: ${name}. Run node packages/evidence-in-motion/generate-tokens.mjs`);}
  else await writeFile(target,content);
}
if(check){
  const consumers=[
    ['mobile/src/theme/signal.ts','tokens.generated'],['mobile/src/theme/tokens.ts','tokens.generated'],
    ['mobile/src/theme/motion.ts','tokens.generated'],['web/src/theme/ThemeProvider.tsx','tokens.generated'],
    ['web/src/signal/signal.css','tokens.generated.css'],['desktop/src/renderer/main.tsx','web/src/signal/signal.css'],
    ['desktop/src/renderer/evidence-in-motion.css','var(--signal-primary)'],
  ];
  for(const [name,required]of consumers){const current=await readFile(path.join(root,name),'utf8');if(!current.includes(required))throw Error(`Missing canonical-token consumer: ${name}`);}
  for(const name of ['web/src/signal/signal.css','desktop/src/renderer/evidence-in-motion.css']){
    const current=await readFile(path.join(root,name),'utf8');
    if(/--signal-(?:canvas|paper|ink|secondary|line|wash|primary|pressed|mint|mint-ink|cobalt-wash|cobalt-ink|navy|midnight|cyan)\s*:\s*#/.test(current))throw Error(`Inline role token bypass in ${name}`);
  }
}
console.log(JSON.stringify({status:check?'passed':'generated',version:data.version,source:'packages/evidence-in-motion/tokens.v1.json',sourceSha256:digest,outputs:outputs.map(([name])=>'packages/evidence-in-motion/'+name),platforms:check?['mobile','web','desktop']:undefined}));
