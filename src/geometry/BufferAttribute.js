export class BufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.version = 0;
  }
  get count() { return this.array.length / this.itemSize; }
  // Marcar tras modificar `array` para que el renderer lo vuelva a subir a la GPU.
  set needsUpdate(v) { if (v) this.version++; }
}
