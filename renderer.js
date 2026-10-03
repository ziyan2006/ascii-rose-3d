import { ROSE_CENTER_Y } from './geometry.js';

export const DEFAULT_CHARSET = '@%#*+=-:.';

const VERTEX_SHADER = `
attribute vec3 a_position;
attribute vec3 a_color;
attribute vec3 a_normal;
uniform mat3 u_rotation;
uniform mat4 u_projection;
uniform float u_distance;
uniform float u_pointSize;
varying vec3 v_color;
varying float v_brightness;
varying float v_shade;
void main() {
  vec3 p = u_rotation * (a_position - vec3(0.0, ${ROSE_CENTER_Y.toFixed(2)}, 0.0));
  vec3 n = normalize(u_rotation * a_normal);
  float diffuse = abs(dot(n, normalize(vec3(-0.35, 0.55, 0.76))));
  float luminance = dot(a_color, vec3(0.2126, 0.7152, 0.0722));
  v_brightness = clamp((0.72 * diffuse + 0.28 * luminance) * 1.15, 0.0, 1.0);
  v_shade = 0.32 + 0.68 * diffuse;
  v_color = a_color;
  p.z -= u_distance;
  gl_Position = u_projection * vec4(p, 1.0);
  gl_PointSize = clamp(u_pointSize * u_distance / max(0.1, -p.z), 1.0, 64.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D u_atlas;
uniform float u_charCount;
uniform float u_atlasColumns;
uniform float u_depthPass;
varying vec3 v_color;
varying float v_brightness;
varying float v_shade;
void main() {
  float index = floor((1.0 - v_brightness) * (u_charCount - 1.0) + 0.5);
  vec2 uv = vec2((index + gl_PointCoord.x) / u_atlasColumns, gl_PointCoord.y);
  vec2 ink = texture2D(u_atlas, uv).rg;
  if (u_depthPass > 0.5) {
    if (ink.r < 0.18) discard;
    gl_FragColor = vec4(0.0);
  } else {
    float alpha = ink.r * 0.83 + ink.g * 0.25;
    if (alpha < 0.015) discard;
    gl_FragColor = vec4(v_color * v_shade * 1.2, min(0.95, alpha));
  }
}`;

function normalizeCharset(value) {
  const characters = Array.from(String(value || DEFAULT_CHARSET)).filter(char => !/[\u0000-\u001f\u007f]/u.test(char));
  return characters.length ? characters.slice(0, 24) : Array.from(DEFAULT_CHARSET);
}

/** Red stores crisp glyph coverage; green stores the same glyph's soft glow. */
function makeAtlas(charset) {
  const characters = normalizeCharset(charset);
  const columns = 2 ** Math.ceil(Math.log2(characters.length));
  const cellSize = 64;
  const canvas = document.createElement('canvas');
  const core = document.createElement('canvas');
  const glow = document.createElement('canvas');
  canvas.width = core.width = glow.width = columns * cellSize;
  canvas.height = core.height = glow.height = cellSize;
  const coreContext = core.getContext('2d', { willReadFrequently: true });
  const glowContext = glow.getContext('2d', { willReadFrequently: true });
  const context = canvas.getContext('2d');
  if (!coreContext || !glowContext || !context) throw new Error('无法创建字符图集');
  coreContext.font = '500 46px monospace';
  coreContext.textAlign = 'center';
  coreContext.textBaseline = 'middle';
  coreContext.fillStyle = '#fff';
  for (let i = 0; i < characters.length; i++) {
    coreContext.fillText(characters[i], i * cellSize + cellSize / 2, cellSize / 2 + 2, cellSize - 12);
  }
  glowContext.shadowColor = '#fff';
  glowContext.shadowBlur = 6;
  glowContext.drawImage(core, 0, 0);
  const coreData = coreContext.getImageData(0, 0, core.width, core.height).data;
  const glowData = glowContext.getImageData(0, 0, glow.width, glow.height).data;
  const pixels = context.createImageData(canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    pixels.data[i] = coreData[i + 3];
    pixels.data[i + 1] = glowData[i + 3];
    pixels.data[i + 2] = 0;
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return { canvas, core, glow, characters, columns, cellSize };
}

function makeProjection(out, width, height) {
  const aspect = Math.max(0.1, width / Math.max(1, height));
  const f = 1 / Math.tan(0.366519143);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = -(100 + 0.1) / (100 - 0.1);
  out[11] = -1;
  out[14] = -2 * 100 * 0.1 / (100 - 0.1);
  return Math.max(8.8, 5.7 / aspect);
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建着色器');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || '着色器编译失败');
  }
  return shader;
}

