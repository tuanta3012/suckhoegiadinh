import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const config = firebaseConfig as typeof firebaseConfig & { firestoreDatabaseId?: string };
export const FIRESTORE_DATABASE_ID = config.firestoreDatabaseId?.trim();

if (!FIRESTORE_DATABASE_ID) {
  throw new Error('firebase-applet-config.json chưa khai báo firestoreDatabaseId.');
}

export const firestoreAuth = getAuth(app);
export const firestoreDb =
  FIRESTORE_DATABASE_ID === '(default)'
    ? getFirestore(app)
    : getFirestore(app, FIRESTORE_DATABASE_ID);
