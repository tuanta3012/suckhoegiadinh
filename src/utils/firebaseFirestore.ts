import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
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

async function testConnection() {
  try {
    await getDocFromServer(doc(firestoreDb, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

if (typeof window !== 'undefined' && import.meta.env?.MODE !== 'test') {
  void testConnection();
}
