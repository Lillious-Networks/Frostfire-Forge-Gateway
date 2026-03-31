import pako from "../libs/pako.js";

const npcImage = new Image(), typingImage = new Image();
npcImage.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACMAAAAmCAYAAABOFCLqAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kT1Iw0AcxV9TxQ8qDq0g4pChioNdVMSxVLEIFkpboVUHk0u/oElDkuLiKLgWHPxYrDq4OOvq4CoIgh8g7oKToouU+L+k0CLGg+N+vLv3uHsHCI0KU82uKKBqlpGKx8RsblXseYWAPgQxgSGJmXoivZiB5/i6h4+vdxGe5X3uzzGg5E0G+ETiKNMNi3iDeHbT0jnvE4dYSVKIz4knDbog8SPXZZffOBcdFnhmyMik5olDxGKxg+UOZiVDJZ4hDiuqRvlC1mWF8xZntVJjrXvyFwby2kqa6zRHEccSEkhChIwayqjAQoRWjRQTKdqPefhHHH+SXDK5ymDkWEAVKiTHD/4Hv7s1C9NTblIgBnS/2PbHGNCzCzTrtv19bNvNE8D/DFxpbX+1Acx9kl5va+EjYHAbuLhua/IecLkDDD/pkiE5kp+mUCgA72f0TTkgeAv0r7m9tfZx+gBkqKvlG+DgEBgvUva6x7t7O3v790yrvx+jlHK64ZQ6gAAAAAZiS0dEAAAAAAAA+UO7fwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAAd0SU1FB+kCCRMwEsjIppIAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAB50lEQVRYw+2YvWvCYBDGn7xk0yRUKtqIiBBaUAoOznXv6B9b6GhnN3GRDErQRG2U1w9cStNB35hEjV/5sOBNuYRcft7de88h95LPW7gR4wHg/fURkrCMDYLOE/hofYMAgCQsQeeJ2EBYIgi7OS5UMS3VI4Oi8wSmpTrGhaq7TACgTBpQUYOyyZIkLJESg2+nyYyz46uGCWXS2IVhQKxsfSqhT7fPkuTHvl788mf7TstJ1PU9ZsTvVyTJjyvoNXZKLN7vZfuEOZrsat+nJwluyO4w/wKGPzaY9l0H4Z8MQ72nIUQJ2FsmNVWz5SBs0WRaOC3VoaZquzDpXhOmYUam3pKwhGmYSPea7jKxbEie8Ry2KZMGILB+Wq1hirlFrKcoJS6A1iYzn+0HyGJ8C99gxgHQ1z0ji9bmRjwgLBF2A8uihVWxgg6XiQSiw2WwKlZcFXFNYK2rI0lHkcAk6QhaVz889J6tISC6Uxdqaazh8Qksixa+2sb2COafrgZQtW0W3srZ87UpCAhvLCfUWTCsVN6yXeOrl6wQQWbl1Lj35eoOE9jaqWo64Gg2r3Zd6quaDvmcOTOYcZvBFPwUlsvZgxOe+KloWHZoSyB+Kho2kHdLIH4qGrZ5twTeT0XDNueWAADcLf3B+AfAy/vU2Mt7LwAAAABJRU5ErkJggg==';
typingImage.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACsAAAAVCAYAAADfLRcdAAABhWlDQ1BJQ0MgcHJvZmlsZQAAKJF9kT1Iw0AcxV+/qEhF0A4iDhmqONhFRcSpVLEIFkpboVUHk0u/oElDkuLiKLgWHPxYrDq4OOvq4CoIgh8g7oKToouU+L+k0CLGg+N+vLv3uHsHeJtVphj+GKCopp5OxIVcflUIviIAPwYwh3GRGVoys5iF6/i6h4evd1Ge5X7uz9EnFwwGeATiGNN0k3iDeGbT1DjvE4dZWZSJz4kndLog8SPXJYffOJds9vLMsJ5NzxOHiYVSF0tdzMq6QjxNHJEVlfK9OYdlzluclWqdte/JXxgqqCsZrtMcQQJLSCIFARLqqKAKE1FaVVIMpGk/7uIftv0pcknkqoCRYwE1KBBtP/gf/O7WKE5NOkmhOBB4sayPUSC4C7QalvV9bFmtE8D3DFypHX+tCcx+kt7oaJEjoH8buLjuaNIecLkDDD1poi7ako+mt1gE3s/om/LA4C3Qu+b01t7H6QOQpa6Wb4CDQ2CsRNnrLu/u6e7t3zPt/n4A+Ehy3OEAdvwAAAAGYktHRACjAGoAQYpfYckAAAAJcEhZcwAALiMAAC4jAXilP3YAAAAHdElNRQfpBQQTFRn3o6swAAAAGXRFWHRDb21tZW50AENyZWF0ZWQgd2l0aCBHSU1QV4EOFwAAAIVJREFUSMdjZEACqday/xkGGZh99DEjjM3EMITAkHIsI3LUK4nxwSWOXH80YI6y0ZSDs++9+sQwmgxoDViQOchR/+bTtwFzFLI7pIQFRpMBfZMBLtAY/hfOrl/JPCBqR5MB3SqFZ28/DIrSQISPa7Q0GLjSALlOHm0bjKjSYLSnMJoMGBgAuS4u7T48tcgAAAAASUVORK5CYII=';

