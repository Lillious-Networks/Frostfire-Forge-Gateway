// Owns the single WebGL2 context the map is rendered with. The canvas is never
// attached to the DOM: each pass renders into its top-left corner and the 2D
// canvases copy that region with drawImage.

import {
  TILE_VS, TILE_FS, FULLSCREEN_VS, TRIM_FS, BLUR_FS,
  SHADOW_COMPOSITE_VS, SHADOW_COMPOSITE_FS,
} from "./shaders.js";

export interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  u(name: string): WebGLUniformLocation | null;
}

export interface GLState {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  quad: WebGLVertexArrayObject;
  tile: Program;
  trim: Program;
  blur: Program;
  shadowComposite: Program;
  maxTextureSize: number;
  maxArrayLayers: number;
}

let state: GLState | null = null;
let unavailable = false;
let contextLost = false;
// Bumped whenever the context is (re)created; GPU resources tagged with an
// older generation are stale and must be rebuilt.
let generation = 0;
const restoreListeners: Array<() => void> = [];

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`glmap: shader compile failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const program = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(program, v);
  gl.attachShader(program, f);
  gl.bindAttribLocation(program, 0, "aCorner");
  gl.linkProgram(program);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`glmap: program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  return {
    program,
    uniforms,
    u(name: string) {
      if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
      return uniforms.get(name)!;
    },
  };
}

function build(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext): GLState {
  // Unit quad (two triangles) shared by every pass.
  const quad = gl.createVertexArray()!;
  gl.bindVertexArray(quad);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Textures are uploaded premultiplied and untouched by colour management, so
  // pixels match what the 2D canvas drawImage path produced.
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  return {
    gl,
    canvas,
    quad,
    tile: link(gl, TILE_VS, TILE_FS),
    trim: link(gl, FULLSCREEN_VS, TRIM_FS),
    blur: link(gl, FULLSCREEN_VS, BLUR_FS),
    shadowComposite: link(gl, SHADOW_COMPOSITE_VS, SHADOW_COMPOSITE_FS),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
  };
}

// Returns the GL state, creating the context on first use. Null while the
// context is lost or if WebGL2 is unavailable (the map then doesn't render).
export function getGL(): GLState | null {
  if (state) return contextLost ? null : state;
  if (unavailable) return null;

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
    powerPreference: "high-performance",
  });
  if (!gl) {
    unavailable = true;
    console.error("glmap: WebGL2 is not available; the map cannot be rendered.");
    return null;
  }

  canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    contextLost = true;
    console.warn("glmap: WebGL context lost");
  });
  canvas.addEventListener("webglcontextrestored", () => {
    try {
      state = build(canvas, gl);
      generation++;
      contextLost = false;
      for (const listener of restoreListeners) listener();
    } catch (error) {
      console.error("glmap: failed to restore WebGL context", error);
    }
  });

  try {
    state = build(canvas, gl);
    generation++;
  } catch (error) {
    unavailable = true;
    console.error(error);
    return null;
  }
  return state;
}

export function getGeneration(): number {
  return generation;
}

export function onContextRestored(listener: () => void): void {
  restoreListeners.push(listener);
}

// Grow the (never displayed) canvas so a pass of this size fits. It only ever
// grows, so alternating between the map passes and the minimap doesn't
// reallocate the drawing buffer.
export function ensureCanvasSize(s: GLState, width: number, height: number): void {
  const w = Math.max(s.canvas.width, Math.ceil(width));
  const h = Math.max(s.canvas.height, Math.ceil(height));
  if (w !== s.canvas.width || h !== s.canvas.height) {
    s.canvas.width = w;
    s.canvas.height = h;
  }
}

// Target the top-left width x height region of the canvas and clear it.
export function beginCanvasPass(s: GLState, width: number, height: number): void {
  const gl = s.gl;
  ensureCanvasSize(s, width, height);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const y = s.canvas.height - height;
  gl.viewport(0, y, width, height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, y, width, height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
