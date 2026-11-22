export class SystemScheduler {
  constructor({ clock, debug } = {}) {
    this.clock = clock || null;
    this.debug = debug || { timers: {} };
    this.systems = [];
    this.rafId = 0;
    this.running = false;
    this._tick = this._tick.bind(this);
  }

  register(name, update, { enabled = true } = {}) {
    const existing = this.systems.find((s) => s.name === name);
    if (existing) {
      existing.update = update;
      existing.enabled = Boolean(enabled);
      return existing;
    }
    const sys = { name, enabled: Boolean(enabled), update };
    this.systems.push(sys);
    this.debug.timers[name] = {
      enabled: sys.enabled,
      lastMs: 0,
      avgMs: 0,
      maxMs: 0,
      calls: 0,
    };
    return sys;
  }

  setEnabled(name, enabled) {
    const sys = this.systems.find((s) => s.name === name);
    if (!sys) return false;
    sys.enabled = Boolean(enabled);
    if (this.debug.timers[name]) this.debug.timers[name].enabled = sys.enabled;
    return true;
  }

  isEnabled(name) {
    const sys = this.systems.find((s) => s.name === name);
    return Boolean(sys && sys.enabled);
  }

  resetTimers() {
    for (const key of Object.keys(this.debug.timers)) {
      const t = this.debug.timers[key];
      t.lastMs = 0;
      t.avgMs = 0;
      t.maxMs = 0;
      t.calls = 0;
    }
  }

  getTimers() {
    const out = {};
    for (const [k, v] of Object.entries(this.debug.timers)) {
      out[k] = { ...v };
    }
    return out;
  }

  step(dt, elapsed, ctx = {}) {
    const frameContext = { dt, elapsed, alreadyRenderedViewport: false, ...ctx };
    for (let i = 0; i < this.systems.length; i++) {
      const sys = this.systems[i];
      const timer = this.debug.timers[sys.name];
      if (!sys.enabled) {
        if (timer) timer.enabled = false;
        continue;
      }
      const t0 = performance.now();
      sys.update(dt, frameContext);
      const ms = performance.now() - t0;
      if (timer) {
        timer.enabled = true;
        timer.lastMs = ms;
        timer.avgMs = timer.calls ? timer.avgMs * 0.9 + ms * 0.1 : ms;
        if (ms > timer.maxMs) timer.maxMs = ms;
        timer.calls++;
      }
    }
    return frameContext;
  }

  _tick() {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this._tick);
    const dt = this.clock ? Math.min(0.25, this.clock.getDelta()) : 0.016;
    const elapsed = this.clock ? this.clock.elapsedTime : 0;
    this.step(dt, elapsed);
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.rafId = requestAnimationFrame(this._tick);
    return this;
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    return this;
  }
}
