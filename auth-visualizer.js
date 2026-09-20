/**
 * auth-visualizer.js — Utopia Kingdom login
 * Dark luxury filaments. Smooth motion, cheap shader.
 */
(function () {
  'use strict';

  try {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // ~48fps looks smooth; shader stays cheap so it doesn't hitch.
    const FRAME_MS = 1000 / 48;
    const RES_SCALE = 0.62;

    const VERT = `
      attribute vec2 a_pos;
      void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
    `;

    // Soft luminous ribbons — no fbm / grain (those caused hitching)
    const FRAG = `
      precision mediump float;
      uniform vec2 u_res;
      uniform float u_time;
      uniform vec3 u_accent;
      uniform vec3 u_accent2;

      float filament(vec2 p, float phase, float thick) {
        float y = p.y * 1.55 + phase;
        float wave = 0.52 * sin(y * 1.1 + phase * 0.65)
                   + 0.2 * sin(y * 2.35 - phase * 0.9);
        float d = abs(p.x - wave);
        float core = exp(-pow(d / thick, 2.0) * 5.5);
        float halo = exp(-pow(d / (thick * 3.6), 2.0) * 1.9);
        return core * 1.25 + halo * 0.4;
      }

      void main() {
        vec2 p = (gl_FragCoord.xy - 0.5 * u_res.xy) / min(u_res.x, u_res.y);
        float t = u_time * 0.26;

        vec3 col = vec3(0.02, 0.022, 0.035);

        float lift = exp(-3.6 * length(p * vec2(1.05, 1.2)));
        col += u_accent * lift * 0.11;

        vec2 q = p;
        q.x += 0.035 * sin(t * 0.32);
        q.y += 0.028 * cos(t * 0.26);

        float f1 = filament(q * vec2(1.04, 1.0), t * 0.85, 0.038);
        float f2 = filament(q * vec2(1.08, 1.0) + vec2(0.52, 0.0), t * 0.68 + 2.3, 0.03);

        vec3 hi = mix(u_accent, vec3(1.0), 0.26);
        col += hi * f1 * 0.68;
        col += u_accent2 * f2 * 0.48;

        float band = exp(-pow((q.y + 0.02) * 3.2, 2.0) * 2.0);
        band *= 0.6 + 0.4 * sin(q.x * 2.2 - t * 0.7);
        col += u_accent * band * 0.09;

        col += u_accent2 * 0.07 * exp(-3.4 * length(p - vec2(-0.92, 0.68)));
        col += u_accent * 0.06 * exp(-3.5 * length(p - vec2(0.92, -0.62)));

        float vig = smoothstep(1.5, 0.28, length(p * vec2(0.95, 1.06)));
        col *= 0.58 + 0.42 * vig;
        col *= 0.93;

        col = clamp(col, 0.0, 1.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `;

    function compile(gl, type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
      }
      return s;
    }

    function parseRgb(raw, fb) {
      try {
        const cleaned = String(raw || '').replace(/var\([^)]*\)/g, '').trim();
        const parts = cleaned.split(',').map((v) => parseInt(v.trim(), 10));
        if (parts.length >= 3 && parts.every(Number.isFinite)) {
          return [parts[0] / 255, parts[1] / 255, parts[2] / 255];
        }
      } catch (e) {}
      return fb;
    }

    function readCssRgb(name, fb) {
      try {
        let raw = getComputedStyle(document.body).getPropertyValue(name);
        if (!raw || raw.indexOf('var(') !== -1) {
          const probe = document.createElement('div');
          probe.style.cssText = 'display:none;color:rgb(var(' + name + '))';
          document.body.appendChild(probe);
          const c = getComputedStyle(probe).color;
          document.body.removeChild(probe);
          const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(c || '');
          if (m) return [(+m[1]) / 255, (+m[2]) / 255, (+m[3]) / 255];
        }
        return parseRgb(raw, fb);
      } catch (e) {
        return fb;
      }
    }

    class AuthDarkSilk {
      constructor() {
        this.canvas = document.getElementById('musicVisualizer');
        if (!this.canvas) return;
        this.gl = null;
        this.raf = null;
        this._running = false;
        this._last = 0;
        this._t0 = performance.now();
        this._colors = null;
        this._colorAt = 0;
        this._authCache = null;
        this._authCacheAt = 0;

        if (!this._init()) {
          this.canvas.style.display = 'none';
          return;
        }

        this.canvas.style.display = 'block';
        window.musicVisualizer = this;
        window.enableMusicViz = true;
        this._bind();
        this.resize();
        this.kick();
      }

      _init() {
        try {
          this.gl = this.canvas.getContext('webgl', {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            powerPreference: 'low-power',
            desynchronized: true,
            preserveDrawingBuffer: false
          });
        } catch (e) {
          return false;
        }
        if (!this.gl) return false;

        const gl = this.gl;
        const vs = compile(gl, gl.VERTEX_SHADER, VERT);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
        if (!vs || !fs) return false;

        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
        gl.useProgram(prog);
        this.prog = prog;

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1
        ]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        this.uRes = gl.getUniformLocation(prog, 'u_res');
        this.uTime = gl.getUniformLocation(prog, 'u_time');
        this.uAccent = gl.getUniformLocation(prog, 'u_accent');
        this.uAccent2 = gl.getUniformLocation(prog, 'u_accent2');

        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.BLEND);
        return true;
      }

      colors() {
        const now = performance.now();
        if (this._colors && now - this._colorAt < 2500) return this._colors;
        this._colors = {
          accent: readCssRgb('--accent-rgb', [0.42, 0.5, 1.0]),
          accent2: readCssRgb('--viz-base-rgb', [0.2, 0.75, 1.0])
        };
        this._colorAt = now;
        return this._colors;
      }

      _bind() {
        if (this._bound) return;
        this._bound = true;
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) this.stop();
          else this.kick();
        });
        let t = null;
        window.addEventListener('resize', () => {
          clearTimeout(t);
          t = setTimeout(() => this.kick(), 160);
        }, { passive: true });
        try {
          const auth = document.getElementById('auth-modal');
          if (auth) {
            const obs = new MutationObserver(() => {
              this._authCache = null;
              this.kick();
            });
            obs.observe(auth, { attributes: true, attributeFilter: ['class', 'style'] });
            obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
          }
        } catch (e) {}
      }

      authOpen() {
        const now = performance.now();
        if (this._authCache != null && now - this._authCacheAt < 250) return this._authCache;
        let open = false;
        try {
          if (document.body.classList.contains('auth-visible')) open = true;
          else {
            const auth = document.getElementById('auth-modal');
            if (auth && !auth.classList.contains('hidden')) {
              const s = getComputedStyle(auth);
              open = s.display !== 'none' && s.visibility !== 'hidden';
            }
          }
        } catch (e) {
          open = false;
        }
        this._authCache = open;
        this._authCacheAt = now;
        return open;
      }

      shouldRun() {
        if (document.hidden) return false;
        if (document.documentElement.classList.contains('utk-reduced-motion')) return false;
        if (document.documentElement.classList.contains('resizing')) return false;
        return this.authOpen();
      }

      resize() {
        if (!this.canvas || !this.gl) return;
        const rect = this.canvas.getBoundingClientRect();
        const w = Math.max(2, Math.round((rect.width || 800) * RES_SCALE));
        const h = Math.max(2, Math.round((rect.height || 600) * RES_SCALE));
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w;
          this.canvas.height = h;
        }
        this.gl.viewport(0, 0, w, h);
      }

      kick() {
        this.resize();
        if (this.shouldRun()) this.start();
        else this.stop();
      }

      start() {
        if (this._running) return;
        if (!this.shouldRun()) return;
        this._running = true;
        this._last = 0;
        this._loop();
      }

      stop() {
        this._running = false;
        if (this.raf) {
          cancelAnimationFrame(this.raf);
          this.raf = null;
        }
      }

      startAnimation() { this.start(); }
      stopAnimation() { this.stop(); }
      refresh() { this._colors = null; this._authCache = null; this.kick(); }

      _loop = () => {
        if (!this._running || !this.shouldRun()) {
          this._running = false;
          this.raf = null;
          return;
        }
        const now = performance.now();
        if (now - this._last >= FRAME_MS) {
          // Keep time continuous even if a frame was late (avoids stutter jumps).
          this._last = now - ((now - this._last) % FRAME_MS);
          const gl = this.gl;
          const c = this.colors();
          const t = (now - this._t0) / 1000;
          gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
          gl.uniform1f(this.uTime, t);
          gl.uniform3f(this.uAccent, c.accent[0], c.accent[1], c.accent[2]);
          gl.uniform3f(this.uAccent2, c.accent2[0], c.accent2[1], c.accent2[2]);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
        this.raf = requestAnimationFrame(this._loop);
      };
    }

    function boot() {
      try {
        if (window.musicVisualizer && window.musicVisualizer.stop) {
          try { window.musicVisualizer.stop(); } catch (e) {}
        }
        window.musicVisualizer = null;
        new AuthDarkSilk();
      } catch (e) {}
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      setTimeout(boot, 0);
    }

    try { module.exports = { maybeInitVisualizer: boot }; } catch (e) {}
  } catch (e) {}
})();
