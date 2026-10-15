// Dither pictures: dots on the dark page that shade from jade to cyan, drawn
// with WebGL.
//
// A "field" gives every pixel a brightness from 0 to 1. An 8x8 Bayer matrix
// then turns brightness into dot density: each pixel compares its brightness
// with its threshold in the matrix and draws a dot or nothing.
//
// Sleep is drawn as blur. A shape (a wordmark, a grid of tabs) is drawn into
// a texture with mipmaps; a sleeping part is read from a blurry mipmap level,
// so it breaks up into loose dots, and a waking part is read sharp.
//
//   ditherPicture(canvas, options)  one animated picture; returns its state
//   ditherImage(src, width)         a still dithered copy of an image
//   fillDitherFades()               pixel-stepped fades between sections

// The dots shade from jade (left) to cyan (right), with a slow drift.
const DITHER_GREEN = [31, 216, 164]  // jade 11
const DITHER_BLUE = [76, 204, 230]   // cyan 11
const DITHER_STILL = window.matchMedia("(prefers-reduced-motion: reduce)").matches

const PRELUDE = `#version 300 es
precision highp float;
uniform vec2 uSize;     // canvas pixels
uniform float uTime;    // seconds
uniform vec2 uPointer;  // canvas pixels, y up
uniform float uHover;   // 0 to 1
uniform vec3 uGreen;
uniform vec3 uBlue;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amplitude * noise(p);
    p = p * 2.02 + vec2(11.3, 7.7);
    amplitude *= 0.5;
  }
  return sum;
}

// The ordered-dither threshold of a pixel, from an 8x8 Bayer matrix: the
// matrix entry is the bits of (x xor y) and y interleaved in reverse. Exact
// integer math, so the threshold is always between 1/128 and 127/128 and a
// pixel with no light never gets a dot.
float bayer8(vec2 pixel) {
  ivec2 p = ivec2(pixel) & 7;
  int x = p.x ^ p.y;
  int y = p.y;
  int v = ((x & 1) << 5) | ((y & 1) << 4) | ((x & 2) << 2) | ((y & 2) << 1) | ((x & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}

float field(vec2 px);

void main() {
  float value = clamp(field(gl_FragCoord.xy), 0.0, 1.0);
  float on = step(bayer8(gl_FragCoord.xy), value);
  // Green on the left, blue on the right, the line between them wandering.
  float drift = (noise(gl_FragCoord.xy * 0.006 + vec2(uTime * 0.08, 0.0)) - 0.5) * 0.5;
  float blue = smoothstep(0.15, 0.85, gl_FragCoord.x / uSize.x + drift);
  vec3 color = mix(uGreen, uBlue, blue);
  outColor = vec4(color * on, on);
}
`

