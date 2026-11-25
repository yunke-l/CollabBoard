import { hasSafeFilenameCharacters } from '@collabboard/contracts';

const extensions: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
};
export function validFilename(name: string, type: string) {
  return (
    hasSafeFilenameCharacters(name) &&
    !!extensions[type]?.includes(name.split('.').at(-1)!.toLowerCase())
  );
}
export function validateFile(body: Buffer, type: string) {
  if (!body.length) return false;
  if (type === 'text/plain') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(body);
      // Plain text permits tab, line feed, form feed, and carriage return.
      return body.every((byte) =>
        byte < 32 ? [9, 10, 12, 13].includes(byte) : byte !== 127,
      );
    } catch {
      return false;
    }
  }
  if (type === 'application/pdf')
    return (
      /^%PDF-[12]\.[0-9]/.test(body.subarray(0, 8).toString('ascii')) &&
      /%%EOF\s*$/.test(body.subarray(-1024).toString('ascii'))
    );
  if (type === 'image/webp')
    return (
      body.length >= 30 &&
      body.toString('ascii', 0, 4) === 'RIFF' &&
      body.readUInt32LE(4) + 8 === body.length &&
      body.toString('ascii', 8, 12) === 'WEBP' &&
      ['VP8 ', 'VP8L', 'VP8X'].includes(body.toString('ascii', 12, 16))
    );
  if (type === 'image/jpeg') {
    if (
      body.length < 12 ||
      !body.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      !body.subarray(-2).equals(Buffer.from([255, 217]))
    )
      return false;
    let offset = 2;
    let dimensions = false;
    while (offset + 4 < body.length) {
      if (body[offset] !== 255) return false;
      const marker = body[offset + 1]!;
      if (marker === 218) return dimensions;
      const size = body.readUInt16BE(offset + 2);
      if (size < 2 || offset + size + 2 > body.length) return false;
      if ([192, 193, 194].includes(marker))
        dimensions =
          size >= 8 &&
          body.readUInt16BE(offset + 5) > 0 &&
          body.readUInt16BE(offset + 7) > 0;
      offset += size + 2;
    }
    return false;
  }
  if (type === 'image/png') {
    if (
      body.length < 45 ||
      !body
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return false;
    let offset = 8;
    let header = false;
    let data = false;
    while (offset + 12 <= body.length) {
      const length = body.readUInt32BE(offset);
      const end = offset + 12 + length;
      if (end > body.length) return false;
      const chunk = body.toString('ascii', offset + 4, offset + 8);
      let crc = 0xffffffff;
      for (const byte of body.subarray(offset + 4, end - 4)) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      if ((crc ^ 0xffffffff) >>> 0 !== body.readUInt32BE(end - 4)) return false;
      if (!header) {
        if (
          chunk !== 'IHDR' ||
          length !== 13 ||
          !body.readUInt32BE(offset + 8) ||
          !body.readUInt32BE(offset + 12)
        )
          return false;
        header = true;
      }
      if (chunk === 'IDAT') data = true;
      if (chunk === 'IEND') return length === 0 && end === body.length && data;
      offset = end;
    }
  }
  return false;
}
