import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const web = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(web, "review-output");
mkdirSync(out,{recursive:true});
const result = await build({
  absWorkingDir:web,entryPoints:["evidence-in-motion.review.tsx"],bundle:true,
  format:"iife",platform:"browser",target:"es2022",jsx:"automatic",minify:true,
  outfile:path.join(out,"review.js"),write:false,define:{"process.env.NODE_ENV":JSON.stringify("production"),"import.meta.env":"{}"},
});
let js=result.outputFiles.find(file=>file.path.endsWith(".js")).text;
let css=result.outputFiles.find(file=>file.path.endsWith(".css")).text;
for(const [name,mime] of [
  ["brand/packproof-symbol-reversed.svg","image/svg+xml"],
  ["brand/packproof-wordmark-reversed.svg","image/svg+xml"],
  ["brand/packproof-symbol.svg","image/svg+xml"],
  ["sample-packing-poster.jpg","image/jpeg"],
]){
  const encoded="data:"+mime+";base64,"+readFileSync(path.join(web,"public",name)).toString("base64");
  js=js.replaceAll("/"+name,encoded);css=css.replaceAll("/"+name,encoded);
}
js=js.replaceAll("/sample-packing.mp4","https://thepackproof.com/sample-packing.mp4");
const font=readFileSync(path.join(web,"public/fonts/Inter-variable.ttf")).toString("base64");
css="@font-face{font-family:Inter;src:url(data:font/ttf;base64,"+font+") format('truetype');font-style:normal;font-weight:100 900;font-display:swap}html,body{margin:0;scroll-behavior:smooth}body{background:#0a172a}button{font:inherit}"+css;
const html='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>PackProof - Evidence in Motion design preview</title><style>'+css+'</style></head><body><div id="root"></div><script>'+js.replaceAll("</script","<\\/script")+'</script></body></html>';
const destination=path.join(out,"PackProof-Evidence-in-Motion.html");
writeFileSync(destination,html);
console.log(JSON.stringify({preview:destination,size_bytes:Buffer.byteLength(html),javascript_bytes:Buffer.byteLength(js),css_bytes:Buffer.byteLength(css)}));


