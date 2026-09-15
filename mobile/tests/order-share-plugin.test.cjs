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
  assert.deepEqual(result.ios.entitlements['keychain-access-groups'], ['$(AppIdentifierPrefix)com.packproof.test.order-share']);
  assert.deepEqual(result.ios.entitlements['com.apple.security.application-groups'], ['group.existing', 'group.com.packproof.test.orders']);
  assert.deepEqual(result.extra.eas.build.experimental.ios.appExtensions, [
    { targetName: 'OtherExtension' },
    { targetName: 'PackProofOrderShare', bundleIdentifier: 'com.packproof.test.OrderShare', entitlements: { 'com.apple.security.application-groups': ['group.com.packproof.test.orders'], 'keychain-access-groups': ['$(AppIdentifierPrefix)com.packproof.test.order-share'] } },
  ]);
});

test('extension declares constrained Share Sheet activation and version settings inherited at build time', () => {
  const info = withShare.extensionInfo({}, withShare.shareIdentity({ ios: { bundleIdentifier: 'com.packproof.mobile' } }));
  assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.share-services');
  assert.equal(info.NSExtension.NSExtensionPrincipalClass, '$(PRODUCT_MODULE_NAME).ShareViewController');
  assert.equal(info.CFBundleVersion, '$(CURRENT_PROJECT_VERSION)');
  assert.equal(info.CFBundleShortVersionString, '$(MARKETING_VERSION)');
  assert.deepEqual(info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule, {
    NSExtensionActivationSupportsText: true, NSExtensionActivationSupportsWebURLWithMaxCount: 1,
  });
  assert.equal(info.PackProofOrderShareKeychainGroup, '$(AppIdentifierPrefix)com.packproof.mobile.order-share');
});