const FIELDS = {
  // A low sun behind the hero's window: an arc of light rising from the
  // bottom edge, with slow bands of haze drifting up through it.
  horizon: `
float field(vec2 px) {
  // Nothing in the top fifth, and a soft fade into it.
  float fadeTop = 1.0 - smoothstep(uSize.y * 0.56, uSize.y * 0.8, px.y);
  if (fadeTop <= 0.0) {
    return 0.0;
  }
  // The sun's top (its tip) sits at 60% of the height, just above the window.
  float tip = 0.6 * uSize.y;
  vec2 axes = vec2(0.36 * uSize.x, 1.4 * tip);
  vec2 center = vec2(0.5 * uSize.x, tip - axes.y);
  vec2 s = (px - center) / axes;
  float wobble = (fbm(vec2(atan(s.y, s.x) * 4.0, uTime * 0.05)) - 0.5) * 24.0;
  // Roughly how many pixels outside (+) or inside (-) the rim this pixel is.
  float edge = (length(s) - 1.0) * axes.y * 0.6 + wobble;
  float outside = max(edge, 0.0);
  float inside = max(-edge, 0.0);
  float rim = 0.42 * exp(-outside / 40.0) + 0.08 * exp(-outside / 120.0);
  float disc = 0.05 + 0.4 * exp(-inside / 60.0);

  // Bands of haze drifting up through the sun, closer together near the bottom.
  float depth = log(1.0 + px.y * 0.01) / 0.01;
  float sway = (fbm(vec2(px.x / 650.0, depth / 260.0 + uTime * 0.02)) - 0.5) * 1.4;
  float band = 0.5 + 0.5 * cos(6.2832 * (depth / 26.0 - uTime * 0.16 + sway));
  band = band * band * (3.0 - 2.0 * band);
  // The haze only moves inside the sun; outside it the rim fades smoothly.
  float v = edge > 0.0 ? rim : disc * (0.8 + 0.4 * band);

  vec2 d = px - uPointer;
  v *= 1.0 + 0.35 * exp(-dot(d, d) / 48000.0) * uHover;
  // smoothstep needs its edges in order, so fades that fall are 1 minus a rise.
  v *= smoothstep(0.0, 0.16, px.x / uSize.x) * (1.0 - smoothstep(0.84, 1.0, px.x / uSize.x));
  // Very faint light would dither into lone dots in lines; cut it off instead.
  return max(v * fadeTop - 0.035, 0.0);
}`,

  // A soft light with vertical streaks, behind a window in the middle.
  glow: `
float field(vec2 px) {
  vec2 uv = px / uSize;
  vec2 p = (uv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
  vec2 c = p * vec2(0.6, 1.3);
  float bloom = exp(-dot(c, c) * 2.2);
  float streaks = fbm(vec2(p.x * 20.0, p.y * 0.8 - uTime * 0.08));
  float v = bloom * (0.55 + 0.9 * smoothstep(0.3, 0.8, streaks));
  vec2 d = px - uPointer;
  v += exp(-dot(d, d) / 26000.0) * uHover * 0.3;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.18), uv) * smoothstep(vec2(0.0), vec2(0.18), 1.0 - uv);
  return v * edge.x * edge.y;
}`,

  // A shape that sleeps: blurred into loose dots, and sharp where the pointer
  // (or, with no pointer, a slow wandering focus) wakes it.
  mask: `
uniform sampler2D uMask;
float field(vec2 px) {
  vec2 uv = px / uSize;
  uv.y = 1.0 - uv.y;
  vec2 d = (px - uPointer) / uSize.y;
  float dist = length(d * vec2(0.42, 1.0)) + (fbm(uv * 3.0 + uTime * 0.25) - 0.5) * 0.3;
  float awake = 1.0 - smoothstep(0.06, 0.75, dist);
  float breathe = 0.5 + 0.5 * sin(uTime * 0.7 + uv.x * 5.0);
  float lod = mix(3.0 + breathe * 1.6, 0.0, awake * uHover);
  float m = textureLod(uMask, uv, lod).a;
  float sharp = smoothstep(0.35, 0.65, m);
  return mix(sharp, m * 1.2, clamp(lod / 2.0, 0.0, 1.0));
}`,

  // A grid of tabs, each awake or asleep on its own (uSleep, set from JS).
  tabs: `
uniform sampler2D uMask;
uniform vec2 uCells;
uniform float uSleep[12];
float field(vec2 px) {
  vec2 uv = px / uSize;
  uv.y = 1.0 - uv.y;
  vec2 cell = min(floor(uv * uCells), uCells - 1.0);
  int index = int(cell.y * uCells.x + cell.x);
  float sleep = uSleep[index];
  float lod = sleep * (3.2 + 1.0 * fbm(uv * 4.0 + uTime * 0.2));
  float m = textureLod(uMask, uv, lod).a;
  float sharp = smoothstep(0.35, 0.65, m);
  float v = mix(sharp, m * 1.25, clamp(lod / 2.0, 0.0, 1.0));
  return v * (1.0 - 0.45 * sleep);
}`,
}

const VERTEX = `#version 300 es
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`

function compileShader(gl, type, source) {
  const shader = gl.createShader(type)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader))
  }
  return shader
}

/**
 * Draws one animated dither picture into `canvas`.
 *   field       "horizon", "glow", "mask" or "tabs"
 *   resolution  canvas pixels per CSS pixel (smaller means bigger dots)
 *   drawMask    for "mask" and "tabs": draws the shape in white on a 2D canvas
 *   maskSize    [width, height] of that canvas
 *   cells       for "tabs": [columns, rows]
 * Returns { sleep }: for "tabs", set sleep[i] (0 awake to 1 asleep) to change a tab.
 */
