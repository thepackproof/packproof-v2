const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// Both clients consume the same pure state contract; no server runtime enters the bundle.
config.watchFolders = [path.resolve(__dirname, '..')];
module.exports = config;
