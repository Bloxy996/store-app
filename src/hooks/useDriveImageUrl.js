import { useEffect, useState } from 'react';

import { driveGetFileBlob } from '../lib/driveApi.js';


// ---------------------------------------------------------------------------
// Drive image blob cache — module-level so the same image is never fetched
// twice in a session, no matter how many places embed/view it. Object URLs
// are revoked on sign-out / vault switch (see releaseImageUrlCache below).
// This lives only in memory: it is never written to IndexedDB.
// ---------------------------------------------------------------------------
const imageUrlCache = new Map(); // fileId -> objectURL

const imageUrlPromises = new Map(); // fileId -> in-flight Promise<objectURL>


function releaseImageUrlCache() {
  imageUrlCache.forEach((url) => URL.revokeObjectURL(url));
  imageUrlCache.clear();
  imageUrlPromises.clear();
}


function useDriveImageUrl(token, fileId) {
  const [url, setUrl] = useState(() => (fileId ? imageUrlCache.get(fileId) || null : null));
  const [error, setError] = useState('');

  useEffect(() => {
    if (!fileId || !token) return;
    let cancelled = false;
    const cached = imageUrlCache.get(fileId);
    if (cached) {
      setUrl(cached);
      return;
    }
    setUrl(null);
    setError('');
    let promise = imageUrlPromises.get(fileId);
    if (!promise) {
      promise = driveGetFileBlob(token, fileId).then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        imageUrlCache.set(fileId, objectUrl);
        return objectUrl;
      });
      imageUrlPromises.set(fileId, promise);
      promise.finally(() => imageUrlPromises.delete(fileId));
    }
    promise
      .then((objectUrl) => {
        if (!cancelled) setUrl(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load image');
      });
    return () => {
      cancelled = true;
    };
  }, [token, fileId]);

  return { url, error };
}

export { imageUrlCache, imageUrlPromises, releaseImageUrlCache, useDriveImageUrl };
