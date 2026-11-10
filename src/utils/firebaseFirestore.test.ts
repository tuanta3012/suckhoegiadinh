import { describe, expect, it } from 'vitest';
import { FIRESTORE_DATABASE_ID } from './firebaseFirestore';

describe('Firestore configuration', () => {
  it('uses the intended non-default Firestore database', () => {
    expect(FIRESTORE_DATABASE_ID).toBe(
      'ai-studio-suckhoegiadinh-3100d4ad-3d59-4806-a128-2e75cffc6c87',
    );
  });
});
