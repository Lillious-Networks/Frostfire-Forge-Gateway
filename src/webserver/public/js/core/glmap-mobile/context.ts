import { TILE_VS, TILE_FS, FULLSCREEN_VS, TRIM_FS, BLUR_FS, SHADOW_COMPOSITE_VS, SHADOW_COMPOSITE_FS } from "./shaders.js";

function compile(gl: WebGL2RenderingContext, name: string, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader)
    throw new Error(`glmap: ${name} shader creation failed`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    const stage = type === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(`glmap: ${name} ${stage} shader compile failed: ${log}`);
  }
  return shader;
}
function link(gl: WebGL2RenderingContext, name: string, vs: string, fs: string) {
  const program = gl.createProgram();
  const v = compile(gl, name, gl.VERTEX_SHADER, vs);
  const f = compile(gl, name, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.bindAttribLocation(program, 0, "aCorner");
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`glmap: ${name} program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = new Map;
  return {
    program,
    uniforms,
    u(name: string) {
      if (!uniforms.has(name))
        uniforms.set(name, gl.getUniformLocation(program, name));
      return uniforms.get(name);
    }
  };
}
function build(id: any, canvas: any, gl: any) {
  const quad = gl.createVertexArray();
  gl.bindVertexArray(quad);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  return {
    id,
    gl,
    canvas,
    generation: nextGeneration++,
    quad,
    tile: link(gl, "tile", TILE_VS, TILE_FS),
    trim: link(gl, "trim", FULLSCREEN_VS, TRIM_FS),
    blur: link(gl, "blur", FULLSCREEN_VS, BLUR_FS),
    shadowComposite: link(gl, "shadowComposite", SHADOW_COMPOSITE_VS, SHADOW_COMPOSITE_FS),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)
  };
}
export function getGL(id: any) {
  const existing = surfaces.get(id);
  if (existing)
    return existing.lost ? null : existing.state;
  if (unavailable)
    return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance"
  });
  if (!gl) {
    unavailable = true;
    console.error(`glmap: WebGL2 is not available (WebGL1: ${!!document.createElement("canvas").getContext("webgl")}); the map cannot be rendered.`);
    return null;
  }
  const surface: { canvas: HTMLCanvasElement; state: ReturnType<typeof build> | null; lost: boolean } = { canvas, state: null, lost: false };
  surfaces.set(id, surface);
  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    surface.lost = true;
    console.warn(`glmap: WebGL context lost (${id})`);
  });
  canvas.addEventListener("webglcontextrestored", () => {
    try {
      surface.state = build(id, canvas, gl);
      surface.lost = false;
    } catch (error) {
      console.error(`glmap: failed to restore WebGL context (${id})`, error);
    }
  });
  try {
    surface.state = build(id, canvas, gl);
  } catch (error) {
    unavailable = true;
    console.error("glmap: WebGL2 setup failed; the map cannot be rendered.", error);
    return null;
  }
  return surface.state;
}
export function getAllGL() {
  const states = [];
  for (const surface of surfaces.values()) {
    if (surface.state && !surface.lost)
      states.push(surface.state);
  }
  return states;
}
export function getSurfaceCanvas(id: any) {
  return surfaces.get(id)?.canvas ?? null;
}
export function beginCanvasPass(s: any, width: any, height: any, clear = [0, 0, 0, 0]) {
  const gl = s.gl;
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (s.canvas.width !== w || s.canvas.height !== h) {
    s.canvas.width = w;
    s.canvas.height = h;
    if (gl.drawingBufferWidth < w || gl.drawingBufferHeight < h) {
      console.error(`glmap: ${s.id} drawing buffer is ${gl.drawingBufferWidth}x${gl.drawingBufferHeight}, requested ${w}x${h}`);
    }
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, w, h);
  gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
const surfaces: Map<any, any> = new Map();
let unavailable = false, nextGeneration = 1;
