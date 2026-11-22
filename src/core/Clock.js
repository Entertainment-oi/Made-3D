export class Clock {
  constructor() { this.start(); }
  start() {
    this._t0 = this._last = performance.now();
    this.elapsed = 0;
    this.simElapsed = 0;
  }
  get elapsedTime() {
    return (performance.now() - this._t0) / 1000;
  }
  getWallElapsed() {
    return (performance.now() - this._t0) / 1000;
  }
  getSimElapsed() {
    return this.simElapsed;
  }
  // Segundos desde la última llamada (máx. 0.1 para evitar saltos al volver de otra pestaña).
  getDelta() {
    const now = performance.now();
    const d = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    this.elapsed = (now - this._t0) / 1000;
    this.simElapsed += d;
    return d;
  }
}
