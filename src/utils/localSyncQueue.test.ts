import { beforeEach, describe, expect, it } from 'vitest';
import { SavingsBook } from '../types';
import {
  clearLocalSyncQueue,
  hasLocalSyncMutations,
  queueBookDeletionForDrive,
  queueBookUpdateForDrive,
  queueNewBookForDrive,
  readLocalSyncQueue,
} from './localSyncQueue';

const makeBook = (overrides: Partial<SavingsBook> = {}): SavingsBook => ({
  id: 'book-1',
  bookCode: 'SEA-001',
  bankId: 'seabank',
  owner: 'Owner',
  depositType: 'online',
  principal: 10_000_000,
  interestRate: 5,
  termMonths: 6,
  startDate: '2026-01-01',
  maturityDate: '2026-07-01',
  rolloverOption: 'none',
  status: 'active',
  ...overrides,
});

describe('local sync mutation queue', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
  });

  it('reads queues written by older app versions', () => {
    localStorage.setItem(
      'savings_sync_mutations_v1',
      JSON.stringify({ newBooks: [], settlements: [], settledBookCodes: [] })
    );

    expect(readLocalSyncQueue()).toMatchObject({ updatedBooks: [], deletedBooks: [] });
  });

  it('preserves the original snapshot across repeated edits', () => {
    const original = makeBook();
    const firstEdit = makeBook({ interestRate: 5.2 });
    const finalEdit = makeBook({ interestRate: 5.4 });

    expect(queueBookUpdateForDrive(original, firstEdit)).toBe(true);
    expect(queueBookUpdateForDrive(firstEdit, finalEdit)).toBe(true);
    expect(readLocalSyncQueue().updatedBooks).toEqual([
      { baseBook: original, book: finalEdit },
    ]);
  });

  it('replaces a queued creation when edited and removes it when deleted', () => {
    const created = makeBook();
    const edited = makeBook({ interestRate: 5.3 });

    expect(queueNewBookForDrive(created)).toBe(true);
    expect(queueBookUpdateForDrive(created, edited)).toBe(true);
    expect(readLocalSyncQueue().newBooks).toEqual([edited]);
    expect(readLocalSyncQueue().updatedBooks).toEqual([]);

    expect(queueBookDeletionForDrive(edited)).toBe(true);
    expect(readLocalSyncQueue()).toMatchObject({
      newBooks: [],
      updatedBooks: [],
      deletedBooks: [edited],
    });
  });

  it('does not clear mutations added while an earlier push is in flight', () => {
    const firstBook = makeBook();
    const secondBook = makeBook({ id: 'book-2', bookCode: 'SEA-002' });
    queueNewBookForDrive(firstBook);
    const pushSnapshot = readLocalSyncQueue();
    queueNewBookForDrive(secondBook);

    expect(clearLocalSyncQueue(pushSnapshot)).toBe(false);
    expect(hasLocalSyncMutations(readLocalSyncQueue())).toBe(true);
    expect(readLocalSyncQueue().newBooks).toEqual([firstBook, secondBook]);
  });
});
