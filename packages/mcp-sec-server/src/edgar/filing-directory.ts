import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix as posixPath } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { edgarFetch } from './client.js';
import { RateLimiter } from '../utils/rate-limiter.js';
import { fileCache } from '../cache/file-cache.js';

export interface FilingDirectoryEntry {
  name: string;
  relativePath: string;
  url: string;
  isDirectory: boolean;
}

export interface FilingPreviewFile {
  name: string;
  relativePath: string;
  url: string;
}

export interface FilingFilePreview {
  name: string;
  relativePath: string;
  content: string;
  truncated: boolean;
}

export interface FilingBundleResult {
  zipPath: string;
  filename: string;
}

export interface FilingBundleParams {
  accessionNumber: string;
  documentUrl: string;
  companyName?: string;
  filingType?: string;
  dateFiled?: string;
}

interface DirectoryItem {
  name: string;
  isDirectory: boolean;
}

const CACHE_VERSION = 2;
const BUNDLE_CACHE_VERSION = 2;
const DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_LIST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PREVIEW_CONTENT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const BUNDLE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DIRECTORY_TIMEOUT_MS = 120_000;
const PREVIEW_TIMEOUT_MS = 90_000;
const ASSET_TIMEOUT_MS = 90_000;
const ARCHIVE_REQUESTS_PER_SECOND = 2;
const archiveRateLimiter = new RateLimiter(ARCHIVE_REQUESTS_PER_SECOND);

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

function resolveCacheDir(): string {
  const dir = process.env['DOLPH_CACHE_DIR'] || '~/.dolph/cache';
  return dir.replace(/^~/, homedir());
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function getBundleCachePath(params: FilingBundleParams): string {
  const baseDir = join(resolveCacheDir(), 'filing_bundles');
  const cacheKey = hashKey(JSON.stringify({
    v: BUNDLE_CACHE_VERSION,
    accessionNumber: params.accessionNumber,
    documentUrl: params.documentUrl,
    companyName: params.companyName || '',
    filingType: params.filingType || '',
    dateFiled: params.dateFiled || '',
  }));
  return join(baseDir, `${cacheKey}.zip`);
}

function getBundleFilename(params: FilingBundleParams): string {
  const company = sanitizePart(params.companyName || 'filing');
  const filingType = sanitizePart(params.filingType || 'filing');
  const date = sanitizePart(params.dateFiled || 'undated');
  return `${company}-${filingType}-${date}-${params.accessionNumber}.zip`;
}

async function getFreshBundleCachePath(params: FilingBundleParams): Promise<string | null> {
  const path = getBundleCachePath(params);
  try {
    const info = await stat(path);
    const age = Date.now() - info.mtimeMs;
    return age <= BUNDLE_CACHE_TTL_MS ? path : null;
  } catch {
    return null;
  }
}

function resolveBaseDirectory(urlStr: string): string {
  const parsed = new URL(urlStr);
  const pathname = parsed.pathname.endsWith('/')
    ? parsed.pathname
    : parsed.pathname.replace(/\/[^/]*$/, '/');
  return `${parsed.origin}${pathname}`;
}

function normalizeRelativePath(relativePath: string): string {
  const normalized = posixPath.normalize(relativePath).replace(/^\/+/, '');
  if (!normalized || normalized === '.') {
    return '';
  }
  if (normalized.startsWith('..')) {
    throw new Error(`Unsafe filing path: ${relativePath}`);
  }
  return normalized;
}

function decodeHrefName(href: string): string {
  const trimmed = href.replace(/^\.\//, '');
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function toDirectoryRelativePath(href: string, baseDirPath: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('#') || trimmed.startsWith('?')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;

  if (trimmed.startsWith('/')) {
    if (!trimmed.startsWith(baseDirPath)) return null;
    const relative = trimmed.slice(baseDirPath.length);
    const normalized = normalizeRelativePath(decodeHrefName(relative));
    return normalized || null;
  }

  const normalized = normalizeRelativePath(decodeHrefName(trimmed));
  if (!normalized || normalized.includes('?') || normalized.includes('#')) return null;
  return normalized;
}

function looksLikeDirectoryName(name: string): boolean {
  if (!name) return false;
  if (name.endsWith('/')) return true;
  return !name.includes('.');
}

function parseDirectoryListingHtml(html: string, baseDirPath: string): DirectoryItem[] {
  const items: DirectoryItem[] = [];
  const seen = new Set<string>();
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const rowHtml = rowMatch[1] || '';
    const anchorMatch = /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/i.exec(rowHtml);
    if (!anchorMatch) continue;

    const href = anchorMatch[1] || '';
    const label = (anchorMatch[2] || '').replace(/<[^>]+>/g, '').trim();
    const relativePath = toDirectoryRelativePath(href, baseDirPath);
    if (!relativePath) continue;
    if (label.toLowerCase().includes('parent directory')) continue;

    const name = relativePath.split('/').pop() || relativePath;
    if (!name || name === '.' || name === '..' || name === 'index.json') continue;
    if (seen.has(name)) continue;
    seen.add(name);

    items.push({
      name,
      isDirectory: looksLikeDirectoryName(name),
    });
  }

  return items;
}

function isPreviewableFile(name: string): boolean {
  const lower = name.toLowerCase();
  const previewable = ['.htm', '.html', '.txt', '.xml', '.xsd', '.json', '.css', '.js'];
  const blocked = ['.zip', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.xlsx', '.xls', '.pdf'];
  if (blocked.some((ext) => lower.endsWith(ext))) return false;
  return previewable.some((ext) => lower.endsWith(ext));
}

function runZip(directory: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/zip', ['-rq', outputPath, '.'], { cwd: directory });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || `zip exited with status ${code}`));
      }
    });
  });
}

