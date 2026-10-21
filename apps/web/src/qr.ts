// A QR code for a server or group invite. It encodes exactly the URL the link names, so
// scanning it and tapping a shared link take the same code path (ADR 0010). The decoder is
// the other half and lives in qr-scan.ts, which is loaded only when someone scans (#18).
import qrcode from "qrcode-generator";

/** Inline SVG, so the app shell makes no request for the image. */
export function qrSvg(link: string): string {
  const code = qrcode(0, "M");
  code.addData(link);
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
