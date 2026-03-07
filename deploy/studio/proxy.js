const http = require('http');

/**
 * SupaCloud Local Proxy
 * Special proxy to redirect hardcoded localhost:8000 requests (Auth/GoTrue) 
 * to the actual production API.
 */

const PORT = 8000;
const API_URL = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';

const server = http.createServer((req, res) => {
  // Always forward /auth/ and /rest/ requests to the main domain
  let path = req.url;
  
  // Studio sometimes uses /rest/v1/ and sometimes just /rest/
  // We ensure it maps to the correct backend format
  const targetUrl = new URL(req.url, API_URL);
  
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

  const proxyReq = (targetUrl.protocol === 'https:' ? require('https') : http).request(options, (proxyRes) => {
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
