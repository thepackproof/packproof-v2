const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withDangerousMod, withXcodeProject, withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

const TARGET = 'PackProofOrderShare';
// The app imports the PackProofOrderShare Expo pod. A same-named extension
// Swift module shadows that pod during dependency scanning in the app target.
const EXTENSION_MODULE_NAME = 'PackProofOrderShareExtension';
const GROUP_KEY = 'com.apple.security.application-groups';
const KEYCHAIN_KEY = 'keychain-access-groups';
const EXTENSION_SOURCES = ['ShareViewController.swift', 'ShareIntakeTransport.swift', 'OrderShareStore.swift', 'OrderShareSessionStore.swift'];

function shareIdentity(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier || 'com.packproof.mobile';
  return { bundleIdentifier: `${bundleIdentifier}.OrderShare`, appGroup: `group.${bundleIdentifier}.orders`,
    keychainGroup: `$(AppIdentifierPrefix)${bundleIdentifier}.order-share` };
}

function extensionInfo(config, identity) {
  return {
    CFBundleDisplayName: 'PackProof', CFBundleName: TARGET, CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleExecutable: '$(EXECUTABLE_NAME)', CFBundlePackageType: 'XPC!', CFBundleInfoDictionaryVersion: '6.0',
    CFBundleShortVersionString: '$(MARKETING_VERSION)', CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    PackProofOrderShareAppGroup: identity.appGroup,
    PackProofOrderShareKeychainGroup: identity.keychainGroup,
    PackProofOrderShareAPIBaseURL: config.extra?.packproofApiBaseUrl || '',
    NSExtension: {
      NSExtensionPointIdentifier: 'com.apple.share-services',
      NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController',
      NSExtensionAttributes: {
        // Match only supported data. Do not advertise video, arbitrary files, or executable content.
        NSExtensionActivationRule: {
          NSExtensionActivationSupportsText: true,
          NSExtensionActivationSupportsWebURLWithMaxCount: 1,
        },
      },
    },
  };
}

