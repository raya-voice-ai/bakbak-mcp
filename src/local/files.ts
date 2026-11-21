/**
 * Where local mode writes audio: the output directory, generated file names,
 * and validation of a caller-chosen `output_path`.
 */

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { DeliveryError } from '../delivery.js';
import { randomAlphanumeric } from '../util.js';

/** Raised when a path is unusable; the message tells the caller how to fix it. */
export class OutputPathError extends DeliveryError {
  override readonly name = 'OutputPathError';
}

/** `~/Documents/Bakbak` when `~/Documents` exists, else `~/Bakbak`. */
export function defaultOutputDir(
  home: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): string {
  const documents = path.join(home, 'Documents');
  return exists(documents) ? path.join(documents, 'Bakbak') : path.join(home, 'Bakbak');
}

/** `BAKBAK_MCP_OUTPUT_DIR` (with a leading `~` expanded), made absolute; else the default. */
export function resolveOutputDir(configured: string | undefined, home: string = homedir()): string {
  const value = configured?.trim();
  if (!value) return defaultOutputDir(home);
  const expanded =
    value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  return path.resolve(expanded);
}

/** Keeps letters, digits and dashes, so a name is safe in any file system. */
function slug(value: string, maxLength: number): string {
  return value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLength)
    .replace(/-$/, '');
}

/** `20261121T143205Z` */
export function compactTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

export interface FileNameParts {
  language: string;
  voiceName: string | undefined;
  voiceId: string;
  extension: string;
  date?: Date;
  random?: string;
}

/** `<language>_<voice name or id>_<UTC timestamp>_<6 random>.<ext>` */
export function buildFileName(parts: FileNameParts): string {
  const language = slug(parts.language, 16) || 'audio';
  const voice = slug(parts.voiceName ?? '', 40) || slug(parts.voiceId, 40) || 'voice';
  const stamp = compactTimestamp(parts.date ?? new Date());
  const random = parts.random ?? randomAlphanumeric(6);
  return `${language}_${voice}_${stamp}_${random}.${parts.extension}`;
}

export interface OutputPathRequest {
  outputDir: string;
  /** The caller's `output_path`: absolute, or relative to `outputDir` (and then inside it). */
  outputPath: string;
  /** Extensions (without the dot) the file may have. */
  extensions: readonly string[];
}

/**
 * Validates a caller-chosen path and returns it absolute. The file must have
 * the right extension and its directory must already exist. A relative path
 * may not leave the output directory.
 */
export async function resolveOutputPath(request: OutputPathRequest): Promise<string> {
  const raw = request.outputPath.trim();
  if (raw === '' || raw.includes('\0')) {
    throw new OutputPathError('output_path must be a file path.');
  }
  const base = path.resolve(request.outputDir);
  const resolved = path.resolve(base, raw);
  if (!path.isAbsolute(raw)) {
    const relative = path.relative(base, resolved);
    const escapes =
      relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (relative === '' || escapes) {
      throw new OutputPathError(
        `A relative output_path must stay inside the output directory ${base}. Use an absolute path to write elsewhere.`,
      );
    }
  }
  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!request.extensions.includes(ext)) {
    const wanted = request.extensions.map((e) => `.${e}`).join(' or ');
    throw new OutputPathError(`output_path must end in ${wanted} for this output_format.`);
  }
  const directory = path.dirname(resolved);
  const info = await stat(directory).catch(() => undefined);
  if (!info?.isDirectory()) {
    throw new OutputPathError(
      `The directory ${directory} does not exist. Create it first or choose another path.`,
    );
  }
  return resolved;
}

/**
 * Writes `data` to `filePath`. Without `overwrite` an existing file (or
 * symlink) is never replaced. With it, the new file is written beside the
 * target and renamed over it, so a reader never sees half a file and a
 * symlink at the target is replaced rather than followed.
 */
export async function writeAudioFile(
  filePath: string,
  data: Uint8Array,
  overwrite: boolean,
): Promise<void> {
  if (!overwrite) {
    try {
      await writeFile(filePath, data, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new OutputPathError(
          `${filePath} already exists. Set overwrite to true to replace it, or choose another path.`,
        );
      }
      throw error;
    }
    return;
  }
  const existing = await stat(filePath).catch(() => undefined);
  if (existing?.isDirectory()) {
    throw new OutputPathError(`${filePath} is a directory.`);
  }
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temp, data, { flag: 'wx' });
    await rename(temp, filePath);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
