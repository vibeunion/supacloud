import fs from 'fs';

let content = fs.readFileSync('packages/management-api/src/routes/storage-compat.ts', 'utf8');

content = content.replace(
  'import { StorageService } from "../services/storage.service";',
  'import { StorageService } from "../services/storage.service";\nimport { StorageRLS } from "../services/storage-rls";'
);

// 1. Upload POST
content = content.replace(
  'const contentType = headers[\'content-type\'] || \'application/octet-stream\';',
  `const contentType = headers['content-type'] || 'application/octet-stream';

        try {
            const body = await request.arrayBuffer();
            
            // RLS Evaluation
            const auth = headers['authorization'];
            const metadata = { mimetype: contentType, size: body.byteLength };
            const permitted = await StorageRLS.authorizeAction(ref, auth, 'upload', params.bucket, filePath, metadata);
            if (!permitted) return status(403, { statusCode: '403', error: 'Forbidden', message: 'Row Level Security violation or bucket missing' });

            const success = await StorageService.uploadFile(ref, bucket, key, Buffer.from(body), contentType);`
);
// Drop the original body read since we moved it up
content = content.replace(
  /try {\s*const body = await request\.arrayBuffer\(\);\s*const success = await StorageService\.uploadFile.*?\n/,
  '' // This removes the old try/body/upload section which we just prepended above
);

// Oh wait, my regex might fail. Let's do it safer.
