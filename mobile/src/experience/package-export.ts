/** The original package is temporary; never retain it after the native save/share flow. */
export async function exportEvidencePackage(io:{authenticate:()=>Promise<void>;assertCurrent:()=>void;available:()=>Promise<boolean>;download:()=>Promise<number>;share:()=>Promise<void>;remove:()=>Promise<void>}) {
  try {
    await io.authenticate();io.assertCurrent();
    if(!await io.available())throw new Error('File saving is unavailable on this device. Download the package from your web workspace.');
    io.assertCurrent();
    const status=await io.download();io.assertCurrent();
    if(status!==200)throw new Error('The evidence package could not be downloaded. Reconnect and try again.');
    await io.share();
  } finally {await io.remove().catch(()=>undefined);}
}
