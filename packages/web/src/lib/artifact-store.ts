import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { put } from '@vercel/blob';

interface ArtifactRecord {
  filePath: string;
  filename: string;
  contentType: string;
  createdAt: number;
  blobUrl?: string;
}

const DEFAULT_TTL_MS = 1000 * 60 * 60 * 6;
const artifactStore = new Map<string, ArtifactRecord>();
const artifactStateDir = join(tmpdir(), 'dolph-web-artifacts');
const BLOB_TOKEN_PREFIX = 'b_';

async function ensureArtifactStateDir(): Promise<void> {
  await mkdir(artifactStateDir, { recursive: true });
}

function tokenPath(token: string): string {
  return join(artifactStateDir, `${token}.json`);
}

function cleanupExpiredArtifacts(): void {
  const now = Date.now();
  artifactStore.forEach((artifact, token) => {
    if (now - artifact.createdAt > DEFAULT_TTL_MS) {
      artifactStore.delete(token);
    }
  });
}

function inferContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.csv') return 'text/csv; charset=utf-8';
  if (extension === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isBlobEnabled(): boolean {
  return !!process.env['BLOB_READ_WRITE_TOKEN'];
}

function encodeBlobToken(url: string): string {
  return `${BLOB_TOKEN_PREFIX}${Buffer.from(url, 'utf8').toString('base64url')}`;
}

function decodeBlobToken(token: string): string | null {
  if (!token.startsWith(BLOB_TOKEN_PREFIX)) return null;
  const encoded = token.slice(BLOB_TOKEN_PREFIX.length);
  if (!encoded) return null;
  try {
    const url = Buffer.from(encoded, 'base64url').toString('utf8');
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function buildBlobPath(filename: string): string {
  const safeFilename = sanitizeFilename(filename);
  return `dolph-artifacts/${Date.now()}-${randomUUID()}-${safeFilename}`;
}

export async function registerArtifact(filePath: string, filename?: string, contentType?: string): Promise<{ token: string; filename: string; contentType: string }> {
  await access(filePath);
  const resolvedFilename = filename || basename(filePath);
  const resolvedContentType = contentType || inferContentType(filePath);

  if (isBlobEnabled()) {
    const data = await readFile(filePath);
    const blob = await put(buildBlobPath(resolvedFilename), data, {
      access: 'public',
      contentType: resolvedContentType,
    });
    return {
      token: encodeBlobToken(blob.url),
      filename: resolvedFilename,
      contentType: resolvedContentType,
    };
  }

  await ensureArtifactStateDir();
  cleanupExpiredArtifacts();
  const token = randomUUID();
  const record: ArtifactRecord = {
    filePath,
    filename: resolvedFilename,
    contentType: resolvedContentType,
    createdAt: Date.now(),
  };
  artifactStore.set(token, record);
  await writeFile(tokenPath(token), JSON.stringify(record), 'utf8');
  return { token, filename: record.filename, contentType: record.contentType };
}

export async function getArtifact(token: string): Promise<ArtifactRecord | null> {
  const blobUrl = decodeBlobToken(token);
  if (blobUrl) {
    return {
      filePath: '',
      filename: '',
      contentType: '',
      createdAt: Date.now(),
      blobUrl,
    };
  }

  cleanupExpiredArtifacts();
  const inMemory = artifactStore.get(token);
  if (inMemory) return inMemory;
  try {
    const raw = await readFile(tokenPath(token), 'utf8');
    const artifact = JSON.parse(raw) as ArtifactRecord;
    artifactStore.set(token, artifact);
    return artifact;
  } catch {
    return null;
  }
}

export async function readArtifactUtf8(token: string): Promise<string | null> {
  const artifact = await getArtifact(token);
  if (!artifact) return null;
  if (artifact.blobUrl) {
    const response = await fetch(artifact.blobUrl);
    if (!response.ok) return null;
    return response.text();
  }
  return readFile(artifact.filePath, 'utf8');
}

export async function openArtifactStream(token: string): Promise<{ stream: ReturnType<typeof createReadStream>; artifact: ArtifactRecord } | null> {
  const artifact = await getArtifact(token);
  if (!artifact) return null;
  if (artifact.blobUrl) return null;
  return {
    stream: createReadStream(artifact.filePath),
    artifact,
  };
}
