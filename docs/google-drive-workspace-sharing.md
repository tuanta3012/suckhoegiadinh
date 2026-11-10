# Google Drive Workspace sharing

## What the app does

- A new Workspace records its `family.json` Admin email and registers its Drive folder and manifest IDs in Firestore.
- An Admin can invite a Google email from the Workspace sharing screen. The app grants the matching Drive `writer` or `reader` permission first, then publishes the Firestore invitation. If either Drive access or the Firestore write fails, the app reports the error instead of showing a successful invitation.
- When a member is signed in, a Firestore listener links a new invitation automatically. If a different Workspace is already open, the app asks before switching. Invitations remain in Firestore so another device can use the same assignment.
- Users can still paste a Drive folder ID manually. Existing Workspaces without an `adminEmail` are not automatically claimed or made manageable by the first account that opens them.
- Drive permissions are applied to the Workspace root folder (`EDITOR` maps to Drive `writer`; `VIEWER` maps to `reader`). The app checks the permission before publishing the invitation and attempts to revoke Drive access before removing an assignment. Permissions inherited from a parent folder cannot be lowered or revoked at the Workspace folder; the app reports that condition and the Admin must change the parent folder's sharing.
- A member's email in `family.json` is that member's Workspace identity. On add or email change, the Admin's save operation grants the new account Drive Editor access first, saves the member to `family.json`, then publishes an Editor assignment to Firestore. Changing or clearing an email revokes the old account after the manifest update. Deleting a member removes its manifest entry, then revokes Drive access and removes its Firestore assignment. Other invitations created separately from the sharing screen are retained.
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

Before using invitations, deploy the repository's `firestore.rules` to that exact project **and database** in Firebase Console. Firestore rules do not deploy automatically with the app. The rules grant access only to the `health_workspace_relays` and `health_workspace_invites` paths; all other document paths remain denied.

Email comparisons in the rules are case-insensitive to match the app's normalized lowercase invitation paths.

After deployment, verify an Admin can register a Workspace, invite a Google account, and revoke that account. The invited account should link automatically while the app is open or on its next launch. Changing the rules file in the repository does not deploy it: publish the rules to the configured project/database in Firebase Console.

## Operational limitations

- Invitations to multiple Workspaces for one email are rejected as ambiguous; use manual folder selection or revoke the extra invitations.
- Existing Workspace migration is deliberately not automatic. Create a new Workspace to enable relay-based sharing; keep the old folder ID for legacy access.
- Firestore relay rules cannot prevent a user who already has Drive Editor access from editing Drive files. Drive permissions are the effective data access control.
