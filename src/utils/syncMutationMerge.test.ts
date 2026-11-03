import { describe, expect, it } from 'vitest';
import { SavingsBook } from '../types';
import { mergeQueuedBooks } from './syncMutationMerge';
import { LocalSyncMutationQueue } from './localSyncQueue';

const makeBook = (id: string, overrides: Partial<SavingsBook> = {}): SavingsBook => ({
  id,
  bookCode: `SEA-${id}`,
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

const emptyQueue = (): LocalSyncMutationQueue => ({
  newBooks: [],
  settlements: [],
  settledBookCodes: [],
  updatedBooks: [],
  deletedBooks: [],
});

describe('mergeQueuedBooks', () => {
  it('applies queued edits and deletions without changing the book schema', () => {
    const original = makeBook('edit');
    const edited = makeBook('edit', { interestRate: 5.5 });
    const deleted = makeBook('delete');
    const queue = {
      ...emptyQueue(),
      updatedBooks: [{ baseBook: original, book: edited }],
      deletedBooks: [deleted],
    };

    const result = mergeQueuedBooks([original, deleted], queue);

    expect(result.conflict).toBeUndefined();
    expect(result.books).toEqual([edited]);
    expect(Object.keys(result.books[0]).sort()).toEqual(Object.keys(edited).sort());
  });

  it('keeps existing conflict protection for a remotely changed book', () => {
    const original = makeBook('edit');
    const localEdit = makeBook('edit', { interestRate: 5.5 });
    const remoteEdit = makeBook('edit', { interestRate: 5.7 });

    const result = mergeQueuedBooks([remoteEdit], {
      ...emptyQueue(),
      updatedBooks: [{ baseBook: original, book: localEdit }],
    });

    expect(result.conflict).toContain('đã được thay đổi trên Drive');
    expect(result.books).toEqual([remoteEdit]);
  });

  it('does not re-add a remotely removed book when applying a local edit', () => {
    const original = makeBook('edit');
    const localEdit = makeBook('edit', { interestRate: 5.5 });

    const result = mergeQueuedBooks([], {
      ...emptyQueue(),
      updatedBooks: [{ baseBook: original, book: localEdit }],
    });

    expect(result.conflict).toContain('Không tìm thấy sổ');
    expect(result.books).toEqual([]);
  });
});
