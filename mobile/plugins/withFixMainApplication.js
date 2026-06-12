const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// In Expo SDK 56 / RN 0.85, ReactNativeHostWrapper was replaced by ExpoReactHostFactory.
// Stale android directories (from earlier SDK versions) still reference the removed class,
// causing compileReleaseKotlin to fail with "Unresolved reference: ReactNativeHostWrapper".
// This plugin rewrites MainApplication.kt to use the correct SDK 56 API when it detects
// the old pattern.
module.exports = function withFixMainApplication(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const packageName = config.android?.package ?? 'org.undp.crisisreporter';
      const packagePath = packageName.replace(/\./g, '/');
      const mainAppFile = path.join(
        config.modRequest.platformProjectRoot,
        `app/src/main/java/${packagePath}/MainApplication.kt`
      );

      if (!fs.existsSync(mainAppFile)) return config;

      const contents = fs.readFileSync(mainAppFile, 'utf-8');
      if (!contents.includes('ReactNativeHostWrapper')) return config;

      fs.writeFileSync(
        mainAppFile,
        `package ${packageName}

import android.app.Application
import android.content.res.Configuration

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint

import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoReactHostFactory

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    ExpoReactHostFactory.getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        }
    )
  }

  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
`,
        'utf-8'
      );

      return config;
    },
  ]);
};
