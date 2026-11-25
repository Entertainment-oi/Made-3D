import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRangeRatio,
  ratioToInputValue,
  syncRangeVisual,
} from '../editor/ui/rangeControls.js';

test('computeRangeRatio calcula el eje correcto en modo normal y modo móvil 90°', () => {
  // Slider vertical (.v-range) en modo normal: abajo = 0, arriba = 1
  const vNormRect = { left: 100, right: 128, top: 200, bottom: 300, width: 28, height: 100 };
  assert.equal(computeRangeRatio(vNormRect, { clientX: 114, clientY: 300 }, { isVertical: true, isRot90: false }), 0);
  assert.equal(computeRangeRatio(vNormRect, { clientX: 114, clientY: 200 }, { isVertical: true, isRot90: false }), 1);
  assert.ok(Math.abs(computeRangeRatio(vNormRect, { clientX: 114, clientY: 250 }, { isVertical: true, isRot90: false }) - 0.5) < 1e-6);

  // Slider vertical (.v-range) en modo móvil 90°: izquierda física = 0, derecha física = 1
  const vRotRect = { left: 50, right: 150, top: 300, bottom: 324, width: 100, height: 24 };
  assert.equal(computeRangeRatio(vRotRect, { clientX: 50, clientY: 312 }, { isVertical: true, isRot90: true }), 0);
  assert.equal(computeRangeRatio(vRotRect, { clientX: 150, clientY: 312 }, { isVertical: true, isRot90: true }), 1);
  assert.ok(Math.abs(computeRangeRatio(vRotRect, { clientX: 100, clientY: 312 }, { isVertical: true, isRot90: true }) - 0.5) < 1e-6);

  // Slider horizontal en modo móvil 90°: arriba física = 0, abajo física = 1
  const hRotRect = { left: 200, right: 222, top: 100, bottom: 300, width: 22, height: 200 };
  assert.equal(computeRangeRatio(hRotRect, { clientX: 211, clientY: 100 }, { isVertical: false, isRot90: true }), 0);
  assert.equal(computeRangeRatio(hRotRect, { clientX: 211, clientY: 300 }, { isVertical: false, isRot90: true }), 1);
  assert.ok(Math.abs(computeRangeRatio(hRotRect, { clientX: 211, clientY: 200 }, { isVertical: false, isRot90: true }) - 0.5) < 1e-6);
});

test('ratioToInputValue y syncRangeVisual respetan min/max/step y actualizan --range-pct', () => {
  const input = {
    min: '0.08',
    max: '2.5',
    step: '0.02',
    value: '0.45',
    style: {
      vars: {},
      setProperty(k, v) {
        this.vars[k] = v;
      },
    },
  };

  assert.equal(ratioToInputValue(input, 0), 0.08);
  assert.equal(ratioToInputValue(input, 1), 2.5);
  assert.equal(ratioToInputValue(input, 0.5), 1.3);

  syncRangeVisual(input);
  assert.equal(input.style.vars['--range-pct'], '15.29%');
});