async function archiveFetch(url: string, options: Parameters<typeof edgarFetch>[1] = {}): Promise<Response> {
  await archiveRateLimiter.acquire();
  return edgarFetch(url, options);
}

async function getDirectoryItems(baseDirUrl: string, safeRelativePath: string): Promise<DirectoryItem[]> {
  const directoryUrl = new URL(safeRelativePath ? `${safeRelativePath}/` : '', baseDirUrl).toString();
  const cacheKey = JSON.stringify({ v: CACHE_VERSION, directoryUrl });
  const cached = await fileCache.get<DirectoryItem[]>('filing_directory', cacheKey, DIRECTORY_CACHE_TTL_MS);
  if (cached) {
    return cached;
  }

  const response = await archiveFetch(directoryUrl, { timeoutMs: DIRECTORY_TIMEOUT_MS, maxRetries: 3 });
  if (!response.ok) {
    throw new Error(`Failed to fetch SEC filing directory: ${directoryUrl} (${response.status} ${response.statusText})`);
  }
  const html = await response.text();
  const directoryPath = new URL(directoryUrl).pathname;
  const parsed = parseDirectoryListingHtml(html, directoryPath);
  await fileCache.set('filing_directory', cacheKey, parsed);
  return parsed;
}

async function writeRemoteFile(
  baseDirUrl: string,
  relativePath: string,
  targetRoot: string,
): Promise<boolean> {
  const safeRelativePath = normalizeRelativePath(relativePath);
  const remoteUrl = new URL(safeRelativePath, baseDirUrl).toString();
  const transientStatuses = new Set([429, 500, 502, 503, 504]);
  let response: Response | null = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      response = await archiveFetch(remoteUrl, { maxRetries: 2, timeoutMs: ASSET_TIMEOUT_MS });
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes('timed out');
      if (!isTimeout || attempt === 4) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      continue;
    }

    if (response.ok) {
      break;
    }

    if (response.status === 404) {
      return false;
    }

    if (!transientStatuses.has(response.status)) {
      throw new Error(`Failed to fetch SEC filing asset: ${remoteUrl} (${response.status} ${response.statusText})`);
    }

    if (attempt === 4) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
  }

  if (!response || !response.ok) {
    return false;
  }

  const destination = join(targetRoot, safeRelativePath);
  await mkdir(dirname(destination), { recursive: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, bytes);
  return true;
}

async function downloadDirectoryRecursive(
  baseDirUrl: string,
  directoryRelativePath: string,
  targetRoot: string,
  seenFiles: Set<string>,
): Promise<number> {
  const safeRelativePath = normalizeRelativePath(directoryRelativePath);
  const items = await getDirectoryItems(baseDirUrl, safeRelativePath);
  let downloaded = 0;

  for (const item of items) {
    const itemName = item.name || '';
    if (!itemName || itemName === 'index.json') continue;

    const nextRelativePath = normalizeRelativePath(
      safeRelativePath ? `${safeRelativePath}/${itemName}` : itemName,
    );

    if (item.isDirectory) {
      downloaded += await downloadDirectoryRecursive(baseDirUrl, nextRelativePath, targetRoot, seenFiles);
      continue;
    }

    if (seenFiles.has(nextRelativePath)) continue;
    seenFiles.add(nextRelativePath);
    if (await writeRemoteFile(baseDirUrl, nextRelativePath, targetRoot)) {
      downloaded += 1;
    }
  }

  return downloaded;
}

