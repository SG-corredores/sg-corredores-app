const voiceRate = 12_000;
const modules = new WeakMap();

export async function captureWalkie(audio, stream, send) {
  if (!modules.has(audio)) {
    const module = audio.audioWorklet.addModule(new URL("./walkie-worklet.js", import.meta.url)).catch(error=>{
      modules.delete(audio);
      throw error;
    });
    modules.set(audio,module);
  }
  await modules.get(audio);
  if (!stream.active) return null;
  const source = audio.createMediaStreamSource(stream);
  const processor = new AudioWorkletNode(audio,"sg10-walkie-capture");
  const silence = audio.createGain();
  silence.gain.value = 0;
  source.connect(processor).connect(silence).connect(audio.destination);
  let timer;
  function disconnect() {
    clearTimeout(timer);
    processor.port.onmessage = null;
    source.disconnect();
    processor.disconnect();
    silence.disconnect();
  }
  processor.port.onmessage = ({data}) => {
    if (data.samples?.byteLength) {
      const bytes = new Uint8Array(data.samples);
      send(btoa(String.fromCharCode(...bytes)));
    }
    if (data.end) disconnect();
  };
  return () => {
    processor.port.postMessage("flush");
    timer = setTimeout(disconnect,500);
  };
}

export function playWalkie(audio, encoded, time, volume) {
  if (typeof encoded !== "string" || !encoded.length || encoded.length > 16_000) return;
  let raw;
  try { raw = atob(encoded); } catch { return; }
  if (raw.length % 2 !== 0) return;
  const buffer = audio.createBuffer(1,raw.length/2,voiceRate);
  const frames = buffer.getChannelData(0);
  for (let i=0;i<frames.length;i++) {
    const sample = raw.charCodeAt(i*2) | raw.charCodeAt(i*2+1)<<8;
    frames[i] = (sample < 32768 ? sample : sample - 65536) / 32768;
  }
  const source = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = volume;
  source.buffer = buffer;
  source.connect(gain).connect(audio.destination);
  source.start(time);
  return {source, gain, end:time+buffer.duration};
}
