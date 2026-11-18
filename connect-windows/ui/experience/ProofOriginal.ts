/** Preserve the original text and highlight only a confirmed location or line allocation. */
export function originalFocusRange(raw:string,mediaType:string,lineId:string,field:string,locator:string):[number,number]|null {
  const numbered=/^line\s+(\d+)(?:\b|:)/i.exec(locator);
  if(numbered){
    const target=Number(numbered[1]);let pos=0,line=1;
    while(line<target&&pos<raw.length){const next=raw.indexOf("\n",pos);if(next<0)return null;pos=next+1;line++;}
    if(line===target&&target>0){const next=raw.indexOf("\n",pos);return [pos,next<0?raw.length:next];}
  }
  if(!lineId)return null;
  if(/json/i.test(mediaType)){
    const frames:{start:number;leaf:boolean}[]=[], hits:[number,number][]=[];
    for(const token of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}]/g)){
      if(token[0]==="{"){if(frames.length)frames[frames.length-1].leaf=false;frames.push({start:token.index!,leaf:true});}
      else if(token[0]==="}"){
        const f=frames.pop();if(!f?.leaf)continue;
        const end=token.index!+1;
        try{
          const r=JSON.parse(raw.slice(f.start,end));
          if(String(r.lineId??"")!==lineId||(field&&!Object.hasOwn(r,field)))continue;
          hits.push([f.start,end]);if(hits.length>1)return null;
        }catch{/* Unstructured text remains readable without a guessed highlight. */}
      }
    }
    return hits[0]||null;
  }
  if(!/csv/i.test(mediaType))return null;
  let start=0,quoted=false,value="",columns:string[]=[],lineIndex=-1,stage=-1,header=true,match:[number,number]|null=null;
  for(let i=0;i<=raw.length;i++){
    const c=raw[i];
    if(c==='"'){if(quoted&&raw[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}
    else if(c===undefined||!quoted&&(c===","||c==="\n"||c==="\r")){
      columns.push(value);value="";
      if(c===",")continue;
      if(header){lineIndex=columns.findIndex(v=>v.replace(/^\uFEFF/,"")==="lineId");stage=columns.indexOf(field);header=false;
        if(lineIndex<0||(field&&stage<0))return null;}
      else if(columns[lineIndex]===lineId&&(!field||columns[stage]!=="")){if(match)return null;match=[start,i];}
      if(c==="\r"&&raw[i+1]==="\n")i++;
      start=i+1;columns=[];
    }else value+=c;
  }
  return quoted?null:match;
}
