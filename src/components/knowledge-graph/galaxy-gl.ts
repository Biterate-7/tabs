import type { Lens } from "@/lib/knowledge-graph/projection"
import type { Camera, Viewport } from "@/lib/knowledge-graph/view"
import { FIELD_STRIDE } from "./galaxy-field"
import type { Field } from "./galaxy-field"

/**
 * The galaxy's dust on the GPU: every particle of the field (galaxy-field.ts)
 * as one point sprite, in one draw call.
 *
 * The vertex shader projects each particle through exactly the perspective
 * camera the rest of the graph uses (projection.ts `project`), so the dust
 * and the stars drawn over it on the 2D canvas never part. Twinkle, the
 * opening's growth and the dimming outside a chosen cluster are computed
 * there too: a frame costs a handful of uniforms, not a loop over thousands
 * of particles in JavaScript.
 *
 * Tiny points are drawn at a floor size with their brightness scaled down
 * by area, so sub-pixel dust shimmers like dust instead of flickering on
 * and off as it crosses pixel boundaries.
 */

const VERTEX = `
attribute vec3 aPos;
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aPhase;
attribute float aSpeed;
uniform vec3 uCamera;
uniform vec3 uLens;
uniform vec2 uViewport;
uniform float uDpr;
uniform float uTime;
uniform float uReveal;
uniform float uGain;
uniform float uExtent;
uniform float uPx;
uniform vec4 uFocus;
varying vec4 vColor;

void main() {
  float rn = length(aPos.xy) / uExtent;
  float grow = clamp((uReveal * 1.6 - rn * 0.7) / 0.5, 0.0, 1.0);
  vec3 p = vec3(aPos.xy * (0.82 + 0.18 * grow), aPos.z);
  float dx = p.x - uCamera.x;
  float dy = p.y - uCamera.y;
  float cy = cos(uLens.y);
  float sy = sin(uLens.y);
  float rx = dx * cy - dy * sy;
  float ry = dx * sy + dy * cy;
  float ct = cos(uLens.x);
  float st = sin(uLens.x);
  float vy = ry * ct - p.z * st;
  float toward = ry * st + p.z * ct;
  float den = uLens.z - toward * uCamera.z;
  if (den < uLens.z * 0.12 || grow <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec4(0.0);
    return;
  }
  float s = uLens.z / den;
  float scale = uCamera.z * s;
  vec2 screen = vec2(uViewport.x * 0.5 + rx * scale, uViewport.y * 0.5 + vy * scale);
  gl_Position = vec4(screen.x / uViewport.x * 2.0 - 1.0, 1.0 - screen.y / uViewport.y * 2.0, 0.0, 1.0);

  float size = aSize * uPx * clamp(s, 0.6, 1.6) * uDpr * 2.0;
  float twinkle = 0.72 + 0.28 * sin(uTime * aSpeed + aPhase);
  float a = aAlpha * twinkle * grow * uGain * clamp(s, 0.55, 1.15);
  float inside = 1.0 - smoothstep(uFocus.z * 0.75, uFocus.z * 1.5, distance(aPos.xy, uFocus.xy));
  a *= mix(1.0, mix(0.3, 1.0, inside), uFocus.w);
  float floorSize = 1.7 * uDpr;
  if (size < floorSize) {
    a *= size / floorSize;
    size = floorSize;
  }
  gl_PointSize = size;
  vColor = vec4(aColor * a, a);
}
`

const FRAGMENT = `
precision mediump float;
varying vec4 vColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d2 = dot(c, c);
  if (d2 > 1.0) discard;
  gl_FragColor = vColor * exp(-d2 * 3.2);
}
`

export type GalaxyFrame = {
  camera: Camera
  lens: Lens
  viewport: Viewport
  dpr: number
  time: number
  /** 0 … 1: the opening, the dust growing out from the core. 1 once it has played. */
  reveal: number
  /** Overall brightness: the person's glow, the theme. */
  gain: number
  /** Screen size of a 1-unit particle, before perspective. */
  px: number
  /** The chosen cluster (world x, y, radius) and how strongly everything outside it is dimmed (0 … 1). */
  focus: { x: number; y: number; r: number; strength: number }
  /** Light adds on ink; on paper the dust is drawn as ink. */
  additive: boolean
}

type Uniforms = Record<"camera" | "lens" | "viewport" | "dpr" | "time" | "reveal" | "gain" | "extent" | "px" | "focus", WebGLUniformLocation | null>

