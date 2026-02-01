const SW_VERSION = '1.0.3';
console.log(`[SW] Service Worker version ${SW_VERSION} initializing`);

self.skipWaiting();

// Log service worker lifecycle events
self.addEventListener('install', (event) => {
  console.log(`[SW v${SW_VERSION}] Installing...`);
});

self.addEventListener('activate', (event) => {
  console.log(`[SW v${SW_VERSION}] Activated and ready to intercept requests`);
  event.waitUntil(
    (async () => {
      // Claim all clients immediately
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window' });
      console.log(`[SW v${SW_VERSION}] Now controlling ${clients.length} client(s)`);
    })()
  );
});

const GEMINI_CACHE_NAME = 'gemini-proxy-cache-v1';

// Helper to hash the request body for caching POST requests
async function getBodyHash(request) {
  const clone = request.clone();
  const text = await clone.text();
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper to get the backend URL based on the current hostname
function getBackendUrl() {
  const hostname = self.location.hostname;
  
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return 'http://localhost:3008';
  } else if (hostname === 'lms.mexty.ai') {
    return 'https://brain.mexty.ai';
  } else if (hostname === 'workspace.mexty.ai') {
    return 'https://api.mexty.ai';
  }
  
  // Default fallback
  return 'https://brain.mexty.ai';
}

// Helper to check if a URL is for a static asset
function isStaticAssetUrl(url) {
  const staticExtensions = [
    '.woff', '.woff2', '.ttf', '.otf', '.eot', // Fonts
    '.css', // Stylesheets
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', // Images
    '.js', '.mjs', // JavaScript
    '.html', '.htm', // HTML
    '.json', // JSON (for static data)
    '.xml', // XML
    '.pdf', // PDF
    '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.wma', // Audio
    '.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v', // Video
  ];
  
  try {
    const urlObj = new URL(url);
    // Get the pathname without query parameters or hash
    const pathname = urlObj.pathname.toLowerCase();
    // Check if the pathname ends with any of the static extensions
    return staticExtensions.some(ext => pathname.endsWith(ext));
  } catch {
    // If URL parsing fails, fall back to simple check
    const lowerUrl = url.toLowerCase();
    return staticExtensions.some(ext => lowerUrl.endsWith(ext));
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Intercept direct calls to Google APIs and proxy them
  if (url.hostname.endsWith('googleapis.com')) {
    const isStatic = isStaticAssetUrl(url.href);
    console.log(`[SW v${SW_VERSION}] googleapis.com request:`, {
      url: url.href,
      pathname: url.pathname,
      isStatic,
      method: event.request.method
    });
    
    // Check if this is a static asset (audio, images, fonts, etc.)
    if (isStatic) {
      // For static assets, fetch directly from Google - no proxy needed
      console.log('[SW] Static asset detected, fetching directly:', url.href);
      return; // Let the browser fetch it normally
    }
    
    // For API calls, proxy through our backend
    event.respondWith(
      (async () => {
        try {
          // Get the base URL of our app (handles different environments)
          const baseUrl = getBackendUrl();
          const proxyUrl = `${baseUrl}/api/ai/gemini/proxy/${encodeURIComponent(url.href)}`;

          console.log('[SW] Proxying API call to:', proxyUrl);

          // Clone original request to forward everything as-is
          const newRequest = new Request(proxyUrl, {
            method: event.request.method,
            headers: event.request.headers,
            body:
              event.request.method !== 'GET' &&
              event.request.method !== 'HEAD'
                ? await event.request.clone().arrayBuffer()
                : undefined,
            credentials: 'include',
          });

          const response = await fetch(newRequest);
          console.log('[SW] Proxy response status:', response.status);
          return response;
        } catch (error) {
          console.error('[SW] Proxy error:', error);
          throw error;
        }
      })()
    );
  }
  
  // Handle caching for proxied requests
  if (url.pathname.includes('/api/ai/gemini/proxy/')) {
    // If X-No-Cache is set, bypass the Service Worker completely and let the browser handle the network request
    if (event.request.headers.get('X-No-Cache') === 'true') {
      return;
    }
    event.respondWith(handleGeminiRequest(event));
  }
});

async function handleGeminiRequest(event) {
  const request = event.request;
  
  // Check for X-No-Cache header to skip caching
  if (request.headers.get('X-No-Cache') === 'true') {
    return fetchWithRetry(request.clone());
  }
  
  // Only cache POST requests (Gemini usually uses POST)
  if (request.method !== 'POST') {
    return fetchWithRetry(request.clone());
  }

  try {
    const hash = await getBodyHash(request);
    // Create a fake URL for the cache key that includes the body hash
    const cacheUrl = new URL(request.url);
    cacheUrl.searchParams.set('bodyHash', hash);
    const cacheKey = cacheUrl.toString();

    const cache = await caches.open(GEMINI_CACHE_NAME);
    const cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      // Add a header to indicate it was cached
      const newHeaders = new Headers(cachedResponse.headers);
      newHeaders.set('X-Cache', 'HIT');
      
      return new Response(cachedResponse.body, {
        status: cachedResponse.status,
        statusText: cachedResponse.statusText,
        headers: newHeaders
      });
    }

    // Network request with retry
    const response = await fetchWithRetry(request.clone());

    // Cache the successful response
    if (response.ok) {
      const responseClone = response.clone();
      await cache.put(cacheKey, responseClone);
    }

    return response;
  } catch (error) {
    console.error('Gemini Proxy SW Error:', error);
    // If offline and no cache, we might want to return a fallback or just throw
    throw error;
  }
}

async function fetchWithRetry(request, retries = 3) {
  try {
    const response = await fetch(request);
    // Retry on 5xx errors or network failures (fetch throws on network failure)
    if (!response.ok && response.status >= 500 && retries > 0) {
       return fetchWithRetry(request.clone(), retries - 1);
    }
    return response;
  } catch (err) {
    if (retries > 0) {
      return fetchWithRetry(request.clone(), retries - 1);
    }
    throw err;
  }
}
