import { Buffer } from 'node:buffer';
import serverModule from '../../server.js';

const { importPdfBuffer } = serverModule;
const MAX_UPLOAD_BYTES = 5.8 * 1024 * 1024;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  try {
    const form = await request.formData();
    const file = form.get('file');

    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ error: 'No PDF uploaded.' }, 400);
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: 'PDF is too large for Netlify upload. Use a PDF under 5.8 MB.' }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    return json(await importPdfBuffer(buffer));
  } catch (err) {
    console.error('[pdf-import function] fatal error:', err);
    return json({ error: err.message || 'Failed to process PDF.' }, err.statusCode || 500);
  }
};

export const config = {
  path: '/api/pdf-import',
};
