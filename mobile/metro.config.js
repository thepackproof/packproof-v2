const path = require('path');
const fs = require('fs');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// Both clients consume the same pure state contract; no server runtime enters the bundle.
config.watchFolders = [path.resolve(__dirname, '..')];
// Isolated worktrees can share an existing dependency install without copying it.
const dependencies = fs.realpathSync(path.resolve(__dirname, 'node_modules'));
if (dependencies !== path.resolve(__dirname, 'node_modules')) config.watchFolders.push(dependencies);
// GitHub EAS builds install only mobile dependencies. Shared sibling sources
// must resolve Babel helpers and other runtime imports from the same install.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  dependencies,
  ...config.resolver.nodeModulesPaths,
];
// Shared pure TypeScript uses NodeNext .js specifiers for the API build. Resolve
// only that module's relative specifiers to its source in native EAS bundles.
const existingResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (context.originModulePath.includes(`${path.sep}backend${path.sep}src${path.sep}identifiers${path.sep}`) && moduleName.startsWith('.') && moduleName.endsWith('.js'))
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  return existingResolve ? existingResolve(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
