// A QR code for an invite link. It encodes exactly the URL the link names, so scanning it
// and tapping a shared link take the same code path (ADR 0010).
import qrcode from "qrcode-generator";

/** Inline SVG, so the app shell makes no request for the image. */
export function qrSvg(link: string): string {
  const code = qrcode(0, "M");
  code.addData(link);
  code.make();
  return code.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
