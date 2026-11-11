# Google Drive Workspace sharing

## What the app does

- A new Workspace records its `family.json` Admin email and registers its Drive folder and manifest IDs in Firestore.
- An Admin can invite a Google email from the Workspace sharing screen. The app grants the matching Drive `writer` or `reader` permission first, then publishes the Firestore invitation and a `health_assigned_folders/{memberEmail}` handshake record containing the folder ID, manifest ID, Admin/member emails, and active status.
- When a member is signed in, the app reads the persistent assignment, stamps the shared folder with the app's `appProperties.app_id`, opens `family.json`, and verifies the signed-in email is the Admin or a listed family member. The Firestore assignment remains after successful linking so the same member can connect from other devices; it is removed when the Admin revokes access or removes the member.
- After successful linking, the app caches the folder/manifest IDs per account and can use the persistent Firestore assignment on another device before falling back to Drive discovery. If multiple stamped family folders match, it reports ambiguity instead of selecting one silently.
- Users can still paste a Drive folder ID manually. Existing Workspaces without an `adminEmail` are not automatically claimed or made manageable by the first account that opens them.
- Drive permissions are applied to the Workspace root folder (`EDITOR` maps to Drive `writer`; `VIEWER` maps to `reader`). The app checks the permission before publishing the invitation and attempts to revoke Drive access before removing an assignment. Permissions inherited from a parent folder cannot be lowered or revoked at the Workspace folder; the app reports that condition and the Admin must change the parent folder's sharing.
- A member's email in `family.json` is that member's Workspace identity. Members can view all family profiles and create new member records, but only the Admin can edit or delete existing member records. The Admin's add or email-change operation grants the account Drive Editor access first, saves `family.json`, then publishes an Editor assignment to Firestore. Deleting a member removes its manifest entry, revokes Drive access, and removes its workspace invitation and persistent folder assignment. The app rejects a removed email even when it tries to reopen a cached folder ID. Other invitations created separately from the sharing screen are retained.
- The native app stores its short-lived Drive access token in the Android secure storage plugin and tries the Google Auth plugin's silent refresh when needed. Refresh availability depends on the Google session; users may need to sign in again.

## Offline data and synchronization

- Health profiles, the family manifest, and uploaded originals are stored in the Workspace's Google Drive folder. Firestore is used only for Workspace assignment and invitation relay metadata; it is not the health-record store.
- On native devices, pending profile edits, member changes, and upload payloads are persisted in the app's local Filesystem outbox, partitioned by signed-in Google account. The app retries these operations when Drive becomes available. Web browsers do not persist a durable health-data outbox.
- Offline changes made in a local-only Workspace are not assigned to an arbitrary shared Workspace. They are migrated only after a Drive root is selected or created for that account. Member matching uses stable ID or email, not name alone.
- Drive ETags protect manifest writes from overwriting concurrent changes. Conflicting edits to the same member field or event ID are retained as pending work and require resolution; device timestamps are not a global ordering mechanism.
- Pending uploads and edits are not proof of successful cloud backup. Keep the app installed and check that synchronization has completed before relying on another device to have the latest data. Uninstalling or clearing app data removes the local outbox.
- The destructive **Xóa dữ liệu** action clears health-related local caches, OCR/deletion queues, digitization logs, and the native sync outbox (including unsynced upload payloads). When online with Drive authorization and Workspace Admin access, it recursively deletes the Workspace folder and its contents from Drive before resetting the local workspace. Offline, the Drive copy remains untouched; if cloud deletion fails, the app reports that separately from the local reset.

## Deploy Firestore rules

The app is configured for Firebase project `gen-lang-client-0324091386` and the non-default Firestore database `ai-studio-suckhoegiadinh-3100d4ad-3d59-4806-a128-2e75cffc6c87`. Firestore is initialized centrally from `firebase-applet-config.json`; do not replace this database ID with `(default)`.

Before using invitations, deploy the repository's `firestore.rules` to that exact project **and database** in Firebase Console. Firestore rules do not deploy automatically with the app. The rules grant access only to the workspace relay, invitation, and `health_assigned_folders` paths; all other document paths remain denied.

Email comparisons in the rules are case-insensitive to match the app's normalized lowercase invitation paths.

After deployment, verify an Admin can register a Workspace and invite a Google account. The invited account should link automatically while the app is open or on its next launch. Changing the rules file in the repository does not deploy it: publish the rules to the configured project/database in Firebase Console.

## Operational limitations

- `drive.file` only grants access to files the user opens with this app through a supported picker/file-selection flow or files created by the app. A folder ID and Drive sharing permission do not, by themselves, guarantee that OAuth can access an existing shared folder. If stamping or reading `family.json` returns 403/404, the handshake is intentionally retained; verify the token's granted scope and Drive access rather than deleting the Firestore record.
- Invitations to multiple Workspaces for one email are rejected as ambiguous; revoke extra invitations or stamped folders.
- Existing Workspace migration is deliberately not automatic. Create a new Workspace to enable relay-based sharing; keep the old folder ID for legacy access.
- Firestore relay rules cannot prevent a user who already has Drive Editor access from editing Drive files. Drive permissions are the effective data access control.
