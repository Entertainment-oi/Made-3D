export class EventEmitter {
  on(type, fn) {
    if (typeof fn !== 'function') return this;
    const map = (this._l ??= {});
    const list = (map[type] ??= []);
    if (!list.includes(fn)) list.push(fn);
    return this;
  }

  off(type, fn) {
    const a = this._l && this._l[type];
    if (a) {
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    }
    return this;
  }

  emit(type, data) {
    const a = this._l && this._l[type];
    if (!a || !a.length) return this;
    const evt = data && typeof data === 'object' ? data : { type, value: data };
    if (!evt.type) evt.type = type;
    if (evt.target === undefined) evt.target = this;
    for (const f of a.slice()) f.call(this, evt);
    return this;
  }

  // Aliases estilo Three.js / DOM para mantener una única API de eventos en toda la librería.
  addEventListener(type, fn) {
    return this.on(type, fn);
  }

  removeEventListener(type, fn) {
    return this.off(type, fn);
  }

  dispatchEvent(evt) {
    if (!evt || !evt.type) return this;
    return this.emit(evt.type, evt);
  }
}
