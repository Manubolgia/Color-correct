/*
  GPU version of applyCorrection() for video frames: a fragment shader that is a line-by-line port
  of color.js, plus a cheap downscaled read-back used to re-analyse the scene while exporting.
*/

var VS = '#version 300 es\n' +
  'out vec2 uv;\n' +
  'void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=vec2(p.x,1.0-p.y);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}';
// uv.y is flipped so the first row of the uploaded frame ends up at the top of the canvas.
// (The full-screen triangle covers clip space; uv runs 0..2, so the visible part is 0..1.)

var FS = '#version 300 es\n' +
  'precision highp float;\n' +
  'uniform sampler2D tex;uniform float kr,kb,gam,ct,sat,st;uniform vec3 A,B;\n' +
  'in vec2 uv;out vec4 o;\n' +
  'float tone(float x){x=pow(clamp(x,0.0,1.0),gam);float s=x*x*(3.0-2.0*x);return clamp(x+ct*(s-x),0.0,1.0);}\n' +
  'void main(){\n' +
  ' vec3 c=texture(tex,uv).rgb;\n' +
  ' vec3 x=clamp(vec3(c.r+kr*(1.0-c.r)*c.g,c.g,c.b+kb*(1.0-c.b)*c.g)*A+B,0.0,1.0);\n' +
  ' vec3 t=vec3(tone(x.r),tone(x.g),tone(x.b));\n' +
  ' float Y=dot(t,vec3(0.2126,0.7152,0.0722));\n' +
  ' t=Y+sat*(t-Y);\n' +
  ' o=vec4(clamp(c+st*(t-c),0.0,1.0),1.0);\n' +
  '}';

var IDENTITY = { kr: 0, kb: 0, A: [1, 1, 1], B: [0, 0, 0], gamma: 1, ct: 0, sat: 1, st: 0 };

export function createGLRenderer() {
  var canvas = document.createElement('canvas');
  var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  if (!gl) return null;
  function sh(type, src) {
    var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  var prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  var U = {};
  ['tex', 'kr', 'kb', 'gam', 'ct', 'sat', 'st', 'A', 'B'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
  gl.uniform1i(U.tex, 0);
  gl.bindVertexArray(gl.createVertexArray());

  var tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);

  // small render target for scene analysis
  var AW = 256, AH = 144, abuf = null;
  var atex = gl.createTexture(), fbo = gl.createFramebuffer();
  function analysisTarget(w, h) {
    var s = Math.min(1, 256 / Math.max(w, h)), aw = Math.max(1, Math.round(w * s)), ah = Math.max(1, Math.round(h * s));
    if (aw === AW && ah === AH && abuf) return;
    AW = aw; AH = ah; abuf = new Uint8Array(AW * AH * 4);
    gl.bindTexture(gl.TEXTURE_2D, atex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, AW, AH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, atex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  function setParams(p) {
    gl.uniform1f(U.kr, p.kr); gl.uniform1f(U.kb, p.kb); gl.uniform1f(U.gam, p.gamma); gl.uniform1f(U.ct, p.ct);
    gl.uniform1f(U.sat, p.sat); gl.uniform1f(U.st, p.st);
    gl.uniform3f(U.A, p.A[0], p.A[1], p.A[2]); gl.uniform3f(U.B, p.B[0], p.B[1], p.B[2]);
  }

  var w0 = 0, h0 = 0;
  return {
    kind: 'gpu',
    canvas: canvas,
    /* Upload a frame (VideoFrame, canvas, image). Must be called before analyse()/render(). */
    upload: function (src, w, h) {
      if (w !== w0 || h !== h0) { canvas.width = w0 = w; canvas.height = h0 = h; }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    /* Downscaled RGBA copy of the uploaded frame (row order is irrelevant for statistics). */
    analyse: function () {
      analysisTarget(w0, h0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, AW, AH);
      setParams(IDENTITY);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, AW, AH, gl.RGBA, gl.UNSIGNED_BYTE, abuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return abuf;
    },
    render: function (p) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.viewport(0, 0, w0, h0);
      setParams(p);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return canvas;
    },
    lost: function () { return gl.isContextLost(); },
    dispose: function () {
      var ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
      canvas.width = canvas.height = 1;
    }
  };
}
