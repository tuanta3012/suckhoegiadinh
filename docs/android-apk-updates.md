# Android APK updates

## Release workflow

1. Increase `version` in `package.json` for each app release. The app compares this semantic version with the `version` field in `version.json`; the Git commit-derived Android `versionCode` does not trigger an update by itself.
2. Push the change to `main` or run the `Auto Build & Release APK from AI Studio Code` workflow manually.
3. GitHub Actions builds the signed sideload APK, publishes it as a GitHub Release asset, and updates `version.json` with its HTTPS download URL. When enabled, the AAB remains a separate Actions artifact for Play Store submission.
4. The installed app checks `version.json`, shows the version and release notes, and waits for the user to choose **Cập nhật ngay**. Capacitor downloads the APK to the app cache and opens Android's package installer.

## Android installation requirements

Android does not permit an app to silently install its own APK. The user must confirm installation in Android's package installer and may need to allow installs from this app in system settings. This update flow initiates that system UI; it cannot bypass the OS confirmation.

The APK must use the same Android `applicationId` and signing certificate as the installed app, or Android will reject it as an update. Preserve the existing release keystore and credentials across releases. Do not generate a new fallback keystore for a release intended to update existing installations.

The public GitHub Release contains the sideload APK only. The AAB is not an installable APK and is retained as a separate Actions artifact.
