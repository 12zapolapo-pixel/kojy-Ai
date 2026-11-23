/**
 * Just enough MP3 to stream a file at its real speed: where each frame
 * starts, how long it is in bytes and in time. No decoding, no ffmpeg.
 * OWNERSHIP: apps/api/src/modules/radio
 */

export interface Mp3Frame { offset: number; length: number; ms: number }

// Bitrates in kbps by [version group][layer][index]; MPEG-1 and MPEG-2/2.5.
const BITRATES: Record<"1" | "2", Record<1 | 2 | 3, number[]>> = {
  "1": {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  "2": {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** The frame header at `i`, or null when there isn't a valid one. */
export function frameAt(buf: Uint8Array, i: number): Mp3Frame | null {
  if (i + 4 > buf.length || buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1]! >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5, 1 = reserved
  const layerBits = (buf[i + 1]! >> 1) & 3; // 1 = layer III, 2 = II, 3 = I
  const bitrateIndex = buf[i + 2]! >> 4;
  const rateIndex = (buf[i + 2]! >> 2) & 3;
  const padding = (buf[i + 2]! >> 1) & 1;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const kbps = BITRATES[version === 3 ? "1" : "2"][layer][bitrateIndex]!;
  const rate = SAMPLE_RATES[version]![rateIndex]!;
  let length: number, samples: number;
  if (layer === 1) { length = (Math.floor((12 * kbps * 1000) / rate) + padding) * 4; samples = 384; }
  else if (layer === 2 || version === 3) { length = Math.floor((144 * kbps * 1000) / rate) + padding; samples = 1152; }
  else { length = Math.floor((72 * kbps * 1000) / rate) + padding; samples = 576; }
  if (length < 4) return null;
  return { offset: i, length, ms: (samples * 1000) / rate };
}

/** Bytes to skip at the start: an ID3v2 tag, if there is one. */
function id3Size(buf: Uint8Array): number {
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0; // "ID3"
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  return 10 + size + ((buf[5]! & 0x10) ? 10 : 0);
}

/**
 * Every audio frame of a file, in order. A frame only counts when the next
 * one follows right after it (or it's the last), so stray 0xFF bytes in
 * tags or junk aren't mistaken for audio.
 */
export function mp3Frames(buf: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let i = id3Size(buf);
  while (i + 4 <= buf.length) {
    const f = frameAt(buf, i);
    if (f && f.offset + f.length <= buf.length) {
      const next = f.offset + f.length;
      if (next + 4 > buf.length || frameAt(buf, next)) { frames.push(f); i = next; continue; }
    }
    i++;
  }
  return frames;
}
