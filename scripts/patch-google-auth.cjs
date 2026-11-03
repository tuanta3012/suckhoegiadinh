const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.join(__dirname, '..', 'node_modules', '@codetrix-studio', 'capacitor-google-auth');
const packageJson = require(path.join(packageRoot, 'package.json'));
if (packageJson.version !== '3.4.0-rc.4') {
  throw new Error(`Unsupported capacitor-google-auth version: ${packageJson.version}`);
}

const sourcePath = path.join(
  packageRoot,
  'android',
  'src',
  'main',
  'java',
  'com',
  'codetrixstudio',
  'capacitor',
  'GoogleAuth',
  'GoogleAuth.java'
);
let source = fs.readFileSync(sourcePath, 'utf8');

function replaceOnce(original, replacement, alreadyApplied) {
  if (source.includes(alreadyApplied)) return;
  if (source.includes(original)) {
    source = source.replace(original, replacement);
  } else {
    throw new Error(`Could not safely apply Android Google Auth patch near: ${original.slice(0, 80)}`);
  }
}

replaceOnce(
  'import android.util.Log;',
  'import android.text.TextUtils;',
  'import android.text.TextUtils;'
);
replaceOnce(
  'import java.net.URL;',
  'import java.net.URL;\nimport java.util.ArrayList;\nimport java.util.List;',
  'import java.util.ArrayList;\nimport java.util.List;'
);
replaceOnce(
  'import android.content.Intent;',
  'import android.app.Activity;\nimport android.content.Intent;',
  'import android.app.Activity;'
);
replaceOnce(
  'import com.getcapacitor.JSObject;',
  'import com.getcapacitor.JSArray;\nimport com.getcapacitor.JSObject;',
  'import com.getcapacitor.JSArray;'
);
replaceOnce(
  'import com.google.android.gms.auth.api.signin.GoogleSignIn;',
  'import com.google.android.gms.auth.api.identity.AuthorizationRequest;\n' +
    'import com.google.android.gms.auth.api.identity.AuthorizationResult;\n' +
    'import com.google.android.gms.auth.api.identity.Identity;\n' +
    'import com.google.android.gms.auth.api.signin.GoogleSignIn;',
  'import com.google.android.gms.auth.api.identity.AuthorizationRequest;'
);
replaceOnce(
  'import java.util.ArrayList;',
  'import java.util.ArrayList;\nimport java.util.Arrays;',
  'import java.util.Arrays;'
);
replaceOnce(
  '  private GoogleSignInClient googleSignInClient;',
  '  private GoogleSignInClient googleSignInClient;\n  private String[] configuredScopes = new String[] {\n' +
    '    "https://www.googleapis.com/auth/userinfo.email",\n' +
    '    "https://www.googleapis.com/auth/userinfo.profile"\n' +
    '  };',
  '  private String[] configuredScopes = new String[] {'
);
const configuredScopesDeclaration =
  '  private String[] configuredScopes = new String[] {\n' +
  '    "https://www.googleapis.com/auth/userinfo.email",\n' +
  '    "https://www.googleapis.com/auth/userinfo.profile"\n' +
  '  };';
while (source.includes(`${configuredScopesDeclaration}\n${configuredScopesDeclaration}`)) {
  source = source.replace(
    `${configuredScopesDeclaration}\n${configuredScopesDeclaration}`,
    configuredScopesDeclaration
  );
}
replaceOnce(
  '  public void loadSignInClient (String clientId, boolean forceCodeForRefreshToken, String[] scopeArray) {\n',
  '  public void loadSignInClient (String clientId, boolean forceCodeForRefreshToken, String[] scopeArray) {\n' +
    '    configuredScopes = scopeArray;\n',
  '    configuredScopes = scopeArray;'
);
while (source.includes('    configuredScopes = scopeArray;\n    configuredScopes = scopeArray;')) {
  source = source.replace(
    '    configuredScopes = scopeArray;\n    configuredScopes = scopeArray;',
    '    configuredScopes = scopeArray;'
  );
}
replaceOnce(
  '        authentication.put(FIELD_ACCESS_TOKEN, accessTokenObject.get(FIELD_ACCESS_TOKEN));\n' +
    '        authentication.put("refreshToken", "");',
  '        authentication.put(FIELD_ACCESS_TOKEN, accessTokenObject.get(FIELD_ACCESS_TOKEN));\n' +
    '        authentication.put(FIELD_TOKEN_EXPIRES, accessTokenObject.get(FIELD_TOKEN_EXPIRES));\n' +
    '        authentication.put(FIELD_TOKEN_EXPIRES_IN, accessTokenObject.get(FIELD_TOKEN_EXPIRES_IN));\n' +
    '        authentication.put("refreshToken", "");',
  '        authentication.put(FIELD_TOKEN_EXPIRES, accessTokenObject.get(FIELD_TOKEN_EXPIRES));\n' +
    '        authentication.put(FIELD_TOKEN_EXPIRES_IN, accessTokenObject.get(FIELD_TOKEN_EXPIRES_IN));\n' +
    '        authentication.put("refreshToken", "");'
);
replaceOnce(
  'manager.getAuthToken(account, "oauth2:profile email", null, false, null, null)',
  'manager.getAuthToken(account, getOAuthTokenType(), null, false, null, null)',
  'manager.getAuthToken(account, getOAuthTokenType(), null, false, null, null)'
);
const oauthTokenTypeMethodPattern = /\r?\n  private String getOAuthTokenType\(\) \{[\s\S]*?\r?\n  \}/g;
const oauthTokenTypeMethods = source.match(oauthTokenTypeMethodPattern) || [];
if (oauthTokenTypeMethods.length > 1) {
  source = source.replace(oauthTokenTypeMethodPattern, '');
  const verifyTokenMarker = '\n  private JSONObject verifyToken(String authToken) throws IOException, JSONException {';
  if (!source.includes(verifyTokenMarker)) {
    throw new Error('Could not safely normalize duplicate OAuth token helper methods');
  }
  source = source.replace(verifyTokenMarker, `${oauthTokenTypeMethods[0]}${verifyTokenMarker}`);
}
replaceOnce(
  '\n  private JSONObject verifyToken(String authToken) throws IOException, JSONException {',
  '\n  private String getOAuthTokenType() {\n' +
    '    List<String> scopes = new ArrayList<>();\n' +
    '    for (String scope : configuredScopes) {\n' +
    '      if ("openid".equals(scope)) continue;\n' +
    '      if ("email".equals(scope)) {\n' +
    '        scopes.add("https://www.googleapis.com/auth/userinfo.email");\n' +
    '      } else if ("profile".equals(scope)) {\n' +
    '        scopes.add("https://www.googleapis.com/auth/userinfo.profile");\n' +
    '      } else if (!scope.isEmpty()) {\n' +
    '        scopes.add(scope);\n' +
    '      }\n' +
    '    }\n' +
    '    return "oauth2:" + TextUtils.join(" ", scopes);\n' +
    '  }\n' +
    '\n  private JSONObject verifyToken(String authToken) throws IOException, JSONException {',
  '\n  private String getOAuthTokenType() {'
);

