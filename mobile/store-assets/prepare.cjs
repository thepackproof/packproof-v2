const fs=require('node:fs');
if(process.env.PACKPROOF_STORE_SCREENSHOTS!=='1')throw new Error('Screenshot preparation is restricted to the dedicated simulator job.');
if(process.env.EAS_BUILD)throw new Error('Never replace the EAS production entry point.');
fs.writeFileSync('App.tsx','export { default } from "./store-assets/App.store";\n');
fs.appendFileSync('src/app/PackProofProvider.tsx','\n// Exported only inside the isolated screenshot build.\nexport { PackProofContext };\n');
