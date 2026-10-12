const { releaseContext, checkReleaseEnvironment, windowsSigningOptions } = require('./scripts/release-policy.cjs');

const release = releaseContext();
const research = require('../config/rnd/research-build.json').researchOnly === true;
if(research && release.channel !== 'development')throw new Error('Experimental source cannot be signed or distributed.');
if(research)Object.assign(release,{appId:'com.thepackproof.desktop.research',productName:'PackProof Research',packageName:'packproof-desktop-research',artifactPrefix:'PackProof-Research',protocol:'packproof-research',outputDirectory:`release/research/${release.platform}-${release.arch}`,updateUrl:undefined});
const signed = release.channel !== 'development';

/** Every packaged environment has its own identity, protocol and update feed. */
module.exports = {
  appId: release.appId,
  productName: release.productName,
  copyright: 'Copyright © 2026 PackProof. All rights reserved.',
  directories: { buildResources: 'build', output: release.outputDirectory },
  files: ['dist/main/**/*', 'dist/renderer/**/*', 'package.json', '!**/*.map', '!**/.env*'],
  extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],
  extraMetadata: { name: release.packageName, main: 'dist/main/index.cjs' },
  asar: true,
  npmRebuild: false,
  forceCodeSigning: signed,
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  beforePack: async context => {
    checkReleaseEnvironment({ checkRuntime: true });
    if (context.electronPlatformName !== release.platform) throw new Error('Build target differs from release identity. Set PACKPROOF_BUILD_PLATFORM explicitly for unsigned cross-platform builds.');
  },
  artifactBuildCompleted: require('./scripts/notarize-dmg.cjs'),
  protocols: [{ name: `${release.productName} link`, schemes: [release.protocol] }],
  artifactName: `${release.artifactPrefix}-\${version}-\${arch}.\${ext}`,
  publish: signed ? [{ provider: 'generic', url: release.updateUrl, channel: 'latest' }] : null,
  detectUpdateChannel: false,
  generateUpdatesFilesForAllChannels: false,
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    executableName: release.productName,
    requestedExecutionLevel: 'asInvoker',
    signExecutable: signed,
    verifyUpdateCodeSignature: true,
    ...(signed ? windowsSigningOptions() : {}),
  },
  nsis: {
    artifactName: `${release.artifactPrefix}-Setup-\${version}.exe`,
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: false,
    createStartMenuShortcut: true,
    shortcutName: release.productName,
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    warningsAsErrors: true,
  },
  mac: {
    target: ['dmg', 'zip', ...(release.includePkg ? ['pkg'] : [])],
    icon: 'build/icon.png',
    category: 'public.app-category.business',
    minimumSystemVersion: '13.0.0',
    hardenedRuntime: signed,
    gatekeeperAssess: false,
    // Ad-hoc signing allows local Apple Silicon candidates to run; it asserts no publisher identity.
    identity: signed ? undefined : '-',
    notarize: signed,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    extendInfo: {
      NSCameraUsageDescription: 'PackProof uses your selected camera to record continuous shipment evidence while you pack.',
      NSMicrophoneUsageDescription: 'PackProof includes microphone audio in shipment recordings only when you enable audio.',
      LSMultipleInstancesProhibited: true,
    },
  },
  dmg: { title: release.productName, sign: false },
  pkg: {
    installLocation: '/Applications',
    allowAnywhere: false,
    allowCurrentUserHome: false,
    allowRootDirectory: true,
    isRelocatable: false,
    overwriteAction: 'upgrade',
  },
};
