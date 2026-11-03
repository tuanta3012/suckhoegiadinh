import { SavingsBook } from '../types';
import { buildSavingsBookBusinessId } from './dataTranslator';
import { LocalSyncMutationQueue } from './localSyncQueue';

export interface QueuedBookMergeResult {
  books: SavingsBook[];
  conflict?: string;
}

function comparableBook(book: SavingsBook): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(book).filter(([key]) => key !== 'id').sort(([a], [b]) => a.localeCompare(b)))
  );
}

function findBookIndex(books: SavingsBook[], target: SavingsBook): number {
  const byId = books.findIndex((book) => book.id === target.id);
  if (byId >= 0) return byId;
  const targetBusinessId = buildSavingsBookBusinessId(target);
  return books.findIndex((book) => buildSavingsBookBusinessId(book) === targetBusinessId);
}

export function mergeQueuedBooks(
  remoteBooks: SavingsBook[],
  queue: LocalSyncMutationQueue
): QueuedBookMergeResult {
  const settledCodes = new Set(
    queue.settledBookCodes.map((code) => code.replace(/\s+/g, '').toUpperCase())
  );
  const books = remoteBooks.filter(
    (book) => !settledCodes.has((book.bookCode || '').replace(/\s+/g, '').toUpperCase())
  );

  for (const deletedBook of queue.deletedBooks) {
    const index = findBookIndex(books, deletedBook);
    if (index < 0) continue;
    if (comparableBook(books[index]) !== comparableBook(deletedBook)) {
      return {
        books,
        conflict: `Sổ ${deletedBook.bookCode || deletedBook.id} đã thay đổi trên Drive sau khi xóa ở thiết bị này.`,
      };
    }
    books.splice(index, 1);
  }

  for (const update of queue.updatedBooks) {
    let index = books.findIndex((book) => book.id === update.book.id);
    if (index < 0) index = findBookIndex(books, update.baseBook);
    if (index < 0) {
      return {
        books,
        conflict: `Không tìm thấy sổ ${update.book.bookCode || update.book.id} trên Drive để áp dụng chỉnh sửa.`,
      };
    }

    const remoteBook = books[index];
    if (
      comparableBook(remoteBook) !== comparableBook(update.baseBook) &&
      comparableBook(remoteBook) !== comparableBook(update.book)
    ) {
      return {
        books,
        conflict: `Sổ ${update.book.bookCode || update.book.id} đã được thay đổi trên Drive. Hãy tải lại và kiểm tra trước khi ghi.`,
      };
    }
    books[index] = update.book;
  }

  for (const newBook of queue.newBooks) {
    const index = findBookIndex(books, newBook);
    if (index >= 0) {
      if (comparableBook(books[index]) !== comparableBook(newBook)) {
        return {
          books,
          conflict: `Sổ ${newBook.bookCode || newBook.id} trùng khóa nhưng khác nội dung. Đã dừng ghi để tránh ghi đè.`,
        };
      }
      continue;
    }
    books.push(newBook);
  }

  return { books };
}