export class GalaxyGL {
  private program: WebGLProgram | null = null
  private buffer: WebGLBuffer | null = null
  private uniforms: Uniforms | null = null
  private count = 0
  private extent = 1
  private field: Field | null = null
  private lost = false

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private gl: WebGLRenderingContext
  ) {
    canvas.addEventListener("webglcontextlost", this.onLost)
    canvas.addEventListener("webglcontextrestored", this.onRestored)
    this.init()
  }

  /** A renderer on this canvas, or null where WebGL is unavailable (the caller draws a sparser field in 2D instead). */
  static create(canvas: HTMLCanvasElement): GalaxyGL | null {
    let gl: WebGLRenderingContext | null = null
    try {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power" }) as WebGLRenderingContext | null
    } catch {
      gl = null
    }
    if (!gl) return null
    const renderer = new GalaxyGL(canvas, gl)
    return renderer.program ? renderer : (renderer.dispose(), null)
  }

  get ready(): boolean {
    return !this.lost && this.program !== null
  }

  setField(field: Field) {
    this.field = field
    if (this.lost) return
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, field.data.subarray(0, field.count * FIELD_STRIDE), gl.STATIC_DRAW)
    this.count = field.count
    this.extent = field.extent
  }

  draw(frame: GalaxyFrame) {
    const gl = this.gl
    if (!this.ready || !this.uniforms) return
    const { width, height } = frame.viewport
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (this.count === 0 || width <= 0 || height <= 0) return
    gl.useProgram(this.program)
    const u = this.uniforms
    gl.uniform3f(u.camera, frame.camera.x, frame.camera.y, frame.camera.k)
    gl.uniform3f(u.lens, frame.lens.tilt, frame.lens.yaw, frame.lens.focal)
    gl.uniform2f(u.viewport, width, height)
    gl.uniform1f(u.dpr, frame.dpr)
    gl.uniform1f(u.time, frame.time)
    gl.uniform1f(u.reveal, frame.reveal)
    gl.uniform1f(u.gain, frame.gain)
    gl.uniform1f(u.extent, this.extent)
    gl.uniform1f(u.px, frame.px)
    gl.uniform4f(u.focus, frame.focus.x, frame.focus.y, Math.max(1, frame.focus.r), frame.focus.strength)
    gl.enable(gl.BLEND)
    if (frame.additive) gl.blendFunc(gl.ONE, gl.ONE)
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.POINTS, 0, this.count)
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.onLost)
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored)
    if (!this.lost) {
      if (this.buffer) this.gl.deleteBuffer(this.buffer)
      if (this.program) this.gl.deleteProgram(this.program)
    }
    this.buffer = null
    this.program = null
    this.uniforms = null
  }

  private init() {
    const gl = this.gl
    const program = link(gl, VERTEX, FRAGMENT)
    if (!program) return
    this.program = program
    this.buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    const bytes = FIELD_STRIDE * 4
    const attribute = (name: string, size: number, offset: number) => {
      const location = gl.getAttribLocation(program, name)
      if (location < 0) return
      gl.enableVertexAttribArray(location)
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, bytes, offset * 4)
    }
    attribute("aPos", 3, 0)
    attribute("aSize", 1, 3)
    attribute("aAlpha", 1, 4)
    attribute("aColor", 3, 5)
    attribute("aPhase", 1, 8)
    attribute("aSpeed", 1, 9)
    const at = (name: string) => gl.getUniformLocation(program, name)
    this.uniforms = {
      camera: at("uCamera"),
      lens: at("uLens"),
      viewport: at("uViewport"),
      dpr: at("uDpr"),
      time: at("uTime"),
      reveal: at("uReveal"),
      gain: at("uGain"),
      extent: at("uExtent"),
      px: at("uPx"),
      focus: at("uFocus"),
    }
    if (this.field) this.setField(this.field)
  }

  private onLost = (event: Event) => {
    event.preventDefault()
    this.lost = true
    this.program = null
    this.buffer = null
    this.uniforms = null
  }

  private onRestored = () => {
    this.lost = false
    this.init()
  }
}

function link(gl: WebGLRenderingContext, vertexSource: string, fragmentSource: string): WebGLProgram | null {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader)
      return null
    }
    return shader
  }
  const vertex = compile(gl.VERTEX_SHADER, vertexSource)
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource)
  const program = vertex && fragment ? gl.createProgram() : null
  if (!program || !vertex || !fragment) return null
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}