const imageCache: Map<string, HTMLImageElement> = new Map();
const blobUrlCache: Map<string, string> = new Map();

export function getCachedImage(src: string): HTMLImageElement {

  if (imageCache.has(src)) {
    return imageCache.get(src)!;
  }

  const img = new Image();
  img.src = src;
  imageCache.set(src, img);

  return img;
}

export async function createCachedImage(src: string): Promise<HTMLImageElement> {

  // For Asset Server icon requests that return direct PNG files
  if (src && src.includes("/icon?")) {
    return new Promise((resolve) => {
      const newImg = new Image();

      // Wait for image to load before resolving
      const handleLoad = () => {
        newImg.removeEventListener("load", handleLoad);
        newImg.removeEventListener("error", handleError);
        resolve(newImg);
      };

      const handleError = () => {
        newImg.removeEventListener("load", handleLoad);
        newImg.removeEventListener("error", handleError);
        resolve(newImg);
      };

      newImg.addEventListener("load", handleLoad);
      newImg.addEventListener("error", handleError);
      newImg.src = src;
    });
  }

  // For sprite/sprite-sheet requests that need decompression
  if (src && (src.includes("/sprite?") || src.includes("/sprite-sheet-image?"))) {
    const newImg = new Image();

    try {
      console.log("[createCachedImage] Fetching sprite/sheet:", src);
      const response = await fetch(src);

      if (!response.ok) {
        console.error("[createCachedImage] Response not ok:", response.status);
        return newImg;
      }

      const responseText = await response.text();

      let data;
      try {
        data = JSON.parse(responseText);
      } catch (parseError) {
        console.error("[createCachedImage] JSON parse error:", parseError);
        return newImg;
      }

      if (!data?.data) {
        console.error("[createCachedImage] No data field in response");
        return newImg;
      }

      // Decompress gzipped base64 data
      const binaryString = atob(data.data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      //@ts-expect-error - pako is imported
      const inflated = pako.inflate(bytes, { to: "string" });
      newImg.src = `data:image/png;base64,${inflated}`;

      return newImg;
    } catch (error) {
      console.error("[createCachedImage] Error loading sprite:", error);
      return newImg;
    }
  }

  // For regular URLs and data URLs, just set src directly
  getCachedImage(src);
  const newImg = new Image();
  newImg.src = src;
  return newImg;
}

export function clearImageCache(): void {
  imageCache.clear();
}

export { npcImage, typingImage };