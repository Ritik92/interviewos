// Audio helpers shared by the server and the migration script.

// Remove DC offset and normalise volume. Returns null if the clip is basically silent.
function cleanPcm(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (n < 1600) return null; // < 0.1 s
  let sum = 0;
  for (let i = 0; i < n; i++) sum += pcm.readInt16LE(i * 2);
  const mean = sum / n;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2) - mean));
  if (peak < 150) return null;
  const gain = Math.min(20, 30000 / peak);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round((pcm.readInt16LE(i * 2) - mean) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return out;
}

function pcmToWav(pcm, sampleRate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Plain ASCII for the device's tiny screen and pipe-separated protocol.
function asciiOnly(s) {
  return String(s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[|\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')
    .trim();
}

module.exports = { cleanPcm, pcmToWav, asciiOnly };
