const path = require('node:path');
const { stapleAndValidate, validateStapledArtifact, safeDiagnostic } = require('./notarize-dmg.cjs');

async function notarizeApplication(options, { notarize = require('@electron/notarize').notarize, staple = stapleAndValidate, validate = validateStapledArtifact, env = process.env } = {}) {
  try {
    await notarize(options);
  } catch (error) {
    const message = String(error?.message || error);
    // The upstream library emits this only AFTER notarytool accepted the app.
    // Recover its ticket-service network failure without resubmitting or re-signing.
    if (!/^Failed to staple your application with code: 68\b/.test(message) || !/NSURLErrorDomain|network connection was lost|CloudKit's response is inconsistent/i.test(message)) {
      throw new Error(`Application notarization failed: ${safeDiagnostic({ stderr: message }, env)}`);
    }
    await staple(options.appPath);
  }
  await validate(options.appPath);
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin' || !process.env.APP_ENV || process.env.APP_ENV === 'development') return;
  const env = process.env;
  const auth = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER
    ? { appleApiKey: env.APPLE_API_KEY, appleApiKeyId: env.APPLE_API_KEY_ID, appleApiIssuer: env.APPLE_API_ISSUER }
    : { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID };
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  await notarizeApplication({ appPath, ...auth });
};
module.exports.notarizeApplication = notarizeApplication;
