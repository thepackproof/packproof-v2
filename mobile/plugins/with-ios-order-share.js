const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withDangerousMod, withXcodeProject, withEntitlementsPlist, withInfoPlist } = require('expo/config-plugins');

const TARGET = 'PackProofOrderShare';
// The app imports the PackProofOrderShare Expo pod. A same-named extension
// Swift module shadows that pod during dependency scanning in the app target.
const EXTENSION_MODULE_NAME = 'PackProofOrderShareExtension';
const GROUP_KEY = 'com.apple.security.application-groups';

function shareIdentity(config) {
  const bundleIdentifier = config.ios?.bundleIdentifier || 'com.packproof.mobile';
  return { bundleIdentifier: `${bundleIdentifier}.OrderShare`, appGroup: `group.${bundleIdentifier}.orders` };
}

function extensionInfo(config, identity) {
  return {
    CFBundleDisplayName: 'PackProof', CFBundleName: TARGET, CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleExecutable: '$(EXECUTABLE_NAME)', CFBundlePackageType: 'XPC!', CFBundleInfoDictionaryVersion: '6.0',
    CFBundleShortVersionString: '$(MARKETING_VERSION)', CFBundleVersion: '$(CURRENT_PROJECT_VERSION)',
    PackProofOrderShareAppGroup: identity.appGroup,
    NSExtension: {
      NSExtensionPointIdentifier: 'com.apple.share-services',
      NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController',
      NSExtensionAttributes: {
        // Match only supported data. Do not advertise video, arbitrary files, or executable content.
        NSExtensionActivationRule: 'extensionItems.@count > 0 AND SUBQUERY(extensionItems, $item, $item.attachments.@count <= 4 AND SUBQUERY($item.attachments, $attachment, ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.plain-text" OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.url" OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.jpeg" OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.png" OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "public.heic" OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "org.webmproject.webp" OR ANY $attachment.registeredTypeIdentifiers UTI-CONFORMS-TO "com.adobe.pdf").@count == $item.attachments.@count).@count == extensionItems.@count',
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
  const existing = Object.entries(project.pbxNativeTargetSection()).find(([key, target]) =>
    !key.endsWith('_comment') && String(target.name).replace(/"/g, '') === TARGET);
  // xcode's addTarget embeds app_extension products and adds the containing target dependency.
  const target = existing ? { uuid: existing[0], pbxNativeTarget: existing[1] } :
    project.addTarget(TARGET, 'app_extension', TARGET, identity.bundleIdentifier);
  if (!existing) {
    project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    const group = project.addPbxGroup([], TARGET, TARGET);
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);
    for (const name of ['ShareViewController.swift', 'OrderShareStore.swift']) {
      project.addSourceFile(name, { target: target.uuid }, group.uuid);
    }
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
  const mainAttributes = attributes.TargetAttributes[project.getFirstTarget().uuid] ??= {};
  mainAttributes.SystemCapabilities ??= {};
  mainAttributes.SystemCapabilities['com.apple.ApplicationGroups.iOS'] = { enabled: 1 };
  return project;
}

function withIOSOrderShare(config) {
  const identity = shareIdentity(config);
  config.ios ??= {};
  config.ios.entitlements ??= {};
  config.ios.entitlements[GROUP_KEY] = [...new Set([...(config.ios.entitlements[GROUP_KEY] || []), identity.appGroup])];
  config.extra ??= {}; config.extra.eas ??= {}; config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {}; config.extra.eas.build.experimental.ios ??= {};
  const declarations = config.extra.eas.build.experimental.ios.appExtensions ??= [];
  const declaration = { targetName: TARGET, bundleIdentifier: identity.bundleIdentifier, entitlements: { [GROUP_KEY]: [identity.appGroup] } };
  const found = declarations.findIndex(item => item.targetName === TARGET);
  if (found < 0) declarations.push(declaration); else declarations[found] = declaration;
  config = withInfoPlist(config, mod => {
    mod.modResults.PackProofOrderShareAppGroup = identity.appGroup; return mod;
  });
  config = withEntitlementsPlist(config, mod => {
    mod.modResults[GROUP_KEY] = [...new Set([...(mod.modResults[GROUP_KEY] || []), identity.appGroup])]; return mod;
  });
  config = withDangerousMod(config, ['ios', async mod => {
    const destination = path.join(mod.modRequest.platformProjectRoot, TARGET);
    fs.mkdirSync(destination, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'order-share-ios', 'ShareViewController.swift'), path.join(destination, 'ShareViewController.swift'));
    fs.copyFileSync(path.join(__dirname, 'order-share-ios', 'PrivacyInfo.xcprivacy'), path.join(destination, 'PrivacyInfo.xcprivacy'));
    fs.copyFileSync(path.join(__dirname, '..', 'modules', 'packproof-order-share', 'ios', 'OrderShareStore.swift'), path.join(destination, 'OrderShareStore.swift'));
    fs.writeFileSync(path.join(destination, `${TARGET}-Info.plist`), plist.build(extensionInfo(mod, identity)));
    fs.writeFileSync(path.join(destination, `${TARGET}.entitlements`), plist.build({ [GROUP_KEY]: [identity.appGroup] }));
    return mod;
  }]);
  return withXcodeProject(config, mod => { addExtensionTarget(mod.modResults, mod); return mod; });
}

module.exports = withIOSOrderShare;
module.exports.shareIdentity = shareIdentity;
module.exports.extensionInfo = extensionInfo;
module.exports.addExtensionTarget = addExtensionTarget;
