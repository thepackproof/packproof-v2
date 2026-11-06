const {context,validate,windowsSigningOptions}=require('./scripts/release-policy.cjs');
const c=context(),signed=c.channel!=='development';
module.exports={
 appId:c.appId,productName:c.productName,copyright:'Copyright © 2026 PackProof',asar:true,npmRebuild:false,forceCodeSigning:signed,
 directories:{buildResources:'build',output:c.output},files:['dist/main/**/*','dist/renderer/**/*','package.json','!**/*.map','!**/.env*'],
 extraResources:[{from:'native/service',to:'service'},{from:'native/bridge',to:'bridge'},{from:'installer/lifecycle.ps1',to:'installer/lifecycle.ps1'}],
 electronFuses:{runAsNode:false,enableCookieEncryption:true,enableNodeOptionsEnvironmentVariable:false,enableNodeCliInspectArguments:false,enableEmbeddedAsarIntegrityValidation:true,onlyLoadAppFromAsar:true},
 beforePack:async()=>{validate(process.env,process.platform,{native:true});if(process.platform!=='win32')throw Error('Package Connect on native Windows');},
 artifactName:`PackProof-Connect-${c.channel}-Setup-\${version}.exe`,
 publish:signed?[{provider:'generic',url:c.updateUrl,channel:'latest'}]:null,detectUpdateChannel:false,
 win:{target:[{target:'nsis',arch:['x64']}],icon:'build/icon.png',requestedExecutionLevel:'asInvoker',signExecutable:signed,signExts:['PackProof.Connect.Service.dll','PackProof.Connect.Bridge.dll'],verifyUpdateCodeSignature:true,...(signed?windowsSigningOptions():{})},
 nsis:{oneClick:false,perMachine:true,allowElevation:true,allowToChangeInstallationDirectory:false,createDesktopShortcut:false,createStartMenuShortcut:true,shortcutName:c.productName,runAfterFinish:true,deleteAppDataOnUninstall:false,include:'installer/hooks.nsh',warningsAsErrors:true},
 extraMetadata:{name:`packproof-connect-${c.channel}`,main:'dist/main/index.cjs'}
};