test('Android text shares keep cold-start and warm-start normalization', () => {
  const source = 'class MainActivity { override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(null) } }';
  const result = transformMainActivity(source);
  assert.match(result, /setIntent\(packproofOrderShare\(intent\)\)\s+super\.onCreate\(null\)/);
  assert.match(result, /override fun onNewIntent/);
  assert.match(result, /OrderShareStore.receive\(this, incoming\)/);
  assert.doesNotMatch(result, /appendQueryParameter\("text"/);
  assert.equal(transformMainActivity(result), result);
});

test('Android prebuild upgrades the legacy raw-query receiver and fails closed on incompatible handlers', () => {
  const legacy = `class MainActivity {
  private fun packproofOrderShare(incoming: android.content.Intent): android.content.Intent {
    return incoming.apply { data = builder.appendQueryParameter("text", text).build() }
  }

  override fun onNewIntent(intent: android.content.Intent) { super.onNewIntent(packproofOrderShare(intent)) }
}`;
  const result = transformMainActivity(legacy);
  assert.match(result, /OrderShareStore.receive\(this, incoming\)/);
  assert.doesNotMatch(result, /appendQueryParameter/);
  assert.equal((result.match(/override fun onNewIntent/g) || []).length, 1);
  assert.equal(transformMainActivity(result), result);
  assert.throws(() => transformMainActivity('class MainActivity { fun packproofOrderShare() {} }'), /unsupported existing share handler/);
  assert.throws(() => transformMainActivity('class MainActivity { fun onCreate() { super.onCreate(null) } override fun onNewIntent() {} }'), /merge existing onNewIntent/);
});

test('share privacy manifests cover only local container metadata', () => {
  const extension = plist.parse(fs.readFileSync(path.resolve(__dirname, '../plugins/order-share-ios/PrivacyInfo.xcprivacy'), 'utf8'));
  const pod = plist.parse(fs.readFileSync(path.resolve(__dirname, '../modules/packproof-order-share/ios/PrivacyInfo.xcprivacy'), 'utf8'));
  assert.deepEqual(extension.NSPrivacyAccessedAPITypes, [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] }]);
  assert.deepEqual(pod.NSPrivacyAccessedAPITypes, [{ NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp', NSPrivacyAccessedAPITypeReasons: ['C617.1'] }]);
  assert.equal(extension.NSPrivacyTracking, false);
  assert.equal(pod.NSPrivacyTracking, false);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../modules/packproof-order-share/ios/PackProofOrderShare.podspec'), 'utf8'), /s\.resource_bundles\s*=\s*\{\s*'PackProofOrderShare_privacy'\s*=>\s*\['PrivacyInfo\.xcprivacy'\]/);
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
  assert.deepEqual(sourceNames.sort(), ['OrderShareSessionStore.swift', 'OrderShareStore.swift', 'ShareIntakeTransport.swift', 'ShareViewController.swift']);
  for (const name of sourceNames) {
    const sourceFolder = ['OrderShareSessionStore.swift', 'OrderShareStore.swift'].includes(name)
      ? '../modules/packproof-order-share/ios' : '../plugins/order-share-ios';
    assert.equal(fs.readFileSync(path.resolve(__dirname, '../ios/PackProofOrderShare', name), 'utf8'),
      fs.readFileSync(path.resolve(__dirname, sourceFolder, name), 'utf8'), `${name} must match the candidate source`);
  }
  const resourcePhase = target.buildPhases.map(item => objects.PBXResourcesBuildPhase[item.value]).find(Boolean);
  const resourcePaths = () => resourcePhase.files.map(file => objects.PBXFileReference[objects.PBXBuildFile[file.value].fileRef].path.replaceAll('"', ''));
  assert.deepEqual(resourcePaths(), ['PackProofOrderShare/PrivacyInfo.xcprivacy']);
  assert.equal(fs.readFileSync(path.resolve(__dirname, '../ios/PackProofOrderShare/PrivacyInfo.xcprivacy'), 'utf8'), fs.readFileSync(path.resolve(__dirname, '../plugins/order-share-ios/PrivacyInfo.xcprivacy'), 'utf8'));
  const mainTarget = project.getFirstTarget().firstTarget;
  const mainResources = mainTarget.buildPhases.map(item => objects.PBXResourcesBuildPhase[item.value]).find(Boolean);
  const mainPrivacyPaths = () => mainResources.files.map(file => objects.PBXFileReference[objects.PBXBuildFile[file.value]?.fileRef]?.path?.replaceAll('"', '')).filter(value => value?.endsWith('PrivacyInfo.xcprivacy'));
  assert.deepEqual(mainPrivacyPaths(), ['PackProof/PrivacyInfo.xcprivacy']);
  assert.notEqual(mainPrivacyPaths()[0], resourcePaths()[0]);
  assert.ok(mainTarget.dependencies.some(item => objects.PBXTargetDependency[item.value].target === id));
  const embeds = mainTarget.buildPhases.map(item => objects.PBXCopyFilesBuildPhase[item.value]).filter(Boolean);
  assert.ok(embeds.some(phase => String(phase.dstSubfolderSpec) === '13' && phase.files.some(file => objects.PBXBuildFile[file.value].fileRef === target.productReference)));
  const appInfo = plist.parse(fs.readFileSync(path.resolve(__dirname, '../ios/PackProof/Info.plist'), 'utf8'));
  for (const { value } of objects.XCConfigurationList[target.buildConfigurationList].buildConfigurations) {
    const build = objects.XCBuildConfiguration[value].buildSettings;
    assert.equal(String(build.MARKETING_VERSION).replaceAll('"', ''), appInfo.CFBundleShortVersionString);
    assert.equal(String(build.CURRENT_PROJECT_VERSION).replaceAll('"', ''), appInfo.CFBundleVersion);
  }
  const before = JSON.parse(JSON.stringify(target.buildPhases));
  // Repair the previous aggregator's accidental app membership on a rerun.
  mainResources.files.push({ ...resourcePhase.files[0] });
  withShare.addExtensionTarget(project, { version: '2.7.13', ios: { bundleIdentifier: 'com.packproof.mobile', buildNumber: '42' } });
  assert.equal(targets().length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(target.buildPhases)), before);
  assert.deepEqual(resourcePaths(), ['PackProofOrderShare/PrivacyInfo.xcprivacy']);
  assert.deepEqual(mainPrivacyPaths(), ['PackProof/PrivacyInfo.xcprivacy']);
  const configList = objects.XCConfigurationList[target.buildConfigurationList];
  const extensionInfo = plist.parse(fs.readFileSync(path.resolve(__dirname, '../ios/PackProofOrderShare/PackProofOrderShare-Info.plist'), 'utf8'));
  for (const { value } of configList.buildConfigurations) {
    const build = objects.XCBuildConfiguration[value].buildSettings;
    assert.equal(build.MARKETING_VERSION, '2.7.13');
    assert.equal(build.CURRENT_PROJECT_VERSION, '42');
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
  assert.deepEqual(extensionEntitlements['keychain-access-groups'], ['$(AppIdentifierPrefix)com.packproof.mobile.order-share']);
  assert.ok(appEntitlements['keychain-access-groups'].includes('$(AppIdentifierPrefix)com.packproof.mobile.order-share'));
  assert.equal(appInfo.PackProofOrderShareKeychainGroup, extensionInfo.PackProofOrderShareKeychainGroup);
  assert.equal(appInfo.PackProofOrderShareAPIBaseURL, extensionInfo.PackProofOrderShareAPIBaseURL);
});
