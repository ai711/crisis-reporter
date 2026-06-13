#!/bin/bash
# Force expo prebuild to generate a fresh android directory on every EAS build.
# Without this, EAS reuses a cached android/ containing stale generated files
# (e.g. MainApplication.kt referencing the removed ReactNativeHostWrapper class),
# which causes compileReleaseKotlin to fail even though config plugins would
# otherwise patch the file correctly.
echo ">>> Removing android/ so expo prebuild regenerates it from scratch."
rm -rf ./android
echo ">>> Done. expo prebuild will create a clean native directory."
