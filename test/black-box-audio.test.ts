import { describe, expect, test } from "bun:test";
import { BlackBoxAudio, audioLevel } from "../web/public/black-box/audio.js";

class Param {
  value = 1;
  setTargetAtTime(value: number) { this.value = value; }
  setValueAtTime(value: number) { this.value = value; }
  cancelAndHoldAtTime() {}
}
class Node {
  gain = new Param();
  threshold = new Param(); knee = new Param(); ratio = new Param(); attack = new Param(); release = new Param();
  buffer: { duration: number } | null = null;
  loop = false; started = false; stopped = false; disconnected = false;
  onended: (() => void) | null = null;
  connect() {}
  disconnect() { this.disconnected = true; }
  start() { this.started = true; }
  stop() { this.stopped = true; this.onended?.(); }
}
class Context {
  state = "suspended"; currentTime = 0; destination = {};
  onstatechange: (() => void) | null = null;
  sources: Node[] = [];
  resumeCalls = 0;
  createGain() { return new Node(); }
  createDynamicsCompressor() { return new Node(); }
  createBufferSource() { const source = new Node(); this.sources.push(source); return source; }
  async decodeAudioData() { return { duration: 32 }; }
  async resume() { this.resumeCalls++; this.state = "running"; this.onstatechange?.(); }
  async suspend() { this.state = "suspended"; this.onstatechange?.(); }
  async close() { this.state = "closed"; }
}
const ok = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(16) });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("Black Box original sound", () => {
  test("binds the native fetch receiver when loading in the browser", () => {
    const nativeFetch = globalThis.fetch;
    const calls: boolean[] = [];
    try {
      globalThis.fetch = function(this: unknown) { calls.push(this === globalThis); return Promise.resolve(new Response()); } as typeof fetch;
      const audio = new BlackBoxAudio();
      audio.fetchFile('/audio');
      expect(calls).toEqual([true]);
    } finally { globalThis.fetch = nativeFetch; }
  });
  test("stays silent until enabled, decodes four assets and starts exactly one ambient loop", async () => {
    const context = new Context();
    const files: string[] = [];
    const audio = new BlackBoxAudio({ createContext: () => context, fetchFile: async path => { files.push(path); return ok(); } });
    audio.state("wait");
    expect(context.sources).toHaveLength(0);
    await audio.enable(); await audio.enable();
    expect(files).toHaveLength(4);
    expect(audio.running).toBe(true);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]!.loop).toBe(true);
    expect(context.sources[0]!.started).toBe(true);
    audio.dispose();
  });
  test("a user gesture can retry pending autoplay without duplicate music", async () => {
    const context = new Context();
    let release: (() => void) | undefined;
    context.resume = () => {
      context.resumeCalls++;
      if (context.resumeCalls === 1) return new Promise<void>(resolve => { release = resolve; });
      context.state = "running";
      release?.();
      return Promise.resolve();
    };
    const audio = new BlackBoxAudio({ createContext: () => context, fetchFile: ok });
    const auto = audio.enable(); await flush();
    expect(audio.running).toBe(false);
    const gesture = audio.enable();
    await Promise.all([auto, gesture]);
    expect(context.resumeCalls).toBe(2);
    expect(context.sources).toHaveLength(1);
    audio.dispose();
  });
  test("disabling during asset loading cannot start audio later", async () => {
    const context = new Context();
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const audio = new BlackBoxAudio({ createContext: () => context, fetchFile: async () => { await gate; return ok(); } });
    const pending = audio.enable();
    audio.disable(); release!(); await pending;
    expect(audio.running).toBe(false);
    expect(context.sources).toHaveLength(0);
  });
  test("only actual state changes trigger distinct cues; mute stops all sources", async () => {
    const context = new Context();
    const audio = new BlackBoxAudio({ createContext: () => context, fetchFile: ok });
    await audio.enable();
    audio.state("evaluate"); audio.state("evaluate"); audio.state("wait"); audio.state("observe");
    expect(context.sources).toHaveLength(4);
    expect(context.sources.slice(1).map(source => source.buffer)).toEqual([
      audio.buffers.get("evaluate"), audio.buffers.get("wait"), audio.buffers.get("observe"),
    ]);
    audio.disable();
    expect(context.sources.every(source => source.stopped)).toBe(true);
    expect(audio.running).toBe(false);
    expect(audio.voices.size).toBe(0);
    expect(audio.duckGain.gain.value).toBe(1);
  });
  test("volume limits cannot amplify unexpectedly and zero effects suppress cues", async () => {
    expect(audioLevel(NaN)).toBe(0); expect(audioLevel(-1)).toBe(0); expect(audioLevel(9)).toBe(1);
    const context = new Context();
    const audio = new BlackBoxAudio({ createContext: () => context, fetchFile: ok });
    audio.setAmbientLevel(.4); await audio.enable();
    expect(audio.ambientGain.gain.value).toBe(.4);
    audio.setAmbientLevel(20); expect(audio.ambientGain.gain.value).toBe(1);
    audio.setEffectsLevel(0); audio.state("wait"); expect(context.sources).toHaveLength(1);
    audio.dispose();
  });
  test("a failed load reports an error and can retry without cached failure", async () => {
    const context = new Context();
    let fail = true;
    const audio = new BlackBoxAudio({ createContext: () => context, fetchFile: async () => fail ? { ok: false } : ok() });
    await audio.enable(); expect(audio.error).not.toBe(""); expect(audio.running).toBe(false);
    fail = false; await audio.enable(); expect(audio.error).toBe(""); expect(audio.running).toBe(true);
    audio.dispose();
  });
  test("WAV files are stereo PCM with near-zero boundary jumps and original licensing", async () => {
    const base = new URL("../web/public/black-box/assets/audio/", import.meta.url);
    for (const name of ["ambient", "observe", "evaluate", "wait"]) {
      const file = new Uint8Array(await Bun.file(new URL(`${name}.wav`, base)).arrayBuffer());
      const view = new DataView(file.buffer);
      expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("RIFF");
      expect(view.getUint16(22, true)).toBe(2);
      expect(view.getUint16(34, true)).toBe(16);
      for (const offset of [0, 2]) {
        expect(Math.abs(view.getInt16(44 + offset, true) - view.getInt16(file.length - 4 + offset, true))).toBeLessThan(10);
      }
    }
    expect(await Bun.file(new URL("LICENSE.txt", base)).text()).toContain("CC0");
  });
});
