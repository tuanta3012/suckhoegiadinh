import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type DocumentScanMode = 'single' | 'multi';

export interface ScannedPageOutput {
  path?: string;
  webPath?: string;
  format?: string;
}

export interface ScannedPdfOutput {
  path?: string;
  webPath?: string;
  pageCount?: number;
}

export interface DocumentScanResult {
  mode?: DocumentScanMode;
  pages?: ScannedPageOutput[];
  pdf?: ScannedPdfOutput;
}

export interface DocumentScanOptions {
  mode: DocumentScanMode;
  pageLimit?: number;
  allowGalleryImport?: boolean;
}

export interface DocumentScannerPlugin {
  scan(options: DocumentScanOptions): Promise<DocumentScanResult>;
  addListener(
    eventName: 'scanRestored',
    listenerFunc: (result: DocumentScanResult) => void,
  ): Promise<PluginListenerHandle>;
}

export const DocumentScanner = registerPlugin<DocumentScannerPlugin>('DocumentScanner');

export function isMlKitScannerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /MLKIT_UNAVAILABLE|UNIMPLEMENTED|not implemented|DocumentScanner/i.test(message);
}

export function isMlKitScannerCancelledError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /cancel|cancelled|canceled/i.test(message);
}
