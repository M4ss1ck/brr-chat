// The scanning half of the QR feature (#18). It is its own bundle (`/qr-scan.js`) because
// jsQR is about 27 KB compressed: a single-server user should not download it to open the
// app. The Add-server panel loads this module when someone picks an image or starts the
// camera, and the service worker caches it after that first use.
import jsQR from "jsqr";

/** Large phone photos and camera frames are downscaled first: pixels, not megabytes. */
const MAX_SCAN_EDGE = 1600;
/** A live frame only needs enough pixels to find the code; 800 keeps a phone cool. */
const MAX_FRAME_EDGE = 800;

/**
 * Reads one QR code out of raw pixels. jsQR does the locating, perspective correction and
 * Reed-Solomon repair, so a screenshot, a photo and a camera frame all go through here.
 * Inversion is skipped: every code this app shows is dark on light.
 */
export function decodeQr(data: Uint8ClampedArray, width: number, height: number): string | null {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) return null;
  return jsQR(data, width, height, { inversionAttempts: "dontInvert" })?.data ?? null;
}

function canvasContext(width: number, height: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d", { willReadFrequently: true });
}

function scaled(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Decodes an image the user picked: a screenshot, a downloaded code, or a photo. */
export async function decodeQrFile(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = scaled(bitmap.width, bitmap.height, MAX_SCAN_EDGE);
    const context = canvasContext(size.width, size.height);
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const pixels = context.getImageData(0, 0, size.width, size.height);
    return decodeQr(pixels.data, size.width, size.height);
  } finally {
    bitmap.close();
  }
}

let frameSurface: { width: number; height: number; context: CanvasRenderingContext2D } | null = null;

/** Decodes the current camera frame. The frame never leaves the device. */
export function decodeQrFrame(video: HTMLVideoElement): string | null {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (sourceWidth === 0 || sourceHeight === 0) return null;
  const size = scaled(sourceWidth, sourceHeight, MAX_FRAME_EDGE);
  if (frameSurface === null || frameSurface.width !== size.width || frameSurface.height !== size.height) {
    const context = canvasContext(size.width, size.height);
    if (context === null) return null;
    frameSurface = { ...size, context };
  }
  frameSurface.context.drawImage(video, 0, 0, size.width, size.height);
  const pixels = frameSurface.context.getImageData(0, 0, size.width, size.height);
  return decodeQr(pixels.data, size.width, size.height);
}
