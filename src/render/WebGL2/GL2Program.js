function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
    gl.deleteShader(s);
    throw new Error(`Made3D: error de shader\n${log}\n${numbered}`);
  }
  return s;
}

const _tmp2 = new Float32Array(2);
const _tmp3 = new Float32Array(3);
const _tmp4 = new Float32Array(4);
const flat = (v, n) => {
  if (v.elements) return v.elements;
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return v;
  if (v.toArray) {
    const buf = n === 2 ? _tmp2 : n === 4 ? _tmp4 : _tmp3;
    return v.toArray(buf);
  }
  if (n === 4 && v.x !== undefined) {
    _tmp4[0] = v.x; _tmp4[1] = v.y; _tmp4[2] = v.z; _tmp4[3] = v.w ?? 1;
    return _tmp4;
  }
  return v;
};

// Sube un valor a un uniform según su tipo GLSL.
export function setUniform(gl, u, v) {
  const l = u.loc;
  switch (u.type) {
    case 0x1406: typeof v === 'number' ? gl.uniform1f(l, v) : gl.uniform1fv(l, v); break;   // float
    case 0x8B50: gl.uniform2fv(l, flat(v, 2)); break;                                       // vec2
    case 0x8B51: gl.uniform3fv(l, flat(v, 3)); break;                                       // vec3
    case 0x8B52: gl.uniform4fv(l, flat(v, 4)); break;                                       // vec4
    case 0x1404: case 0x8B56:                                                               // int / bool
      typeof v === 'object' ? gl.uniform1iv(l, v) : gl.uniform1i(l, v | 0); break;
    case 0x8B5B: gl.uniformMatrix3fv(l, false, flat(v)); break;                             // mat3
    case 0x8B5C: gl.uniformMatrix4fv(l, false, flat(v)); break;                             // mat4
  }
}

export class Program {
  constructor(gl, vs, fs) {
    const p = gl.createProgram();
    const v = compile(gl, gl.VERTEX_SHADER, vs), f = compile(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, v); gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p) || '';
      const vsLog = gl.getShaderInfoLog(v) || '';
      const fsLog = gl.getShaderInfoLog(f) || '';
      const lost = gl.isContextLost();
      const errCode = gl.getError();
      gl.deleteShader(v); gl.deleteShader(f); gl.deleteProgram(p);
      const details = log.trim() || `isContextLost=${lost}, glError=${errCode}, vsLog=${vsLog}, fsLog=${fsLog}`;
      throw new Error('Made3D: error al enlazar el programa\n' + details);
    }
    gl.deleteShader(v); gl.deleteShader(f);
    this.program = p;
    this.uniforms = [];
    this.samplers = [];
    this.byName = {};
    this.frame = -1;
    gl.useProgram(p);
    let unit = 0;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (!info || info.name.startsWith('gl_')) continue;
      const u = { name: info.name.replace(/\[0\]$/, ''), loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size, unit: -1 };
      if (info.type === gl.SAMPLER_2D || info.type === gl.SAMPLER_2D_SHADOW) {
        u.unit = unit++;
        gl.uniform1i(u.loc, u.unit);
        this.samplers.push(u);
      }
      this.uniforms.push(u);
      this.byName[u.name] = u;
    }
    this.uModel = this.byName.uModel ? this.byName.uModel.loc : null;
    this.uNormalMatrix = this.byName.uNormalMatrix ? this.byName.uNormalMatrix.loc : null;
  }
}