function addExtensionTarget(project, config) {
  const identity = shareIdentity(config);
  const objects = project.hash.project.objects;
  // Expo's single-target template omits these sections. xcode.addTargetDependency
  // silently does nothing unless both exist, leaving an embedded extension unbuilt.
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  // React Native's privacy aggregator otherwise attaches the first manifest it
  // finds (including an extension's) to an app that has no manifest reference.
  const application = project.getFirstTarget();
  const applicationResources = project.pbxResourcesBuildPhaseObj(application.uuid);
  applicationResources.files = applicationResources.files.filter(item => {
    const reference = objects.PBXFileReference[objects.PBXBuildFile[item.value]?.fileRef];
    return String(reference?.path || '').replace(/"/g, '') !== `${TARGET}/PrivacyInfo.xcprivacy`;
  });
  const appHasPrivacy = applicationResources.files.some(item => {
    const reference = objects.PBXFileReference[objects.PBXBuildFile[item.value]?.fileRef];
    return String(reference?.path || '').replace(/"/g, '').endsWith('PrivacyInfo.xcprivacy');
  });
  if (!appHasPrivacy) {
    const applicationName = String(application.firstTarget.name).replace(/"/g, '');
    const appPrivacy = project.addFile(`${applicationName}/PrivacyInfo.xcprivacy`, project.getFirstProject().firstProject.mainGroup);
    if (appPrivacy) {
      appPrivacy.uuid = project.generateUuid(); appPrivacy.target = application.uuid;
      project.addToPbxBuildFileSection(appPrivacy); project.addToPbxResourcesBuildPhase(appPrivacy);
    }
  }
  const existing = Object.entries(project.pbxNativeTargetSection()).find(([key, target]) =>
    !key.endsWith('_comment') && String(target.name).replace(/"/g, '') === TARGET);
  // xcode's addTarget embeds app_extension products and adds the containing target dependency.
  const target = existing ? { uuid: existing[0], pbxNativeTarget: existing[1] } :
    project.addTarget(TARGET, 'app_extension', TARGET, identity.bundleIdentifier);
  if (!existing) {
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  }
  // Upgrade existing generated targets as well as creating new ones. A repeated
  // prebuild must neither omit new Swift files nor duplicate source membership.
  const existingGroup = Object.entries(objects.PBXGroup || {}).find(([key, group]) =>
    !key.endsWith('_comment') && String(group.name || group.path).replace(/"/g, '') === TARGET);
  const group = existingGroup ? { uuid: existingGroup[0] } : project.addPbxGroup([], TARGET, TARGET);
  if (!existingGroup) project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  const sourcePhase = target.pbxNativeTarget.buildPhases.map(item => objects.PBXSourcesBuildPhase[item.value]).find(Boolean);
  for (const name of EXTENSION_SOURCES) {
    const included = sourcePhase.files.some(item => {
      const file = objects.PBXFileReference[objects.PBXBuildFile[item.value]?.fileRef];
      return String(file?.path || '').replace(/"/g, '').split('/').pop() === name;
    });
    if (!included) project.addSourceFile(name, { target: target.uuid }, group.uuid);
  }
  // The extension is a separate executable: its own resource phase must copy
  // the manifest even when the containing app includes the pod privacy bundle.
  const privacyResource = project.addFile(`${TARGET}/PrivacyInfo.xcprivacy`, project.getFirstProject().firstProject.mainGroup);
  if (privacyResource) {
    // addResourceFile assumes a Resources group that Expo's template omits.
    privacyResource.uuid = project.generateUuid();
    privacyResource.target = target.uuid;
    project.addToPbxBuildFileSection(privacyResource);
    project.addToPbxResourcesBuildPhase(privacyResource);
  }
  const containingTarget = project.getFirstTarget();
  if (!containingTarget.firstTarget.dependencies.some(item => objects.PBXTargetDependency[item.value]?.target === target.uuid)) {
    project.addTargetDependency(containingTarget.uuid, [target.uuid]);
  }
  const configurations = objects.XCConfigurationList[target.pbxNativeTarget.buildConfigurationList].buildConfigurations;
  const mainTarget = project.getFirstTarget().firstTarget;
  const mainConfigurations = objects.XCConfigurationList[mainTarget.buildConfigurationList].buildConfigurations;
  const mainSettings = objects.XCBuildConfiguration[mainConfigurations[0].value].buildSettings;
  for (const { value } of configurations) {
    Object.assign(objects.XCBuildConfiguration[value].buildSettings, {
      INFOPLIST_FILE: `"${TARGET}/${TARGET}-Info.plist"`,
      CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
      PRODUCT_BUNDLE_IDENTIFIER: `"${identity.bundleIdentifier}"`,
      PRODUCT_NAME: `"${TARGET}"`, PRODUCT_MODULE_NAME: EXTENSION_MODULE_NAME,
      SWIFT_VERSION: '5.0', CLANG_ENABLE_MODULES: 'YES',
      IPHONEOS_DEPLOYMENT_TARGET: mainSettings.IPHONEOS_DEPLOYMENT_TARGET || '15.1',
      TARGETED_DEVICE_FAMILY: '"1,2"', APPLICATION_EXTENSION_API_ONLY: 'YES',
      MARKETING_VERSION: config.version || mainSettings.MARKETING_VERSION || '1.0.0',
      CURRENT_PROJECT_VERSION: config.ios?.buildNumber || mainSettings.CURRENT_PROJECT_VERSION || '1',
      CODE_SIGN_STYLE: 'Automatic', SKIP_INSTALL: 'YES',
      ...(config.ios?.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } :
        mainSettings.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: mainSettings.DEVELOPMENT_TEAM } : {}),
    });
  }
  const attributes = project.getFirstProject().firstProject.attributes;
  attributes.TargetAttributes ??= {};
  const targetAttributes = attributes.TargetAttributes[target.uuid] ??= {};
  targetAttributes.SystemCapabilities ??= {};
  targetAttributes.SystemCapabilities['com.apple.ApplicationGroups.iOS'] = { enabled: 1 };
  targetAttributes.SystemCapabilities['com.apple.Keychain'] = { enabled: 1 };
  const mainAttributes = attributes.TargetAttributes[project.getFirstTarget().uuid] ??= {};
  mainAttributes.SystemCapabilities ??= {};
  mainAttributes.SystemCapabilities['com.apple.ApplicationGroups.iOS'] = { enabled: 1 };
  mainAttributes.SystemCapabilities['com.apple.Keychain'] = { enabled: 1 };
  return project;
}

function withIOSOrderShare(config) {
  const identity = shareIdentity(config);
  config.ios ??= {};
  config.ios.entitlements ??= {};
  config.ios.entitlements[GROUP_KEY] = [...new Set([...(config.ios.entitlements[GROUP_KEY] || []), identity.appGroup])];
  config.ios.entitlements[KEYCHAIN_KEY] = [...new Set([...(config.ios.entitlements[KEYCHAIN_KEY] || []), identity.keychainGroup])];
  config.extra ??= {}; config.extra.eas ??= {}; config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {}; config.extra.eas.build.experimental.ios ??= {};
  const declarations = config.extra.eas.build.experimental.ios.appExtensions ??= [];
  const declaration = { targetName: TARGET, bundleIdentifier: identity.bundleIdentifier, entitlements: { [GROUP_KEY]: [identity.appGroup], [KEYCHAIN_KEY]: [identity.keychainGroup] } };
  const found = declarations.findIndex(item => item.targetName === TARGET);
  if (found < 0) declarations.push(declaration); else declarations[found] = declaration;
  config = withInfoPlist(config, mod => {
    mod.modResults.PackProofOrderShareAppGroup = identity.appGroup;
    mod.modResults.PackProofOrderShareKeychainGroup = identity.keychainGroup;
    mod.modResults.PackProofOrderShareAPIBaseURL = config.extra?.packproofApiBaseUrl || '';
    return mod;
  });
  config = withEntitlementsPlist(config, mod => {
    mod.modResults[GROUP_KEY] = [...new Set([...(mod.modResults[GROUP_KEY] || []), identity.appGroup])];
    mod.modResults[KEYCHAIN_KEY] = [...new Set([...(mod.modResults[KEYCHAIN_KEY] || []), identity.keychainGroup])];
    return mod;
  });
  config = withDangerousMod(config, ['ios', async mod => {
    const destination = path.join(mod.modRequest.platformProjectRoot, TARGET);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ['ShareViewController.swift', 'ShareIntakeTransport.swift']) {
      fs.copyFileSync(path.join(__dirname, 'order-share-ios', name), path.join(destination, name));
    }
    fs.copyFileSync(path.join(__dirname, 'order-share-ios', 'PrivacyInfo.xcprivacy'), path.join(destination, 'PrivacyInfo.xcprivacy'));
    for (const name of ['OrderShareStore.swift', 'OrderShareSessionStore.swift']) {
      fs.copyFileSync(path.join(__dirname, '..', 'modules', 'packproof-order-share', 'ios', name), path.join(destination, name));
    }
    fs.writeFileSync(path.join(destination, `${TARGET}-Info.plist`), plist.build(extensionInfo(mod, identity)));
    fs.writeFileSync(path.join(destination, `${TARGET}.entitlements`), plist.build({ [GROUP_KEY]: [identity.appGroup], [KEYCHAIN_KEY]: [identity.keychainGroup] }));
    return mod;
  }]);
  return withXcodeProject(config, mod => {
    addExtensionTarget(mod.modResults, mod);
    const applicationName = String(mod.modResults.getFirstTarget().firstTarget.name).replace(/"/g, '');
    const manifest = path.join(mod.modRequest.platformProjectRoot, applicationName, 'PrivacyInfo.xcprivacy');
    if (!fs.existsSync(manifest)) {
      fs.mkdirSync(path.dirname(manifest), { recursive: true });
      fs.writeFileSync(manifest, plist.build({ NSPrivacyTracking: false, NSPrivacyTrackingDomains: [], NSPrivacyCollectedDataTypes: [], NSPrivacyAccessedAPITypes: [] }));
    }
    return mod;
  });
}

module.exports = withIOSOrderShare;
module.exports.shareIdentity = shareIdentity;
module.exports.extensionInfo = extensionInfo;
module.exports.addExtensionTarget = addExtensionTarget;
