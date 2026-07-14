import QRCode from "qrcode";

export async function generateQRDataUri(text: string, size: number = 200): Promise<string> {
  const svg = await QRCode.toString(text, { type: "svg", margin: 2, width: size });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
