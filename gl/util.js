// Small WebGL2 helpers shared by the render modules.

export function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      const log = gl.getShaderInfoLog(s);
      const line = +(/ERROR: 0:(\d+)/.exec(log) || [])[1];
      throw new Error(log + (line ? '\n> ' + src.split('\n')[line - 1] : ''));
    }
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i--;) {
    const info = gl.getActiveUniform(p, i), name = info.name.replace('[0]', '');
    u[name] = { loc: gl.getUniformLocation(p, name), type: info.type };
  }
  return { p, u };
}

// Sets uniforms by name; the setter follows the uniform's declared type. Unknown names are skipped.
export function uniforms(gl, prog, values) {
  for (const name in values) {
    const u = prog.u[name];
    if (!u) continue;
    const v = typeof values[name] === 'number' ? [values[name]] : values[name];
    switch (u.type) {
      case gl.FLOAT: gl.uniform1fv(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      default: gl.uniform1iv(u.loc, v);
    }
  }
}

// Binds textures to units first, first + 1, ... in the order given.
export function textures(gl, prog, map, first = 0) {
  let i = first;
  for (const name in map) {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, map[name]);
    if (prog.u[name]) gl.uniform1i(prog.u[name].loc, i);
    i++;
  }
}

export function texture(gl, w, h, { internal = gl.RGBA8, format = gl.RGBA, type = gl.UNSIGNED_BYTE, filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return t;
}

// A framebuffer with one or more colour textures: target(gl, w, h, fmtA, fmtB, ...).
export function target(gl, w, h, ...formats) {
  if (!formats.length) formats = [{}];
  const fb = gl.createFramebuffer(), texs = formats.map(f => texture(gl, w, h, f));
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  if (texs.length > 1) gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
  return { fb, tex: texs[0], texs, w, h };
}

export function release(gl, t) {
  if (!t) return;
  t.texs.forEach(x => gl.deleteTexture(x));
  gl.deleteFramebuffer(t.fb);
}

export function bindTarget(gl, t, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
  gl.viewport(0, 0, t ? t.w : w, t ? t.h : h);
}

// A dynamic vertex buffer with float attributes at locations 0, 1, 2, ... of the given sizes.
export function geometry(gl, sizes) {
  const vao = gl.createVertexArray(), buf = gl.createBuffer(), stride = sizes.reduce((a, b) => a + b, 0);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  let off = 0;
  sizes.forEach((n, i) => {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, n, gl.FLOAT, false, stride * 4, off * 4);
    off += n;
  });
  return { vao, buf, stride };
}

export function upload(gl, geo, data, floats) {
  gl.bindVertexArray(geo.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, geo.buf);
  gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, floats), gl.DYNAMIC_DRAW);
}

// Fullscreen triangle with no vertex buffer.
export function fullscreen(gl) {
  const vao = gl.createVertexArray();
  return () => { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); };
}
