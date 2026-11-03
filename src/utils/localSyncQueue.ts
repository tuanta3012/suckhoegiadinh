import { SavingsBook, SettlementAdjustment } from '../types';

const QUEUE_KEY = 'savings_sync_mutations_v1';

export interface LocalSyncMutationQueue {
  newBooks: SavingsBook[];
  settlements: SettlementAdjustment[];
  settledBookCodes: string[];
  updatedBooks: Array<{ baseBook: SavingsBook; book: SavingsBook }>;
  deletedBooks: SavingsBook[];
}

const EMPTY_QUEUE = (): LocalSyncMutationQueue => ({
  newBooks: [],
  settlements: [],
  settledBookCodes: [],
  updatedBooks: [],
  deletedBooks: [],
});

export function readLocalSyncQueue(): LocalSyncMutationQueue {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return EMPTY_QUEUE();
    const parsed = JSON.parse(raw) as Partial<LocalSyncMutationQueue>;
    if (
      !Array.isArray(parsed.newBooks) ||
      !Array.isArray(parsed.settlements) ||
      !Array.isArray(parsed.settledBookCodes) ||
      (parsed.updatedBooks !== undefined && !Array.isArray(parsed.updatedBooks)) ||
      (parsed.deletedBooks !== undefined && !Array.isArray(parsed.deletedBooks))
    ) {
      throw new Error('Dữ liệu hàng đợi đồng bộ local không đúng định dạng.');
    }
    return {
      newBooks: parsed.newBooks,
      settlements: parsed.settlements,
      settledBookCodes: parsed.settledBookCodes,
      updatedBooks: parsed.updatedBooks || [],
      deletedBooks: parsed.deletedBooks || [],
    };
  } catch (error) {
    console.error('Không thể đọc hàng đợi thay đổi chờ đồng bộ:', error);
    return EMPTY_QUEUE();
  }
}

function updateLocalSyncQueue(update: (queue: LocalSyncMutationQueue) => LocalSyncMutationQueue): boolean {
  try {
    const next = update(readLocalSyncQueue());
    localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
    localStorage.setItem('savings_sync_eligible_change_v1', 'true');
    return true;
  } catch (error) {
    console.error('Không thể lưu thay đổi chờ đồng bộ:', error);
    return false;
  }
}

export function hasLocalSyncMutations(queue: LocalSyncMutationQueue): boolean {
  return (
    queue.newBooks.length > 0 ||
    queue.settlements.length > 0 ||
    queue.settledBookCodes.length > 0 ||
    queue.updatedBooks.length > 0 ||
    queue.deletedBooks.length > 0
  );
}

export function queueNewBookForDrive(book: SavingsBook): boolean {
  return updateLocalSyncQueue((queue) => ({
    ...queue,
    newBooks: [...queue.newBooks.filter((item) => item.id !== book.id), book],
    updatedBooks: queue.updatedBooks.filter((item) => item.book.id !== book.id),
    deletedBooks: queue.deletedBooks.filter((item) => item.id !== book.id),
  }));
}

export function queueBookUpdateForDrive(baseBook: SavingsBook, book: SavingsBook): boolean {
  return updateLocalSyncQueue((queue) => {
    const isNewBook = queue.newBooks.some((item) => item.id === book.id);
    if (isNewBook) {
      return {
        ...queue,
        newBooks: [...queue.newBooks.filter((item) => item.id !== book.id), book],
      };
    }

    const existing = queue.updatedBooks.find((item) => item.book.id === book.id);
    return {
      ...queue,
      updatedBooks: [
        ...queue.updatedBooks.filter((item) => item.book.id !== book.id),
        { baseBook: existing?.baseBook || baseBook, book },
      ],
      deletedBooks: queue.deletedBooks.filter((item) => item.id !== book.id),
    };
  });
}

export function queueBookDeletionForDrive(book: SavingsBook): boolean {
  return updateLocalSyncQueue((queue) => ({
    ...queue,
    newBooks: queue.newBooks.filter((item) => item.id !== book.id),
    updatedBooks: queue.updatedBooks.filter((item) => item.book.id !== book.id),
    deletedBooks: [...queue.deletedBooks.filter((item) => item.id !== book.id), book],
  }));
}

export function queueSettlementForDrive(
  settlement: SettlementAdjustment | null,
  settledBookCode: string
): boolean {
  return updateLocalSyncQueue((queue) => ({
    ...queue,
    newBooks: queue.newBooks.filter(
      (book) =>
        (book.bookCode || '').replace(/\s+/g, '').toUpperCase() !==
        settledBookCode.replace(/\s+/g, '').toUpperCase()
    ),
    updatedBooks: queue.updatedBooks.filter(
      (item) =>
        (item.book.bookCode || '').replace(/\s+/g, '').toUpperCase() !==
        settledBookCode.replace(/\s+/g, '').toUpperCase()
    ),
    deletedBooks: queue.deletedBooks.filter(
      (book) =>
        (book.bookCode || '').replace(/\s+/g, '').toUpperCase() !==
        settledBookCode.replace(/\s+/g, '').toUpperCase()
    ),
    settlements: settlement
      ? [...queue.settlements.filter((item) => item.id !== settlement.id), settlement]
      : queue.settlements,
    settledBookCodes: Array.from(new Set([...queue.settledBookCodes, settledBookCode])),
  }));
}

export function removePendingBookFromDrive(bookId: string): void {
  if (!readLocalSyncQueue().newBooks.some((book) => book.id === bookId)) return;
  updateLocalSyncQueue((queue) => ({
    ...queue,
    newBooks: queue.newBooks.filter((book) => book.id !== bookId),
    updatedBooks: queue.updatedBooks.filter((item) => item.book.id !== bookId),
  }));
}

export function clearLocalSyncQueue(expectedQueue?: LocalSyncMutationQueue): boolean {
  try {
    if (
      expectedQueue &&
      JSON.stringify(readLocalSyncQueue()) !== JSON.stringify(expectedQueue)
    ) {
      return false;
    }
    localStorage.removeItem(QUEUE_KEY);
    localStorage.removeItem('savings_sync_eligible_change_v1');
    return true;
  } catch (error) {
    console.error('Không thể xóa hàng đợi thay đổi local:', error);
    return false;
  }
}
