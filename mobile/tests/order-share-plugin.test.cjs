const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xcode = require('xcode');
const plist = require('@expo/plist').default;
const withShare = require('../plugins/with-ios-order-share');
const { transformMainActivity } = require('../plugins/with-order-share');

test('declares extension credentials before EAS prebuild without losing unrelated entitlements', () => {
  const config = {
    name: 'PackProof', slug: 'packproof', version: '1.2.3',
    ios: { bundleIdentifier: 'com.packproof.test', entitlements: { 'aps-environment': 'development', 'com.apple.security.application-groups': ['group.existing'] } },
    extra: { eas: { projectId: 'preserved', build: { experimental: { ios: { appExtensions: [{ targetName: 'OtherExtension' }] } } } } },
  };
  const result = withShare(withShare(config));
  assert.equal(result.extra.eas.projectId, 'preserved');
  assert.equal(result.ios.entitlements['aps-environment'], 'development');
  assert.deepEqual(result.ios.entitlements['com.apple.security.application-groups'], ['group.existing', 'group.com.packproof.test.orders']);
  assert.deepEqual(result.extra.eas.build.experimental.ios.appExtensions, [
    { targetName: 'OtherExtension' },
    { targetName: 'PackProofOrderShare', bundleIdentifier: 'com.packproof.test.OrderShare', entitlements: { 'com.apple.security.application-groups': ['group.com.packproof.test.orders'] } },
  ]);
});

test('extension declares constrained Share Sheet activation and version settings inherited at build time', () => {
  const info = withShare.extensionInfo({}, withShare.shareIdentity({ ios: { bundleIdentifier: 'com.packproof.mobile' } }));
  assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.share-services');
  assert.equal(info.NSExtension.NSExtensionPrincipalClass, '$(PRODUCT_MODULE_NAME).ShareViewController');
  assert.equal(info.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
  assert.equal(info.CFBundleShortVersionString, '$(MARKETING_VERSION)');
  assert.doesNotMatch(info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule, /TRUEPREDICATE|public\.movie/);
  assert.match(info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule, /com\.adobe\.pdf/);
});

test('Android text shares keep cold-start and warm-start normalization', () => {
  const source = 'class MainActivity { override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(null) } }';
  const result = transformMainActivity(source);
  assert.match(result, /setIntent\(packproofOrderShare\(intent\)\)\s+super\.onCreate\(null\)/);
  assert.match(result, /override fun onNewIntent/);
  assert.match(result, /text.length <= 20000/);
  assert.equal(transformMainActivity(result), result);
});

const projectFile = path.resolve(__dirname, '../ios/PackProof.xcodeproj/project.pbxproj');
test('generated Xcode extension is embedded, depends on its Swift sources, and remains idempotent', {
  skip: !fs.existsSync(projectFile) && 'Run expo prebuild --platform ios --no-install for the native project integration check',
}, () => {
  const project = xcode.project(projectFile); project.parseSync();
  const targets = () => Object.entries(project.pbxNativeTargetSection()).filter(([id, value]) => !id.endsWith('_comment') && String(value.name).replaceAll('"', '') === 'PackProofOrderShare');
  assert.equal(targets().length, 1);
  const [id, target] = targets()[0];
  const objects = project.hash.project.objects;
  const sourcePhase = target.buildPhases.map(item => objects.PBXSourcesBuildPhase[item.value]).find(Boolean);
  const sourceNames = sourcePhase.files.map(file => objects.PBXBuildFile[file.value].fileRef_comment);
  assert.deepEqual(sourceNames.sort(), ['OrderShareStore.swift', 'ShareViewController.swift']);
  const mainTarget = project.getFirstTarget().firstTarget;
  assert.ok(mainTarget.dependencies.some(item => objects.PBXTargetDependency[item.value].target === id));
  const embeds = mainTarget.buildPhases.map(item => objects.PBXCopyFilesBuildPhase[item.value]).filter(Boolean);
  assert.ok(embeds.some(phase => String(phase.dstSubfolderSpec) === '13' && phase.files.some(file => objects.PBXBuildFile[file.value].fileRef === target.productReference)));
  const before = JSON.parse(JSON.stringify(target.buildPhases));
  withShare.addExtensionTarget(project, { version: '1.2.3', ios: { bundleIdentifier: 'com.packproof.mobile' } });
  assert.equal(targets().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(target.buildPhases)), before);
  const configList = objects.XCConfigurationList[target.buildConfigurationList];
  const extensionInfo = plist.parse(fs.readFileSync(path.resolve(__dirname, '../ios/PackProofOrderShare/PackProofOrderShare-Info.plist'), 'utf8'));
  for (const { value } of configList.buildConfigurations) {
    const build = objects.XCBuildConfiguration[value].buildSettings;
    assert.equal(build.PRODUCT_MODULE_NAME, 'PackProofOrderShareExtension');
    assert.notEqual(build.PRODUCT_MODULE_NAME, 'PackProofOrderShare'); // app-side Expo pod
    assert.equal(extensionInfo.NSExtension.NSExtensionPrincipalClass.replace('$(PRODUCT_MODULE_NAME)', build.PRODUCT_MODULE_NAME), 'PackProofOrderShareExtension.ShareViewController');
    assert.equal(build.APPLICATION_EXTENSION_API_ONLY, 'YES');
    assert.equal(build.CODE_SIGN_ENTITLEMENTS.replaceAll('"', ''), 'PackProofOrderShare/PackProofOrderShare.entitlements');
  }
  const appEntitlements = plist.parse(fs.readFileSync(path.resolve(__dirname, '../ios/PackProof/PackProof.entitlements'), 'utf8'));
  const extensionEntitlements = plist.parse(fs.readFileSync(path.resolve(__dirname, '../ios/PackProofOrderShare/PackProofOrderShare.entitlements'), 'utf8'));
  assert.deepEqual(extensionEntitlements['com.apple.security.application-groups'], ['group.com.packproof.mobile.orders']);
  assert.ok(appEntitlements['com.apple.security.application-groups'].includes('group.com.packproof.mobile.orders'));
});
