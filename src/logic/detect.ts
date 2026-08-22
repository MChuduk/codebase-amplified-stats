import { EXTENSIONS, FILENAMES } from './languages.generated';

/** Extension including the leading dot, lower-cased. Empty when the file has none. */
export function extensionOf(path: string): string {
  const name = filenameOf(path);
  const dot = name.lastIndexOf('.');
  // A leading dot means a dotfile (.gitignore), not an extension.
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

export function filenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Null for anything Linguist does not recognise. */
export function detectLanguage(path: string): string | null {
  const byFilename = FILENAMES[filenameOf(path)];
  if (byFilename) return byFilename;

  const extension = extensionOf(path);
  if (!extension) return null;

  return EXTENSIONS[extension] ?? null;
}
