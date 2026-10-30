import { clipFor, STATES } from './core.js';

// Two decoders keep the last decoded frame visible until the next clip is ready.
export class StatePlayer {
  constructor(videos, { onState = () => {}, onError = () => {} } = {}) {
    this.videos = videos;
    this.onState = onState;
    this.onError = onError;
    this.state = this.desired = 'observe';
    this.active = 0;
    this.token = 0;
    this.enabled = true;
    this.running = false;
    this.loading = false;
    this.transitioning = false;
    for (const video of videos) {
      video.muted = true;
      video.playsInline = true;
      video.loop = false;
      video.addEventListener('ended', () => { if (video === this.videos[this.active]) this.advance(); });
      video.addEventListener('error', () => {
        if (this.enabled && video === this.videos[this.active] && this.running) {
          this.onError('No se pudo cargar la animación. Se conserva la imagen del estado.');
        }
      });
    }
  }

  request(state) {
    if (!STATES.includes(state)) throw new TypeError('Unknown visual state');
    this.desired = state;
    if (!this.enabled) { this.state = state; this.onState(state); return; }
    if (!this.running) { this.start(); return; }
    if (!this.transitioning && !this.loading) this.prepare(clipFor(this.state, state));
  }

  prepare(src) {
    const video = this.videos[1 - this.active];
    if (video.getAttribute('src') !== src) { video.src = src; video.load(); }
    return video;
  }

  async show(src) {
    const token = ++this.token;
    this.loading = true;
    const next = this.prepare(src);
    try {
      next.currentTime = 0;
      await next.play();
      if (next.requestVideoFrameCallback) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Video frame timeout')), 5000);
          next.requestVideoFrameCallback(() => { clearTimeout(timeout); resolve(); });
        });
      }
      if (token !== this.token || !this.enabled) { next.pause(); return; }
      const old = this.videos[this.active];
      next.classList.add('visible');
      old.classList.remove('visible');
      old.pause();
      this.active = 1 - this.active;
      this.running = true;
      if (!this.transitioning) this.prepare(clipFor(this.state, this.desired));
    } catch {
      if (token === this.token) {
        next.pause();
        this.running = false;
        this.onError('Pulsa Reanudar animación para iniciar el vídeo.');
      }
    } finally {
      if (token === this.token) this.loading = false;
    }
  }

  async start() {
    this.running = true;
    this.state = this.desired;
    this.transitioning = false;
    this.onState(this.state);
    await this.show(clipFor(this.state));
  }

  async advance() {
    if (!this.enabled) return;
    if (this.transitioning) {
      this.state = this.destination;
      this.transitioning = false;
      this.onState(this.state);
    }
    if (this.desired !== this.state) {
      this.destination = this.desired;
      this.transitioning = true;
      await this.show(clipFor(this.state, this.destination));
    } else await this.show(clipFor(this.state));
  }

  setMotion(enabled) {
    this.enabled = enabled;
    this.token++;
    this.running = false;
    this.loading = false;
    this.transitioning = false;
    for (const video of this.videos) { video.pause(); video.classList.remove('visible'); }
    if (enabled) this.start();
    else { this.state = this.desired; this.onState(this.state); }
  }
}
