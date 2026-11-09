/* The screen behind the card: real 8x8 Bayer thresholds, no libraries.
   One tone per cell, one threshold per cell, one bit per cell. */
(function () {
  'use strict';

  // The app's own table (src/core/dither-constants.ts, buildBayer).
  function buildBayer(n) {
    var m = [[0]];
    var q = [
      [0, 2],
      [3, 1],
    ];
    for (var k = 1; k < n; k *= 2) {
      var s = m.length,
        nm = [];
      for (var y = 0; y < 2 * s; y++) {
        nm.push([]);
        for (var x = 0; x < 2 * s; x++)
          nm[y][x] = m[y % s][x % s] * 4 + q[(y / s) | 0][(x / s) | 0];
      }
      m = nm;
    }
    return [].concat.apply([], m);
  }
  var BAYER = buildBayer(8);

  var LOOP = 288; // 24 seconds at 12 frames a second; a pure function of the frame
  var TAU = Math.PI * 2;

  // The logo, one value per art pixel: 0-15 tone, 16-31 tone in the night sky, 32 outside.
  var MAP = null,
    MAPW = 143,
    MAPH = 108;
  function decodeMap(j) {
    var A = '0123456789abcdef',
      B = 'hijklmnopqrstuvw';
    var out = new Uint8Array(j.w * j.h),
      p = 0,
      r = j.rle;
    for (var i = 0; i < r.length; i += 2) {
      var c = r[i],
        n = parseInt(r[i + 1], 36);
      var v = c === 'g' ? 32 : A.indexOf(c) >= 0 ? A.indexOf(c) : 16 + B.indexOf(c);
      for (var k = 0; k < n; k++) out[p++] = v;
    }
    MAPW = j.w;
    MAPH = j.h;
    return out;
  }

  // The three moons, in art pixels.
  var DISCS = [
    { x: 71.2, y: 55.5, r: 39.4 },
    { x: 53.7, y: 53.7, r: 53.9 },
    { x: 88.7, y: 53.7, r: 53.9 },
  ];

  function hash(x, y) {
    var h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return h - Math.floor(h);
  }

  function mount(root, canvas, o) {
    var ctx = canvas.getContext('2d');
    var bits = document.createElement('canvas');
    var bctx = bits.getContext('2d');
    var reduced = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    var W = 0,
      H = 0,
      cell = 8,
      cellD = 8,
      ox = 0,
      oy = 0;
    var img, pat, kind, base, nx, ny, nz, halo, twinkle, flash, stay;
    var frame = reduced ? 66 : 0,
      last = -1,
      lastTick = 0,
      raf = 0,
      dirty = true,
      seen = true;
    var dim = o.dim,
      dimTo = o.dim,
      warm = reduced ? 1 : 0,
      warmTo = reduced ? 1 : 0,
      warmAt = 0;
    var ink = o.ink,
      accent = o.accent,
      picture = o.picture,
      dots = o.dots,
      phone = !!o.phone;
    var px = null,
      py = null,
      grip = root.querySelector('.tl-grip'),
      clock = root.querySelector('.tl-now');

    function makeMask() {
      if (dots !== 'round') {
        pat = null;
        return;
      }
      var t = document.createElement('canvas');
      t.width = t.height = cellD;
      var c = t.getContext('2d'),
        m = cellD / 2;
      var g = c.createRadialGradient(m, m, 0, m, m, m);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(0.72, 'rgba(0,0,0,1)');
      g.addColorStop(0.9, 'rgba(0,0,0,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, cellD, cellD);
      pat = ctx.createPattern(t, 'repeat');
    }

    function layout() {
      var r = root.getBoundingClientRect();
      var cw = Math.max(1, r.width),
        ch = Math.max(1, r.height);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      cell = phone ? 5 : Math.max(5, Math.min(12, Math.floor(Math.min(cw / 150, ch / 112))));
      cellD = Math.round(cell * dpr);
      W = Math.ceil(cw / cell);
      H = Math.ceil(ch / cell);
      canvas.width = W * cellD;
      canvas.height = H * cellD;
      canvas.style.width = W * cell + 'px';
      canvas.style.height = H * cell + 'px';
      bits.width = W;
      bits.height = H;
      img = bctx.createImageData(W, H);
      ctx.imageSmoothingEnabled = false;
      makeMask();
      var n = W * H;
      kind = new Uint8Array(n);
      base = new Float32Array(n);
      nx = new Float32Array(n);
      ny = new Float32Array(n);
      nz = new Float32Array(n);
      halo = new Float32Array(n);
      twinkle = new Float32Array(n);
      flash = new Float32Array(n);
      stay = new Float32Array(n);
      if (phone) {
        ox = Math.round(W / 2 - DISCS[0].x);
        oy = Math.round(H * 0.25 - DISCS[0].y);
      } else {
        ox = Math.round(W / 2 - MAPW / 2);
        oy = Math.round(H / 2 - MAPH / 2);
      }
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) {
          var i = y * W + x,
            u = x - ox,
            v = y - oy;
          var val = MAP && u >= 0 && v >= 0 && u < MAPW && v < MAPH ? MAP[v * MAPW + u] : 32;
          var near = 1e9;
          for (var d = 0; d < 3; d++) {
            var D = DISCS[d],
              dd = Math.hypot(u + 0.5 - D.x, v + 0.5 - D.y) - D.r;
            if (dd < near) near = dd;
          }
          halo[i] = near > 0 ? Math.exp(-near / 11) : 0;
          var h = hash(x, y);
          twinkle[i] = h;
          if (val === 32) {
            kind[i] = 0;
            continue;
          }
          if (val >= 16) {
            kind[i] = 2;
            base[i] = (val - 16) / 15;
            continue;
          }
          kind[i] = 1;
          base[i] = val / 15;
          // Which moon is this cell on? The middle one is in front.
          var which =
            Math.hypot(u + 0.5 - DISCS[0].x, v + 0.5 - DISCS[0].y) < DISCS[0].r
              ? 0
              : u < 71
                ? 1
                : 2;
          var E = DISCS[which],
            ex = (u + 0.5 - E.x) / E.r,
            ey = (v + 0.5 - E.y) / E.r,
            rr = Math.min(1, ex * ex + ey * ey);
          nx[i] = ex;
          ny[i] = ey;
          nz[i] = Math.sqrt(1 - rr);
        }
      }
      dirty = true;
    }

    function waves(x, y, f) {
      var a = (TAU * f) / LOOP;
      var s =
        Math.sin(x * 0.09 + Math.sin(a) * 3) +
        Math.sin(y * 0.13 - Math.cos(a * 2) * 2.5) +
        Math.sin((x + y) * 0.06 + a * 3);
      return 0.12 + 0.36 * (0.5 + s / 6);
    }

    function render(f) {
      var a = 1.22 * Math.sin((TAU * f) / LOOP);
      var Lx = Math.sin(a),
        Ly = -0.3,
        Lz = Math.cos(a),
        q = Math.hypot(Lx, Ly, Lz);
      Lx /= q;
      Ly /= q;
      Lz /= q;
      var d = img.data,
        moons = picture !== 'waves' && MAP;
      var ir = ink[0] * dim,
        ig = ink[1] * dim,
        ib = ink[2] * dim;
      var ar = accent[0],
        ag = accent[1],
        ab = accent[2];
      var roll = ((f % 144) / 144) * (H + 40) - 20;
      for (var y = 0, p = 0; y < H; y++) {
        var hum = Math.max(0, 1 - Math.abs(y - roll) / 11) * 0.07;
        for (var x = 0; x < W; x++, p += 4) {
          var i = y * W + x,
            t = 0,
            k = kind[i];
          var th = (BAYER[(y & 7) * 8 + (x & 7)] + 0.5) / 64;
          if (moons) {
            if (k === 1) {
              var l = nx[i] * Lx + ny[i] * Ly + nz[i] * Lz;
              if (l < 0) l = 0;
              t = base[i] > 0.25 ? base[i] * (0.07 + 0.93 * l) : 0;
            } else if (k === 2) {
              t = base[i] * 1.2 + 0.05 * Math.sin(TAU * (f / 48 + twinkle[i]));
            } else {
              t = halo[i] * (0.36 + 0.1 * Lx) + hum;
              if (twinkle[i] > 0.993) t = 0.5 + 0.5 * Math.sin(TAU * (f / 96 + twinkle[i] * 40));
            }
          } else {
            t = waves(x, y, f) + hum;
          }
          t *= warm;
          var b = stay[i] > flash[i] ? stay[i] : flash[i];
          if (b * 1.15 > th && b > 0.02) {
            d[p] = ar;
            d[p + 1] = ag;
            d[p + 2] = ab;
            d[p + 3] = 255;
          } else if (t > th) {
            d[p] = ir;
            d[p + 1] = ig;
            d[p + 2] = ib;
            d[p + 3] = 255;
          } else {
            d[p + 3] = 0;
          }
        }
      }
      bctx.putImageData(img, 0, 0);
      ctx.globalCompositeOperation = 'copy';
      ctx.drawImage(bits, 0, 0, W * cellD, H * cellD);
      if (pat) {
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, W * cellD, H * cellD);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (grip) grip.style.left = (f / LOOP) * 100 + '%';
      if (clock) {
        var s = f / 12,
          m = Math.floor(s / 60);
        clock.textContent = m + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
      }
    }

    function tick(now) {
      raf = requestAnimationFrame(tick);
      if (!seen || document.hidden) return;
      if (now - lastTick < 40) return;
      var dt = Math.min(200, now - lastTick);
      lastTick = now;
      var want = reduced ? frame : Math.floor(now / (1000 / 12)) % LOOP;
      if (want !== last) {
        frame = want;
        last = want;
        dirty = true;
      }
      if (!reduced) {
        var live = false,
          fall = Math.pow(0.9, dt / 40);
        for (var i = 0; i < flash.length; i++) {
          if (flash[i] > 0.01) {
            flash[i] *= fall;
            live = true;
          } else if (flash[i]) flash[i] = 0;
        }
        if (live) dirty = true;
      }
      if (Math.abs(dim - dimTo) > 0.004) {
        dim += (dimTo - dim) * 0.28;
        dirty = true;
      } else if (dim !== dimTo) {
        dim = dimTo;
        dirty = true;
      }
      if (warm !== warmTo) {
        // A phosphor warm-up: the dots arrive in threshold order.
        warm = warmTo === 1 ? Math.min(1, (now - warmAt) / 1100) : 0;
        dirty = true;
      }
      if (dirty) {
        render(frame);
        dirty = false;
      }
    }

    function stamp(cx, cy, rad, val, arr) {
      var r = Math.ceil(rad);
      for (var y = cy - r; y <= cy + r; y++) {
        if (y < 0 || y >= H) continue;
        for (var x = cx - r; x <= cx + r; x++) {
          if (x < 0 || x >= W) continue;
          var d = Math.hypot(x - cx, y - cy) / rad;
          if (d >= 1) continue;
          var v = val * (1 - d * d * d),
            i = y * W + x;
          if (v > arr[i]) arr[i] = v;
        }
      }
      dirty = true;
    }

    function paint(e, rad, val) {
      var r = canvas.getBoundingClientRect();
      var scale = r.width ? (W * cell) / r.width : 1;
      var cx = Math.floor(((e.clientX - r.left) * scale) / cell);
      var cy = Math.floor(((e.clientY - r.top) * scale) / cell);
      var arr = e.buttons & 2 || reduced ? stay : flash;
      if (px !== null) {
        var steps = Math.max(Math.abs(cx - px), Math.abs(cy - py));
        for (var s = 1; s < steps; s++) {
          stamp(
            Math.round(px + ((cx - px) * s) / steps),
            Math.round(py + ((cy - py) * s) / steps),
            rad,
            val,
            arr,
          );
        }
      }
      stamp(cx, cy, rad, val, arr);
      px = cx;
      py = cy;
      if (reduced) {
        render(frame);
        dirty = false;
      }
    }

    function overControl(t) {
      return !!(t && t.closest && t.closest('.crt-help-card, .scr-sys-row, a, button'));
    }
    var brushR = phone ? 5 : 3.4;
    function move(e) {
      if (overControl(e.target) || (e.pointerType === 'touch' && !e.pressure)) {
        px = null;
        return;
      }
      paint(e, brushR, 0.92);
    }
    function down(e) {
      if (overControl(e.target)) return;
      px = null;
      // Left click flashes and fades; right-hold stays, as on the real canvas.
      paint(e, e.button === 2 ? brushR : brushR * 2.6, 1);
    }
    function leave() {
      px = null;
    }
    function menu(e) {
      if (!overControl(e.target)) e.preventDefault();
    }
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerdown', down);
    root.addEventListener('pointerleave', leave);
    root.addEventListener('contextmenu', menu);

    var ro = new ResizeObserver(function () {
      layout();
      if (reduced) {
        render(frame);
        dirty = false;
      }
    });
    ro.observe(root);
    var io = new IntersectionObserver(
      function (es) {
        seen = es[es.length - 1].isIntersecting;
      },
      { threshold: 0 },
    );
    io.observe(root);

    layout();
    if (o.mapUrl && !MAP) {
      fetch(o.mapUrl)
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          MAP = MAP || decodeMap(j);
          layout();
          if (reduced) {
            render(frame);
            dirty = false;
          }
        })
        .catch(function () {
          /* the waves still run without the logo */
        });
    }
    if (reduced) render(frame);
    raf = requestAnimationFrame(tick);

    return {
      warmUp: function () {
        warm = 0;
        warmTo = 1;
        warmAt = performance.now();
        dirty = true;
      },
      off: function () {
        warm = 0;
        warmTo = 0;
        dirty = true;
      },
      setDim: function (v) {
        dimTo = v;
        dirty = true;
      },
      set: function (n) {
        if (typeof n.phone === 'boolean' && n.phone !== phone) {
          phone = n.phone;
          brushR = phone ? 5 : 3.4;
          layout();
        }
        if (n.ink) ink = n.ink;
        if (n.accent) accent = n.accent;
        if (n.picture) picture = n.picture;
        if (n.dots && n.dots !== dots) {
          dots = n.dots;
          makeMask();
        }
        dirty = true;
      },
      reduced: reduced,
      destroy: function () {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        root.removeEventListener('pointermove', move);
        root.removeEventListener('pointerdown', down);
        root.removeEventListener('pointerleave', leave);
        root.removeEventListener('contextmenu', menu);
      },
    };
  }

  window.DTScreen = { mount: mount };
})();
