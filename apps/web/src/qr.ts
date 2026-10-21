// A QR code for a server or group invite. It encodes exactly the URL the link names, so
// scanning it and tapping a shared link take the same code path (ADR 0010). The decoder is
// the other half: adding a server by QR reads the same URL back, on the device (#18).
import qrcode from "qrcode-generator";
import jsQR from "jsqr";

/** Inline SVG, so the app shell makes no request for the image. */
export function qrSvg(link: string): string {
  const code = qrcode(0, "M");
  code.addData(link);
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

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

/** Large phone photos are downscaled first: the decoder needs pixels, not megabytes. */
const MAX_SCAN_EDGE = 1600;

/** Decodes an image the user picked: a screenshot, a downloaded code, or a photo. */
export async function decodeQrFile(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SCAN_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvasContext(width, height);
    if (context === null) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    return decodeQr(pixels.data, width, height);
  } finally {
    bitmap.close();
  }
}

let frameContext: CanvasRenderingContext2D | null = null;

/** Decodes the current camera frame. The frame never leaves the device. */
export function decodeQrFrame(video: HTMLVideoElement): string | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (width === 0 || height === 0) return null;
  if (frameContext === null || frameContext.canvas.width !== width || frameContext.canvas.height !== height) {
    frameContext = canvasContext(width, height);
  }
  if (frameContext === null) return null;
  frameContext.drawImage(video, 0, 0, width, height);
  const pixels = frameContext.getImageData(0, 0, width, height);
  return decodeQr(pixels.data, width, height);
}