export async function listFilingDirectoryFiles(documentUrl: string): Promise<FilingDirectoryEntry[]> {
  const baseDirUrl = resolveBaseDirectory(documentUrl);
  const items = await getDirectoryItems(baseDirUrl, '');
  return items
    .filter((item) => item.name && item.name !== 'index.json' && !item.isDirectory)
    .map((item) => {
      const relativePath = normalizeRelativePath(item.name);
      return {
        name: item.name,
        relativePath,
        url: new URL(relativePath, baseDirUrl).toString(),
        isDirectory: false,
      };
    });
}

export async function listPreviewableFilingFiles(documentUrl: string): Promise<FilingPreviewFile[]> {
  const cacheKey = JSON.stringify({ v: CACHE_VERSION, documentUrl });
  const cached = await fileCache.get<FilingPreviewFile[]>('filing_preview_files', cacheKey, PREVIEW_LIST_CACHE_TTL_MS);
  if (cached) {
    return cached;
  }

  const files = await listFilingDirectoryFiles(documentUrl);
  const previewable = files
    .filter((file) => isPreviewableFile(file.name))
    .map((file) => ({
      name: file.name,
      relativePath: file.relativePath,
      url: file.url,
    }));
  await fileCache.set('filing_preview_files', cacheKey, previewable);
  return previewable;
}

export async function previewFilingFile(
  documentUrl: string,
  relativePath: string,
  maxChars = 12000,
): Promise<FilingFilePreview> {
  const baseDirUrl = resolveBaseDirectory(documentUrl);
  const safeRelativePath = normalizeRelativePath(relativePath);
  const remoteUrl = new URL(safeRelativePath, baseDirUrl).toString();
  const cacheKey = JSON.stringify({ v: CACHE_VERSION, documentUrl, relativePath: safeRelativePath, maxChars });
  const cached = await fileCache.get<FilingFilePreview>('filing_preview_content', cacheKey, PREVIEW_CONTENT_CACHE_TTL_MS);
  if (cached) {
    return cached;
  }

  const response = await archiveFetch(remoteUrl, { timeoutMs: PREVIEW_TIMEOUT_MS, maxRetries: 3 });

  if (!response.ok) {
    throw new Error(`Failed to fetch preview file: ${remoteUrl} (${response.status} ${response.statusText})`);
  }

  const content = await response.text();
  const truncated = content.length > maxChars;
  const preview = {
    name: posixPath.basename(safeRelativePath),
    relativePath: safeRelativePath,
    content: truncated ? content.slice(0, maxChars) : content,
    truncated,
  };
  await fileCache.set('filing_preview_content', cacheKey, preview);
  return preview;
}

export async function buildFilingBundleZip(params: FilingBundleParams): Promise<FilingBundleResult> {
  const cachedBundlePath = await getFreshBundleCachePath(params);
  if (cachedBundlePath) {
    return {
      zipPath: cachedBundlePath,
      filename: getBundleFilename(params),
    };
  }

  const workingDir = await mkdtemp(join(tmpdir(), 'dolph-filing-bundle-'));
  const filesDir = join(workingDir, 'files');
  await mkdir(filesDir, { recursive: true });

  try {
    const baseDirUrl = resolveBaseDirectory(params.documentUrl);
    const seenFiles = new Set<string>();
    const downloadedCount = await downloadDirectoryRecursive(baseDirUrl, '', filesDir, seenFiles);

    if (downloadedCount === 0) {
      throw new Error(`No filing assets were available for ${params.accessionNumber}`);
    }

    const outDir = join(resolveCacheDir(), 'filing_bundles');
    await mkdir(outDir, { recursive: true });

    const filename = getBundleFilename(params);
    const zipPath = getBundleCachePath(params);

    await rm(zipPath, { force: true }).catch(() => undefined);
    await runZip(filesDir, zipPath);

    return { zipPath, filename };
  } finally {
    await rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function saveFilingBundleZip(
  params: FilingBundleParams,
  outputDir: string,
): Promise<FilingBundleResult> {
  const bundle = await buildFilingBundleZip(params);
  await mkdir(outputDir, { recursive: true });
  const finalPath = join(outputDir, bundle.filename);
  await copyFile(bundle.zipPath, finalPath);
  return { zipPath: finalPath, filename: bundle.filename };
}