class WebGLRenderer {
  constructor(canvas, gl, points, charset) {
    this.canvas = canvas;
    this.gl = gl;
    this.mode = 'webgl';
    this.totalCount = points.count;
    this.count = points.count;
    this.projection = new Float32Array(16);
    this.width = 1;
    this.height = 1;
    this.ratio = 1;
    this.distance = 8.8;
    this.pointSize = 10;
    this.lost = false;
    this.points = points;
    this.charset = charset;
    this.initialize();
  }

  initialize() {
    const gl = this.gl;
    const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    const program = gl.createProgram();
    if (!program) throw new Error('无法创建渲染程序');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '着色器链接失败');
    this.program = program;
    gl.useProgram(program);
    this.buffers = [];
    this.bindAttribute('a_position', this.points.positions);
    this.bindAttribute('a_color', this.points.colors);
    this.bindAttribute('a_normal', this.points.normals);
    this.uniforms = {
      rotation: gl.getUniformLocation(program, 'u_rotation'),
      projection: gl.getUniformLocation(program, 'u_projection'),
      distance: gl.getUniformLocation(program, 'u_distance'),
      pointSize: gl.getUniformLocation(program, 'u_pointSize'),
      atlas: gl.getUniformLocation(program, 'u_atlas'),
      charCount: gl.getUniformLocation(program, 'u_charCount'),
      atlasColumns: gl.getUniformLocation(program, 'u_atlasColumns'),
      depthPass: gl.getUniformLocation(program, 'u_depthPass'),
    };
    this.texture = gl.createTexture();
    this.setCharset(this.charset);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    this.lost = false;
  }

  bindAttribute(name, data) {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.program, name);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
  }

  setCharset(charset) {
    this.charset = charset;
    const atlas = makeAtlas(charset);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas.canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(this.uniforms.atlas, 0);
    gl.uniform1f(this.uniforms.charCount, atlas.characters.length);
    gl.uniform1f(this.uniforms.atlasColumns, atlas.columns);
  }

  resize(width, height, ratio) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.ratio = ratio;
    this.canvas.width = Math.max(1, Math.round(this.width * ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * ratio));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.distance = makeProjection(this.projection, this.width, this.height);
    this.pointSize = Math.max(7.6, Math.min(14, Math.min(this.width * 0.024, this.height * 0.022))) * ratio;
    this.gl.uniformMatrix4fv(this.uniforms.projection, false, this.projection);
    this.gl.uniform1f(this.uniforms.distance, this.distance);
    this.gl.uniform1f(this.uniforms.pointSize, this.pointSize);
  }

  setActiveCount(count) {
    this.count = Math.min(this.totalCount, Math.max(3000, Math.round(count)));
  }

  render(rotation) {
    if (this.lost) return;
    const gl = this.gl;
    gl.uniformMatrix3fv(this.uniforms.rotation, false, rotation);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // GPU depth prepass preserves volume without sorting points on the CPU.
    gl.disable(gl.BLEND);
    gl.colorMask(false, false, false, false);
    gl.uniform1f(this.uniforms.depthPass, 1);
    gl.drawArrays(gl.POINTS, 0, this.count);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.uniform1f(this.uniforms.depthPass, 0);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }

  restore() {
    this.initialize();
    this.resize(this.width, this.height, this.ratio);
  }
}