function ditherPicture(canvas, options) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false })
  const state = { sleep: new Float32Array(12) }
  if (gl === null) {
    return state
  }
  const resolution = options.resolution ?? 1
  const program = gl.createProgram()
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, VERTEX))
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, PRELUDE + FIELDS[options.field]))
  gl.linkProgram(program)
  gl.useProgram(program)
  gl.bindVertexArray(gl.createVertexArray())

  const at = (name) => gl.getUniformLocation(program, name)
  gl.uniform3f(at("uGreen"), DITHER_GREEN[0] / 255, DITHER_GREEN[1] / 255, DITHER_GREEN[2] / 255)
  gl.uniform3f(at("uBlue"), DITHER_BLUE[0] / 255, DITHER_BLUE[1] / 255, DITHER_BLUE[2] / 255)

  if (options.drawMask !== undefined) {
    const [width, height] = options.maskSize
    const shape = document.createElement("canvas")
    shape.width = width
    shape.height = height
    options.drawMask(shape.getContext("2d"), width, height)
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, shape)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(at("uMask"), 0)
  }
  if (options.cells !== undefined) {
    gl.uniform2f(at("uCells"), options.cells[0], options.cells[1])
  }

  // The pointer, eased so the picture follows it smoothly. With no pointer
  // over a "mask" picture, a slow focus wanders across it instead.
  const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, hover: 0, targetHover: 0, inside: false }
  window.addEventListener("pointermove", (event) => {
    const box = canvas.getBoundingClientRect()
    const x = event.clientX - box.left
    const y = event.clientY - box.top
    pointer.inside = x > -80 && y > -80 && x < box.width + 80 && y < box.height + 80
    pointer.targetX = x * resolution
    pointer.targetY = (box.height - y) * resolution
  })

  function resize() {
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * resolution))
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * resolution))
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.uniform2f(at("uSize"), canvas.width, canvas.height)
  }

  const started = performance.now()
  let last = 0
  let running = false

  function draw(now) {
    const time = (now - started) / 1000
    if (options.field === "mask" && !pointer.inside) {
      pointer.targetX = canvas.width * (0.5 + 0.38 * Math.sin(time * 0.35))
      pointer.targetY = canvas.height * (0.5 + 0.2 * Math.sin(time * 0.5))
      pointer.targetHover = 1
    } else if (options.field === "mask") {
      pointer.targetHover = 1
    } else {
      pointer.targetHover = pointer.inside ? 1 : 0
    }
    pointer.x += (pointer.targetX - pointer.x) * 0.08
    pointer.y += (pointer.targetY - pointer.y) * 0.08
    pointer.hover += (pointer.targetHover - pointer.hover) * 0.06
    gl.uniform1f(at("uTime"), time)
    gl.uniform2f(at("uPointer"), pointer.x, pointer.y)
    gl.uniform1f(at("uHover"), pointer.hover)
    if (options.field === "tabs") {
      gl.uniform1fv(at("uSleep"), state.sleep)
    }
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // About 30 frames a second, and only while the picture is on screen.
  function frame(now) {
    if (!running) {
      return
    }
    if (now - last > 32) {
      last = now
      draw(now)
    }
    requestAnimationFrame(frame)
  }

  resize()
  draw(performance.now())
  window.addEventListener("resize", () => {
    resize()
    draw(performance.now())
  })
  if (!DITHER_STILL) {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries[0].isIntersecting
      if (visible && !running) {
        running = true
        requestAnimationFrame(frame)
      } else if (!visible) {
        running = false
      }
    })
    observer.observe(canvas)
  }
  return state
}

/** The 8x8 Bayer matrix as thresholds from 0 to 1, built by doubling the 2x2 one. */
function bayerMatrix(size) {
  let matrix = [[0]]
  while (matrix.length < size) {
    const n = matrix.length
    const next = []
    for (let y = 0; y < n * 2; y++) {
      next.push(new Array(n * 2))
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const v = matrix[y][x] * 4
        next[y][x] = v
        next[y][x + n] = v + 2
        next[y + n][x] = v + 3
        next[y + n][x + n] = v + 1
      }
    }
    matrix = next
  }
  const count = size * size
  return matrix.map((row) => row.map((v) => (v + 0.5) / count))
}

const BAYER8 = bayerMatrix(8)

/** A dithered copy of an image, `width` pixels wide: dots, jade to cyan, where the image has ink. */
function ditherImage(src, width) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const height = Math.round((image.height / image.width) * width)
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext("2d")
      context.drawImage(image, 0, 0, width, height)
      const pixels = context.getImageData(0, 0, width, height)
      const data = pixels.data
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          const light = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
          // Pages are mostly white: dark text and pictures should read as dots,
          // so a pixel's dot strength is how dark it is.
          const ink = Math.pow(1 - light, 0.8) * 0.9 + 0.06
          const on = ink > BAYER8[y % 8][x % 8]
          const blue = x / width
          data[i] = DITHER_GREEN[0] + (DITHER_BLUE[0] - DITHER_GREEN[0]) * blue
          data[i + 1] = DITHER_GREEN[1] + (DITHER_BLUE[1] - DITHER_GREEN[1]) * blue
          data[i + 2] = DITHER_GREEN[2] + (DITHER_BLUE[2] - DITHER_GREEN[2]) * blue
          data[i + 3] = on ? 255 : 0
        }
      }
      context.putImageData(pixels, 0, 0)
      resolve(canvas)
    }
    image.src = src
  })
}

/**
 * Fills each .dither-fade with bands that step from sparse dots of the page
 * color to solid, using the 4x4 Bayer order, like an image fading out in pixels.
 */
function fillDitherFades() {
  const bayer4 = bayerMatrix(4)
  for (const fade of document.querySelectorAll(".dither-fade")) {
    const steps = Number(fade.dataset.steps ?? 4)
    for (let step = 1; step <= steps; step++) {
      const density = step / (steps + 1)
      let rects = ""
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          if (bayer4[y][x] < density) {
            rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`
          }
        }
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" shape-rendering="crispEdges">${rects}</svg>`
      const band = document.createElement("i")
      const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
      band.style.webkitMaskImage = url
      band.style.maskImage = url
      fade.append(band)
    }
    const solid = document.createElement("i")
    solid.style.height = fade.dataset.solid ?? "0px"
    fade.append(solid)
  }
}
