const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// Both clients consume the same pure state contract; no server runtime enters the bundle.
config.watchFolders = [path.resolve(__dirname, '..')];
// GitHub EAS builds install only mobile dependencies. Shared sibling sources
// must resolve Babel helpers and other runtime imports from the same install.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  ...config.resolver.nodeModulesPaths,
];
module.exports = config;
