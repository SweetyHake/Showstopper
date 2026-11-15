// Memoized "is animated WebP" verdicts keyed by URL: a full fetch + scan on
// every intro playback (one per connected client) caused hundreds of ms of
// freeze, while actor portraits rarely change between plays.
const _animatedWebPCache = new Map();
const ANIMATED_CACHE_MAX = 256;

export async function checkIfAnimatedWebP(src) {
  if (!src || !src.toLowerCase().endsWith('.webp')) return false;

  const cached = _animatedWebPCache.get(src);
  if (cached !== undefined) return cached;

  let verdict = false;
  try {
    const response = await fetch(src);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Read a 4-byte FourCC tag without allocating subarray slices on every step
    const tag = (i) => String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);

    const riffHeader = tag(0);
    const webpHeader = tag(8);
    if (riffHeader === 'RIFF' && webpHeader === 'WEBP') {
      // RIFF is a chunked format: [4-byte id][4-byte LE size][payload].
      // Walk chunk by chunk rather than byte by byte: almost all of a WebP file
      // is a single VP8/VP8L/ALPH payload, while animation headers (ANIM/ANMF)
      // appear in the very first chunks before image data — typically within ~4 KB.
      let i = 12;
      while (i + 8 <= bytes.length) {
        const id = tag(i);
        if (id === 'ANIM' || id === 'ANMF') { verdict = true; break; }
        if (id === 'VP8 ' || id === 'VP8L') break; // Frame bitstream reached — static WebP
        const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
        if (size <= 0) break; // Malformed chunk length — avoid infinite loops
        i += 8 + size + (size & 1); // Chunks are padded to 2-byte alignment
      }
    }
  } catch (e) {
    verdict = false;
  }

  if (_animatedWebPCache.size >= ANIMATED_CACHE_MAX) {
    const oldest = _animatedWebPCache.keys().next().value;
    _animatedWebPCache.delete(oldest);
  }
  _animatedWebPCache.set(src, verdict);
  return verdict;
}

export async function isAnimatedImage(src) {
  if (!src) return false;
  
  const lowerSrc = src.toLowerCase();
  
  if (lowerSrc.endsWith('.gif')) {
    return true;
  }
  
  if (lowerSrc.endsWith('.webp')) {
    return await checkIfAnimatedWebP(src);
  }
  
  return false;
}

export async function resizeImageTo1024(src, options: any = {}) {
  if (!src || typeof Image === 'undefined') return src;

  // Callers passing a precomputed verdict skip a second fetch + scan;
  // otherwise isAnimatedImage hits the checkIfAnimatedWebP memo cache
  const isAnimated = options.isAnimated ?? await isAnimatedImage(src);
  if (isAnimated) {
    return src;
  }
  
  const targetSize = options.targetSize || 1024;
  
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      
      if (w <= targetSize && h <= targetSize) {
        resolve(src);
        return;
      }
      
      const scale = Math.max(targetSize / w, targetSize / h);
      const sw = targetSize / scale;
      const sh = targetSize / scale;
      const sx = (w - sw) / 2;
      const sy = 0;
      
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetSize, targetSize);
      
      try {
        resolve(canvas.toDataURL('image/webp', 0.9));
      } catch (e) {
        resolve(src);
      }
    };
    
    img.onerror = () => resolve(src);
    img.src = src;
  });
}