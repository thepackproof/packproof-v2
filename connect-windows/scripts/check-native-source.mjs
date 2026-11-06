import fs from 'node:fs';
// Ensure all security-sensitive runtime components are present before spending a Windows CI build.
for(const file of ['service/PackProof.Connect.Service.csproj','bridge/PackProof.Connect.Bridge.csproj','installer/lifecycle.ps1','installer/hooks.nsh','main/index.ts','main/preload.ts'])if(!fs.existsSync(file))throw Error(`Connect native build input missing: ${file}`);
