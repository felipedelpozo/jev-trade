import { resultCue } from './stage.js';

const AUDIO_ROOT = '/orbit/assets/audio/';
const FILES = ['music', 'spin', 'reel-stop', 'opening', 'win', 'loss', 'miss', 'robot-curious', 'robot-win', 'robot-loss', 'robot-signal'];

export function outcomeSound(event, preview = '') {
  const cue = resultCue(event, preview);
  if (cue) return cue.kind;
  if (event?.kind === 'opened') return 'opening';
  if (event?.kind === 'closed-unverified') return 'signal';
  return 'miss';
}

export function audioLevel(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export class OrbitAudio {
  constructor({ createContext = () => new AudioContext(), fetchFile = fetch.bind(globalThis), onChange = () => {} } = {}) {
    this.createContext = createContext; this.fetchFile = fetchFile; this.onChange = onChange;
    this.context = null; this.buffers = new Map(); this.voices = new Set();
    this.enabled = false; this.loading = false; this.error = ''; this.musicLevel = .16; this.effectsLevel = .6;
    this.music = null; this.spin = null; this.loadPromise = null;
  }

  get running() { return this.enabled && this.context?.state === 'running'; }

  notify() { this.onChange({ running: this.running, loading: this.loading, error: this.error }); }

  async enable() {
    if (this.loading) return;
    this.loading = true; this.error = ''; this.enabled = true; this.notify();
    try {
      if (!this.context) {
        this.context = this.createContext();
        const c = this.context;
        this.master = c.createGain(); this.master.gain.value = .8;
        this.effectsGain = c.createGain(); this.effectsGain.gain.value = this.effectsLevel;
        this.musicGain = c.createGain(); this.musicGain.gain.value = this.musicLevel;
        this.duckGain = c.createGain();
        const limiter = c.createDynamicsCompressor();
        limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 12;
        limiter.attack.value = .003; limiter.release.value = .18;
        this.musicGain.connect(this.duckGain); this.duckGain.connect(this.master);
        this.effectsGain.connect(this.master); this.master.connect(limiter); limiter.connect(c.destination);
        c.onstatechange = () => this.notify();
      }
      // Resume inside the user's click, before fetching or decoding any media.
      await this.context.resume();
      this.loadPromise ??= this.load();
      await this.loadPromise;
      if (this.enabled) { this.master.gain.setTargetAtTime(.8, this.context.currentTime, .02); this.startMusic(); }
    } catch (error) {
      this.enabled = false; this.loadPromise = null;
      this.error = error instanceof Error ? error.message : 'No se puede activar el audio';
      this.context?.suspend().catch(() => {});
    } finally { this.loading = false; this.notify(); }
  }

  async load() {
    const results = await Promise.allSettled(FILES.map(async name => {
      if (this.buffers.has(name)) return;
      const response = await this.fetchFile(`${AUDIO_ROOT}${name}.wav`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`No se puede cargar el sonido ${name}`);
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (!(buffer.duration > 0)) throw new Error(`Sonido vacío: ${name}`);
      this.buffers.set(name, buffer);
    }));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  startMusic() {
    if (!this.running || this.music || this.musicLevel === 0 || !this.buffers.has('music')) return;
    const source = this.context.createBufferSource(); source.buffer = this.buffers.get('music'); source.loop = true;
    source.connect(this.musicGain); source.onended = () => source.disconnect(); source.start(); this.music = source;
  }

  setMusicLevel(value) {
    this.musicLevel = audioLevel(value);
    if (!this.context) return;
    this.musicGain.gain.setTargetAtTime(this.musicLevel, this.context.currentTime, .04);
    if (this.musicLevel > 0) this.startMusic();
  }

  setEffectsLevel(value) {
    this.effectsLevel = audioLevel(value);
    if (this.context) this.effectsGain.gain.setTargetAtTime(this.effectsLevel, this.context.currentTime, .03);
  }

  play(name, { volume = 1, rate = 1, delay = 0, loop = false } = {}) {
    if (!this.running || this.loading || this.effectsLevel === 0 || !this.buffers.has(name)) return null;
    const c = this.context, source = c.createBufferSource(), gain = c.createGain();
    source.buffer = this.buffers.get(name); source.loop = loop; source.playbackRate.value = rate;
    gain.gain.value = audioLevel(volume); source.connect(gain); gain.connect(this.effectsGain);
    this.voices.add(source);
    source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); };
    source.start(c.currentTime + delay);
    return source;
  }

  duck(seconds) {
    if (!this.running || this.effectsLevel === 0) return;
    const now = this.context.currentTime, gain = this.duckGain.gain;
    gain.cancelAndHoldAtTime(now); gain.setTargetAtTime(.28, now, .035);
    gain.setTargetAtTime(1, now + seconds, .3);
  }

  startSpin() {
    this.stopSpin(); this.spin = this.play('spin', { loop: true, volume: .42 });
    this.play('robot-curious', { volume: .65 }); this.duck(2.8);
  }

  reelStop(column) { this.play('reel-stop', { volume: .75, rate: 1 + column * .08 }); }

  stopSpin() { if (this.spin) { this.voices.delete(this.spin); this.spin.stop(); this.spin = null; } }

  outcome(event, preview = '') {
    this.stopSpin();
    const kind = outcomeSound(event, preview);
    if (kind === 'win') { this.play('win'); this.play('robot-win', { delay: .2, volume: .8 }); this.duck(3.3); }
    else if (kind === 'loss') { this.play('loss', { volume: .8 }); this.play('robot-loss', { delay: .2, volume: .7 }); this.duck(1.8); }
    else if (kind === 'opening') { this.play('opening', { volume: .7 }); this.play('robot-curious', { delay: .1, volume: .45 }); }
    else if (kind === 'signal') { this.play('robot-signal', { volume: .65 }); }
    else { this.play('miss', { volume: .4 }); this.play('robot-loss', { volume: .25 }); }
  }

  clearGame() {
    this.stopSpin();
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
    if (this.context) {
      const gain = this.duckGain.gain, now = this.context.currentTime;
      gain.cancelAndHoldAtTime(now); gain.setTargetAtTime(1, now, .05);
    }
  }

  disable() {
    this.enabled = false; this.clearGame();
    if (this.music) { this.music.stop(); this.music = null; }
    if (this.context) this.context.suspend().catch(() => {});
    this.notify();
  }
}
