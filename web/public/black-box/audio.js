const ROOT = '/black-box/assets/audio/';
const FILES = ['ambient', 'observe', 'evaluate', 'wait'];
export const audioLevel = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

export class BlackBoxAudio {
  constructor({ createContext = () => new (window.AudioContext || window.webkitAudioContext)(), fetchFile = fetch.bind(globalThis), onChange = () => {} } = {}) {
    this.createContext = createContext; this.fetchFile = fetchFile; this.onChange = onChange;
    this.context = null; this.buffers = new Map(); this.voices = new Set();
    this.enabled = false; this.loading = false; this.error = ''; this.generation = 0;
    this.ambientLevel = .65; this.effectsLevel = .55; this.lastState = 'observe';
    this.ambient = null; this.loadPromise = null;
  }

  get running() { return this.enabled && this.context?.state === 'running'; }
  notify() { this.onChange({ running: this.running, enabled: this.enabled, loading: this.loading, error: this.error }); }

  async enable() {
    const generation = ++this.generation;
    this.enabled = true; this.loading = true; this.error = '';
    try {
      if (!this.context) {
        const c = this.context = this.createContext();
        this.master = c.createGain(); this.master.gain.value = .85;
        this.ambientGain = c.createGain(); this.ambientGain.gain.value = this.ambientLevel;
        this.effectsGain = c.createGain(); this.effectsGain.gain.value = this.effectsLevel;
        this.duckGain = c.createGain();
        const limiter = c.createDynamicsCompressor();
        limiter.threshold.value = -10; limiter.knee.value = 8; limiter.ratio.value = 8;
        limiter.attack.value = .005; limiter.release.value = .25;
        this.ambientGain.connect(this.duckGain); this.duckGain.connect(this.master);
        this.effectsGain.connect(this.master); this.master.connect(limiter); limiter.connect(c.destination);
        c.onstatechange = () => this.notify();
      }
      // Always resume inside the click, including a retry of a blocked autoplay attempt.
      const resumed = this.context.resume();
      this.notify();
      this.loadPromise ??= this.load();
      await Promise.all([resumed, this.loadPromise]);
      if (generation !== this.generation || !this.enabled) return;
      if (!this.ambient) {
        const source = this.context.createBufferSource();
        source.buffer = this.buffers.get('ambient'); source.loop = true;
        this.ambientGain.gain.setValueAtTime(0, this.context.currentTime);
        this.ambientGain.gain.setTargetAtTime(this.ambientLevel, this.context.currentTime, .3);
        source.connect(this.ambientGain); source.onended = () => source.disconnect();
        source.start(); this.ambient = source;
      }
    } catch {
      if (generation !== this.generation) return;
      this.enabled = false; this.loadPromise = null;
      this.error = 'No se pudo activar el sonido. Pulsa para reintentar.';
      this.context?.suspend().catch(() => {});
    } finally {
      if (generation === this.generation) { this.loading = false; this.notify(); }
    }
  }

  async load() {
    const results = await Promise.allSettled(FILES.map(async name => {
      if (this.buffers.has(name)) return;
      const response = await this.fetchFile(`${ROOT}${name}.wav`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Audio unavailable');
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (!(buffer.duration > 0)) throw new Error('Empty audio');
      this.buffers.set(name, buffer);
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) { this.loadPromise = null; throw failed.reason; }
  }

  setAmbientLevel(value) {
    this.ambientLevel = audioLevel(value);
    this.ambientGain?.gain.setTargetAtTime(this.ambientLevel, this.context.currentTime, .08);
  }

  setEffectsLevel(value) {
    this.effectsLevel = audioLevel(value);
    this.effectsGain?.gain.setTargetAtTime(this.effectsLevel, this.context.currentTime, .04);
  }

  state(state) {
    if (!FILES.includes(state) || state === 'ambient') return;
    if (this.lastState === state) return;
    this.lastState = state;
    if (!this.running || this.loading || this.effectsLevel === 0 || !this.buffers.has(state)) return;
    const c = this.context, source = c.createBufferSource();
    source.buffer = this.buffers.get(state); source.connect(this.effectsGain);
    this.voices.add(source);
    source.onended = () => { this.voices.delete(source); source.disconnect(); };
    source.start();
    this.duckGain.gain.cancelAndHoldAtTime(c.currentTime);
    this.duckGain.gain.setTargetAtTime(.6, c.currentTime, .04);
    this.duckGain.gain.setTargetAtTime(1, c.currentTime + source.buffer.duration, .3);
  }

  disable() {
    this.generation++; this.enabled = false; this.loading = false;
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
    if (this.ambient) { this.ambient.stop(); this.ambient = null; }
    if (this.context) {
      this.duckGain.gain.cancelAndHoldAtTime(this.context.currentTime);
      this.duckGain.gain.setValueAtTime(1, this.context.currentTime);
      this.context.suspend().catch(() => {});
    }
    this.notify();
  }

  dispose() {
    this.disable();
    if (this.context) { this.context.onstatechange = null; this.context.close().catch(() => {}); }
  }
}
