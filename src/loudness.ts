// How much to turn a recording up (or down) on air so his voice sits at a
// steady, normal level whatever distance he spoke from.

export const TARGET_RMS = 0.1; // average level to aim for (about -20 dBFS)
export const MAX_LIFT = 6; // never more than this, so hiss isn't blown up

// `rms` is the recording's average level, `peak` its loudest sample.
export function playbackGain(rms: number, peak: number): number {
  if (!(rms > 0.001) || !(peak > 0.001)) return 1; // silence or near it: leave alone
  const wanted = TARGET_RMS / rms;
  const noClip = 0.95 / peak; // the loudest moment must still fit
  return Math.max(0.25, Math.min(MAX_LIFT, wanted, noClip));
}

export function measure(buf: { numberOfChannels: number; getChannelData(ch: number): Float32Array }): { rms: number; peak: number } {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i];
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      n++;
    }
  }
  return { rms: n ? Math.sqrt(sum / n) : 0, peak };
}
