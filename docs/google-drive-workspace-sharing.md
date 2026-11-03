# Google Drive Workspace sharing

## What the app does

- A new Workspace records its `family.json` Admin email and registers its Drive folder and manifest IDs in Firestore.
- An Admin can publish an invitation for a verified Google email. On that account's first launch, the app reads one invitation and opens the assigned Drive folder automatically.
- Users can still paste a Drive folder ID manually. Existing Workspaces without an `adminEmail` are not automatically claimed or made manageable by the first account that opens them.
- Drive access is independent from the Firestore invitation. The Admin must share the root Drive folder with each invited Google account. `EDITOR` and `VIEWER` are invitation metadata only; Google Drive controls actual read/write access.
- The native app stores its short-lived Drive access token in the Android secure storage plugin and tries the Google Auth plugin's silent refresh when needed. Refresh availability depends on the Google session; users may need to sign in again.

## Deploy Firestore rules

The app is configured for Firebase project `gen-lang-client-0324091386` and the non-default Firestore database `ai-studio-suckhoegiadinh-3100d4ad-3d59-4806-a128-2e75cffc6c87`.

Before using invitations, deploy the repository's `firestore.rules` to that exact project **and database** in Firebase Console. Firestore rules do not deploy automatically with the app. The rules grant access only to the `health_workspace_relays` and `health_workspace_invites` paths; all other document paths remain denied.

After deployment, verify an Admin can create a Workspace and send an invitation, and that the invited account can open the same Drive folder after the Admin separately shares it in Google Drive. Do not treat a successful Firestore invitation as proof of Drive access.

## Operational limitations

- The app does not change Google Drive sharing permissions through the Drive API.
- Invitations to multiple Workspaces for one email are rejected as ambiguous; use manual folder selection or revoke the extra invitations.
- Existing Workspace migration is deliberately not automatic. Create a new Workspace to enable relay-based sharing; keep the old folder ID for legacy access.
- Firestore relay rules cannot prevent a user who already has Drive Editor access from editing Drive files. Drive permissions are the effective data access control.
