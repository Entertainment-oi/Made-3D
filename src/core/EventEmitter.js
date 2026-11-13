export class EventEmitter {
  on(type, fn) { ((this._l ??= {})[type] ??= []).push(fn); return this; }
  off(type, fn) {
    const a = this._l && this._l[type];
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    return this;
  }
  emit(type, data) {
    const a = this._l && this._l[type];
    if (a) for (const f of a.slice()) f(data);
  }
}
