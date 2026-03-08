const http = require('http');

/**
 * SupaCloud Local Proxy
 * Special proxy to redirect hardcoded localhost:8000 requests (Auth/GoTrue/API) 
 * to the actual production API. 
 * 
 * IMPORTANT: Read target from RUNTIME environment variables, not build-time.
 */

const PORT = 8000;
// Use a specific internal env var for the real backend to avoid confusion with the build-time one
const TARGET_API = process.env.SUPA_BACKEND_URL || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

const server = http.createServer((req, res) => {
  // Always forward /auth/ and /rest/ requests to the main domain
  // We use the Host header from the request to stay dynamic
  const targetUrl = new URL(req.url, TARGET_API);
  
  console.log(`[Proxy] ${req.method} ${req.url} -> ${targetUrl.href}`);

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: {
      ...req.headers,
      host: targetUrl.host,
    }
  };

  const protocolHandler = targetUrl.protocol === 'https:' ? require('https') : require('http');
  const proxyReq = protocolHandler.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy Error] ${err.message}`);
    res.writeHead(502);
    res.end(`Proxy Error: ${err.message}`);
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Proxy] Listening on 0.0.0.0:${PORT}`);
  console.log(`[Proxy] Forwarding to ${API_URL}`);
});
