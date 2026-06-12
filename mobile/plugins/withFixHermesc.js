const { withAppBuildGradle } = require('@expo/config-plugins');

// In RN 0.85+, hermesc is no longer shipped as a prebuilt binary inside
// react-native/sdks/hermesc/. The generated android/app/build.gradle still
// has a hermesCommand line pointing to that old path, which overrides the
// Gradle plugin's auto-detect and causes the build to fail.
//
// Removing that line lets detectOSAwareHermesCommand() fall through to its
// step-3 lookup: node_modules/hermes-compiler/hermesc/{OS-BIN}/hermesc,
// which is the correct location for this version of Hermes.
module.exports = function withFixHermesc(config) {
  return withAppBuildGradle(config, (config) => {
    config.modResults.contents = config.modResults.contents.replace(
      /[ \t]*hermesCommand = new File\(\["node"[^\n]+sdks\/hermesc[^\n]+\n/,
      ''
    );
    return config;
  });
};
