class WalkieCapture extends AudioWorkletProcessor {
  phase = 0;
  sum = 0;
  count = 0;
  frames = new Int16Array(6000);
  position = 0;
  ended = false;

  constructor() {
    super();
    this.port.onmessage = () => {
      this.ended = true;
      this.send(true);
    };
  }

  send(end = false) {
    const samples = this.frames.slice(0,this.position).buffer;
    this.position = 0;
    this.port.postMessage({samples,end},[samples]);
  }

  process(inputs) {
    if (this.ended) return false;
    for (const value of inputs[0]?.[0] ?? []) {
      this.sum += value;
      this.count++;
      this.phase += 12_000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const sample = this.sum / this.count;
      this.frames[this.position++] = Math.max(-32768,Math.min(32767,Math.round(sample*32768)));
      this.sum = this.count = 0;
      if (this.position === this.frames.length) this.send();
    }
    return true;
  }
}
registerProcessor("sg10-walkie-capture",WalkieCapture);
