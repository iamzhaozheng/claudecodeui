import { createHash, randomUUID } from 'node:crypto';
import fsSync, { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';

import { getGlobalImageAssetsDir, toPosixPath } from '@/shared/index.js';
import type { ChatAttachmentDescriptor } from '@/shared/index.js';

/**
 * Image mime types accepted for chat attachment uploads. SVG is allowed for
 * storage/preview even though some providers (Claude API) skip it at send time.
 */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const PREVIEW_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MAX_PREVIEW_BYTES = 25 * 1024 * 1024;
const previewSources = new Map<string, string>();
const previewCopies = new Map<string, Promise<boolean>>();

/**
 * Used by the native and persisted Codex history adapters to preview images
 * already attached to a trusted local conversation. Registers an opaque asset
 * filename, never a browser-supplied filesystem path. The assets service copies
 * a regular raster image into its store on first access so temporary clipboard
 * files remain viewable later. Unsupported paths return null.
 */
export function registerLocalImagePreview(sourcePath: string): ChatAttachmentDescriptor | null {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return null;
  const resolvedSource = path.resolve(sourcePath);
  const extension = path.extname(resolvedSource).toLowerCase();
  if (!PREVIEW_IMAGE_EXTENSIONS.has(extension)) return null;
  const name = path.basename(resolvedSource);
  if (path.dirname(resolvedSource) === path.resolve(getGlobalImageAssetsDir())) {
    return { path: toPosixPath(resolvedSource), name };
  }
  const filename = 'codex-preview-' + createHash('sha256').update(resolvedSource).digest('hex') + extension;
  previewSources.delete(filename);
  previewSources.set(filename, resolvedSource);
  if (previewSources.size > 2048) previewSources.delete(previewSources.keys().next().value!);
  return { path: toPosixPath(path.join(getGlobalImageAssetsDir(), filename)), name };
}

async function copyRegisteredPreview(filename: string, destination: string): Promise<boolean> {
  const source = previewSources.get(filename);
  if (!source) return false;
  let temporaryFile: string | undefined;
  try {
    const file = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0 || info.size > MAX_PREVIEW_BYTES) return false;
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) return false;
        offset += bytesRead;
      }
      await ensureImageAssetsDir();
      temporaryFile = destination + '.' + randomUUID() + '.tmp';
      await fs.writeFile(temporaryFile, bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporaryFile, destination);
      return true;
    } finally {
      await file.close();
    }
  } catch {
    return false;
  } finally {
    if (temporaryFile) await fs.rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}

// Used only by this service and the assets routes via the barrel file.
type StoredImageAsset = {
  /** Original upload filename, for display. */
  name: string;
  /** Absolute posix-normalized path inside the global assets folder. */
  path: string;
  size: number;
  mimeType: string;
};

// Shape of one multer-stored file; kept local because only this module reads it.
type UploadedImageFile = {
  originalname: string;
  filename: string;
  size: number;
  mimetype: string;
};

type UploadedAttachmentFile = UploadedImageFile;

/** Returns whether one uploaded mime type may be stored as a chat image asset. */
export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/** Creates the global `~/.cloudcli/assets` folder if needed and returns it. */
export async function ensureImageAssetsDir(): Promise<string> {
  const assetsDir = getGlobalImageAssetsDir();
  await fs.mkdir(assetsDir, { recursive: true });
  return assetsDir;
}

/**
 * Maps multer-stored upload files to the attachment records returned to the
 * chat composer. The absolute path is what providers receive and what session
 * history carries back to the UI.
 */
export function buildStoredImageRecords(files: UploadedImageFile[]): StoredImageAsset[] {
  const assetsDir = getGlobalImageAssetsDir();
  return files.map((file) => ({
    name: file.originalname,
    path: toPosixPath(path.join(assetsDir, file.filename)),
    size: file.size,
    mimeType: file.mimetype,
  }));
}

/**
 * Maps multer-stored files to provider-neutral attachment records for the
 * assets route. The shared storage format intentionally matches image records
 * so one uploaded file can move through queueing and provider dispatch.
 */
export function buildStoredAttachmentRecords(files: UploadedAttachmentFile[]): StoredImageAsset[] {
  return buildStoredImageRecords(files);
}

/**
 * Resolves one asset filename to its absolute path inside the global assets
 * folder, or null when the name is empty, contains path separators/traversal,
 * or would escape the folder. This is the only lookup the serving route uses,
 * so the caller cannot select a file outside `~/.cloudcli/assets`.
 */
export function resolveImageAssetFile(filename: string): string | null {
  const trimmed = typeof filename === 'string' ? filename.trim() : '';
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return null;
  }

  const assetsDir = path.resolve(getGlobalImageAssetsDir());
  const resolved = path.resolve(assetsDir, trimmed);
  if (!resolved.startsWith(assetsDir + path.sep)) {
    return null;
  }

  return resolved;
}

/**
 * Resolves a general chat attachment for the assets serving route. It shares
 * the image resolver's strict direct-child containment boundary.
 */
export function resolveAttachmentAssetFile(filename: string): string | null {
  return resolveImageAssetFile(filename);
}

/**
 * Used by the assets routes to open a direct-child asset. Missing registered
 * provider previews are copied from their trusted attachment source first;
 * callers cannot register or request arbitrary source paths through the route.
 */
export async function openStoredAttachmentAsset(filename: string) {
  const resolved = resolveAttachmentAssetFile(filename);
  if (!resolved) {
    return { status: 'invalid' as const };
  }

  try {
    await fs.access(resolved);
  } catch {
    let copying = previewCopies.get(filename);
    if (!copying) {
      copying = copyRegisteredPreview(filename, resolved);
      previewCopies.set(filename, copying);
    }
    const copied = await copying;
    if (previewCopies.get(filename) === copying) previewCopies.delete(filename);
    if (!copied) return { status: 'missing' as const };
  }

  return {
    status: 'found' as const,
    contentType: mime.lookup(resolved) || 'application/octet-stream',
    stream: fsSync.createReadStream(resolved),
  };
}
