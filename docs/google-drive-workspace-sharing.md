# Google Drive Workspace sharing

## What the app does

- A Workspace stores one Firestore access document per normalized email in `workspaceAccess/{email}`. The Admin has an `ADMIN` record; members have `EDITOR` or `VIEWER` records. Each record contains the shared Drive root folder ID and `family.json` file ID, so login resolves the Workspace with one document read.
- An Admin grants the matching Drive `writer` or `reader` permission, then writes or updates the member's access record. A signed-in member reads the record keyed by their Google email, opens the shared folder, and verifies that the email is listed in `family.json`. The record works across devices.
- Admin member lists are loaded from records owned by the Admin and filtered by folder ID. Drive folder discovery only runs when a direct email access record is not found.
- Legacy `families`, `userFamilyLinks`, and `invitations` records are read during migration. The first successful Admin synchronization imports the Workspace's member emails and legacy invitations into `workspaceAccess`; it does not delete legacy Firestore documents.
- Users can still paste a Drive folder ID manually. Existing Workspaces without an `adminEmail` are not automatically claimed or made manageable by the first account that opens them.
- Drive permissions are applied to the Workspace root folder (`EDITOR` maps to Drive `writer`; `VIEWER` maps to `reader`). The app checks the permission before publishing the access record and attempts to revoke Drive access before removing it. Permissions inherited from a parent folder cannot be lowered or revoked at the Workspace folder; the app reports that condition and the Admin must change the parent folder's sharing.
- A member's email in `family.json` is that member's Workspace identity. Members can view all family profiles and create new member records, but only the Admin can edit or delete existing member records. The Admin's add or email-change operation grants Drive Editor access, saves `family.json`, then publishes the matching access record. Deleting a member removes its manifest entry, revokes Drive access, and removes its access record. The app rejects a removed email even when it tries to reopen a cached folder ID.
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

Before using Workspace sharing, deploy the repository's `firestore.rules` to that exact project **and database** in Firebase Console. Firestore rules do not deploy automatically with the app. The rules grant access to the email-keyed `workspaceAccess` records and retain limited legacy access during migration.

Access document IDs use trimmed, lowercase email addresses, matching the app's email normalization. The first Admin synchronization migrates existing members once; subsequent app opens read the access records without rechecking every Drive permission. The Admin can still use **Đồng bộ quyền truy cập** to force a permission refresh.

After deployment, verify the Admin's access record exists, then invite a Google account. The invited account should link automatically while the app is open or on its next launch. Changing the rules file in the repository does not deploy it: publish the rules to the configured project/database in Firebase Console.

## Operational limitations

- `drive.file` only grants access to files the user opens with this app through a supported picker/file-selection flow or files created by the app. A folder ID and Drive sharing permission do not, by themselves, guarantee that OAuth can access an existing shared folder. If stamping or reading `family.json` returns 403/404, the handshake is intentionally retained; verify the token's granted scope and Drive access rather than deleting the Firestore record.
- One normalized email can point to one active Workspace. Invite that account to a different Workspace only after removing or replacing the existing access record.
- Existing Workspace member emails are migrated on the first successful Admin synchronization. Legacy Firestore documents are retained for rollback and should only be removed after verifying all Admin and member devices use the new app.
- Firestore relay rules cannot prevent a user who already has Drive Editor access from editing Drive files. Drive permissions are the effective data access control.
