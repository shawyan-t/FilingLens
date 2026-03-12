import { NextRequest } from 'next/server';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { getArtifact } from '@/lib/artifact-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function contentDisposition(filename: string): string {
  const safe = filename.replace(/[\r\n"]/g, '_');
  return `attachment; filename="${safe}"`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } },
) {
  const artifact = await getArtifact(params.token);
  if (!artifact) {
    return new Response(JSON.stringify({ error: 'Download not found or expired' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const requestedFilename = request.nextUrl.searchParams.get('filename');
  const filename = requestedFilename || artifact.filename || 'download.bin';

  if (artifact.blobUrl) {
    const upstream = await fetch(artifact.blobUrl);
    if (!upstream.ok || !upstream.body) {
      return new Response(JSON.stringify({ error: 'Download file unavailable' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('content-type') || artifact.contentType || 'application/octet-stream',
        'Content-Disposition': contentDisposition(filename),
        'Cache-Control': 'no-store',
      },
    });
  }

  try {
    const stream = createReadStream(artifact.filePath);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        'Content-Type': artifact.contentType,
        'Content-Disposition': contentDisposition(filename),
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Download file unavailable' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

}