const pickMethodMarker = '  @PluginMethod()\n  public void pickDriveFile(PluginCall call) {';
const signInMarker = '  @PluginMethod()\n  public void signIn(PluginCall call) {';

if (source.includes(pickMethodMarker)) {
  const startIndex = source.indexOf(pickMethodMarker);
  const endIndex = source.indexOf(signInMarker);
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    source = source.slice(0, startIndex) + source.slice(endIndex);
  }
}

const tokenLog = '    Log.d("AuthenticatedBackend", "token: " + authToken + ", verification: " + stringResponse);\n';
if (source.includes(tokenLog)) source = source.replace(tokenLog, '');

fs.writeFileSync(sourcePath, source);

const manifestPath = path.join(packageRoot, 'android', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf8');
  const activityEntry = '    <activity android:name="com.codetrixstudio.capacitor.GoogleAuth.DrivePickerActivity" android:exported="false" android:theme="@android:style/Theme.Translucent.NoTitleBar" />\n';
  if (manifest.includes('DrivePickerActivity')) {
    manifest = manifest.replace(activityEntry, '').replace('    <activity android:name="com.codetrixstudio.capacitor.GoogleAuth.DrivePickerActivity" android:exported="false" android:theme="@android:style/Theme.Translucent.NoTitleBar" />', '');
    fs.writeFileSync(manifestPath, manifest);
  }
}

const targetActivity = path.join(path.dirname(sourcePath), 'DrivePickerActivity.java');
if (fs.existsSync(targetActivity)) {
  try { fs.unlinkSync(targetActivity); } catch {}
}

const gradlePath = path.join(packageRoot, 'android', 'build.gradle');
let gradle = fs.readFileSync(gradlePath, 'utf8');
gradle = gradle.replace(
  /implementation\s+['"]com\.google\.android\.gms:play-services-auth:[^'"]+['"]/,
  "implementation 'com.google.android.gms:play-services-auth:21.6.0'"
);
fs.writeFileSync(gradlePath, gradle);

// Patch @capacitor/cli template.js compatibility for tar.extract
try {
  const capCliTemplatePath = path.join(__dirname, '..', 'node_modules', '@capacitor', 'cli', 'dist', 'util', 'template.js');
  if (fs.existsSync(capCliTemplatePath)) {
    let templateSrc = fs.readFileSync(capCliTemplatePath, 'utf8');
    if (!templateSrc.includes('const extractFn =')) {
      const safeExtractCode = `async function extractTemplate(src, dir) {
    await (0, utils_fs_1.mkdirp)(dir);
    const tarMod = require("tar");
    const extractFn = (tar_1 && tar_1.default && tar_1.default.extract) ||
                      (tar_1 && tar_1.extract) ||
                      (tarMod && tarMod.extract) ||
                      (tarMod && tarMod.default && tarMod.default.extract) ||
                      (tarMod && tarMod.x) ||
                      (typeof tarMod === "function" ? tarMod : null);
    if (typeof extractFn === "function") {
      await extractFn({ file: src, cwd: dir });
    }
}`;
      if (/async function extractTemplate\([\s\S]*?\n\}/.test(templateSrc)) {
        templateSrc = templateSrc.replace(/async function extractTemplate\([\s\S]*?\n\}/, safeExtractCode);
        fs.writeFileSync(capCliTemplatePath, templateSrc, 'utf8');
        console.log('✓ Patched @capacitor/cli template.js for tar compatibility');
      }
    }
  }
} catch (e) {
  console.warn('Warning: Could not patch @capacitor/cli template.js:', e.message);
}