class CanvasRenderer {
  constructor(canvas, points, charset) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: true });
    if (!this.context) throw new Error('此浏览器无法创建绘图画布');
    this.mode = '2d';
    this.points = points;
    this.totalCount = points.count;
    this.count = Math.min(points.count, 4500);
    this.projection = new Float32Array(16);
    this.paletteIndices = new Uint8Array(points.count);
    this.width = 1;
    this.height = 1;
    this.ratio = 1;
    this.distance = 8.8;
    this.pointSize = 10;
    const buckets = new Int16Array(512);
    buckets.fill(-1);
    const bucketCounts = new Uint32Array(512);
    this.palette = new Float32Array(512 * 3);
    this.paletteCount = 0;
    // Cache a compact RGB palette derived from the point colors themselves.
    for (let i = 0; i < points.count; i++) {
      const p = i * 3;
      const key = (Math.round(points.colors[p] * 7) << 6)
        | (Math.round(points.colors[p + 1] * 7) << 3) | Math.round(points.colors[p + 2] * 7);
      let row = buckets[key];
      if (row === -1) {
        row = this.paletteCount++;
        buckets[key] = row;
      }
      this.paletteIndices[i] = row;
      bucketCounts[row]++;
      this.palette[row * 3] += points.colors[p];
      this.palette[row * 3 + 1] += points.colors[p + 1];
      this.palette[row * 3 + 2] += points.colors[p + 2];
    }
    for (let row = 0; row < this.paletteCount; row++) {
      this.palette[row * 3] /= bucketCounts[row];
      this.palette[row * 3 + 1] /= bucketCounts[row];
      this.palette[row * 3 + 2] /= bucketCounts[row];
    }
    this.setCharset(charset);
  }

  setCharset(charset) {
    const atlas = makeAtlas(charset);
    this.charCount = atlas.characters.length;
    this.columns = atlas.columns;
    this.cellSize = atlas.cellSize;
    this.colorAtlas = document.createElement('canvas');
    this.colorAtlas.width = atlas.core.width;
    this.colorAtlas.height = atlas.cellSize * this.paletteCount;
    const context = this.colorAtlas.getContext('2d');
    for (let row = 0; row < this.paletteCount; row++) {
      const red = this.palette[row * 3] * 255;
      const g = this.palette[row * 3 + 1] * 255;
      const blue = this.palette[row * 3 + 2] * 255;
      context.globalCompositeOperation = 'source-over';
      context.drawImage(atlas.glow, 0, row * atlas.cellSize);
      context.globalCompositeOperation = 'source-in';
      // Limit compositing to this row; the rest of the atlas stays intact.
      context.save();
      context.beginPath();
      context.rect(0, row * atlas.cellSize, this.colorAtlas.width, atlas.cellSize);
      context.clip();
      context.fillStyle = `rgb(${Math.round(red)},${Math.round(g)},${Math.round(blue)})`;
      context.fillRect(0, row * atlas.cellSize, this.colorAtlas.width, atlas.cellSize);
      context.restore();
    }
  }

  resize(width, height, ratio) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.ratio = Math.min(1.5, ratio);
    this.canvas.width = Math.max(1, Math.round(this.width * this.ratio));
    this.canvas.height = Math.max(1, Math.round(this.height * this.ratio));
    this.distance = makeProjection(this.projection, this.width, this.height);
    this.pointSize = Math.max(7.6, Math.min(14, Math.min(width * 0.024, height * 0.022)));
    this.context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    this.context.imageSmoothingEnabled = true;
  }

  setActiveCount(count) {
    this.count = Math.min(this.totalCount, 4500, Math.max(3000, Math.round(count)));
  }

  render(rotation) {
    const context = this.context;
    const points = this.points;
    const positions = points.positions;
    const normals = points.normals;
    const colors = points.colors;
    const focal = this.height * this.projection[5] * 0.5;
    context.clearRect(0, 0, this.width, this.height);
    context.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.count; i++) {
      const p = i * 3;
      const x = positions[p];
      const y = positions[p + 1] - ROSE_CENTER_Y;
      const z = positions[p + 2];
      const rx = rotation[0] * x + rotation[3] * y + rotation[6] * z;
      const ry = rotation[1] * x + rotation[4] * y + rotation[7] * z;
      const depth = this.distance - (rotation[2] * x + rotation[5] * y + rotation[8] * z);
      if (depth <= 0.1) continue;
      const nx = rotation[0] * normals[p] + rotation[3] * normals[p + 1] + rotation[6] * normals[p + 2];
      const ny = rotation[1] * normals[p] + rotation[4] * normals[p + 1] + rotation[7] * normals[p + 2];
      const nz = rotation[2] * normals[p] + rotation[5] * normals[p + 1] + rotation[8] * normals[p + 2];
      const diffuse = Math.abs(-0.35 * nx + 0.55 * ny + 0.76 * nz);
      const luminance = 0.2126 * colors[p] + 0.7152 * colors[p + 1] + 0.0722 * colors[p + 2];
      const brightness = Math.min(1, (0.72 * diffuse + 0.28 * luminance) * 1.15);
      const glyph = Math.round((1 - brightness) * (this.charCount - 1));
      const size = this.pointSize * this.distance / depth;
      context.globalAlpha = 0.22 + diffuse * 0.46;
      context.drawImage(this.colorAtlas, glyph * this.cellSize, this.paletteIndices[i] * this.cellSize,
        this.cellSize, this.cellSize, this.width * 0.5 + rx * focal / depth - size * 0.5,
        this.height * 0.5 - ry * focal / depth - size * 0.5, size, size);
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
  }
}

/** A failed/locked WebGL canvas must be replaced before requesting a 2D context. */
export function createRenderer(canvas, points, charset = DEFAULT_CHARSET, force2D = false) {
  if (!force2D) {
    try {
      const gl = canvas.getContext('webgl', {
        alpha: true, antialias: false, depth: true, stencil: false,
        premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
      if (gl) return new WebGLRenderer(canvas, gl, points, charset);
    } catch (error) {
      console.warn('正在切换到轻量绘图模式：', error.message);
    }
  }
  const replacement = canvas.cloneNode(false);
  canvas.replaceWith(replacement);
  return new CanvasRenderer(replacement, points, charset);
}
