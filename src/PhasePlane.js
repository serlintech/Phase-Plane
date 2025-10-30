import React from "react";
import "katex/dist/katex.min.css";
import { create, all } from "mathjs";
import ConsolePanel from "./components/ConsolePanel";

// Lightweight canvas-based phase portrait with param sliders + terminal console.
// Focus: param detection (mu or μ), KaTeX console (no spam), nullclines, vector field, click-to-trace.

const math = create(all, {});
const RESERVED = new Set(["x", "y", "t", "e", "pi"]);
const toAscii = (s) => s.replace(/\u03BC/g, "mu"); // map Greek μ -> mu

function symbolNames(node) {
  const out = new Set();
  if (node?.traverse) {
    node.traverse((n) => {
      if (n.isSymbolNode && !RESERVED.has(n.name)) out.add(n.name);
    });
  }
  return Array.from(out);
}

function useLogs() {
  const [logs, setLogs] = React.useState([]);
  const push = (type, text) =>
    setLogs((L) => {
      const last = L[L.length - 1];
      if (last && last.type === type && last.text === text) return L; // de-dupe consecutive
      return [...L.slice(-400), { type, text, ts: Date.now() }];
    });
  const line = (t) => push("text", t);
  const latex = (t) => push("latex", t);
  const error = (t) => push("text", `Error: ${t}`);
  return { logs, line, latex, error };
}

// Simple numeric helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

export default function PhasePlane() {
  // Inputs
  const [exprX, setExprX] = React.useState("mu*x - x^2 - y");
  const [exprY, setExprY] = React.useState("x + mu*y - y^3");
  const [domain, setDomain] = React.useState({ xMin: -3, xMax: 3, yMin: -3, yMax: 3 });
  const [gridN, setGrid] = React.useState(40);
  const [params, setParams] = React.useState({});
  const [paramDefs, setParamDefs] = React.useState({});
  const [compiled, setCompiled] = React.useState(null);
  const [dx, setDx] = React.useState(null); // derivatives
  const [dy, setDy] = React.useState(null);
  const [anim, setAnim] = React.useState({ enabled: false, key: null, speed: 0.4, min: -3, max: 3 });
  const [seeds, setSeeds] = React.useState([]); // trajectory seeds
  const canvasRef = React.useRef(null);

  const scopeBase = React.useMemo(() => ({ t: 0, e: Math.E, pi: Math.PI }), []);
  const { logs, line, latex, error } = useLogs();

  // Parse & compile when exprs change
  React.useEffect(() => {
    try {
      const fx = toAscii(exprX);
      const gy = toAscii(exprY);
      const nodeX = math.parse(fx);
      const nodeY = math.parse(gy);
      // detect symbols -> params
      const syms = [...new Set([...symbolNames(nodeX), ...symbolNames(nodeY)])];
      syms.forEach((k) => {
        if (!(k in params)) setParams((p) => ({ ...p, [k]: 1 }));
        if (!(k in paramDefs)) setParamDefs((d) => ({ ...d, [k]: { min: -3, max: 3, step: 0.1 } }));
      });
      const compiledX = nodeX.compile();
      const compiledY = nodeY.compile();
      // derivatives w.r.t x,y for Jacobian & Newton
      const dfxdx = math.derivative(nodeX, "x").compile();
      const dfxdy = math.derivative(nodeX, "y").compile();
      const dfgdx = math.derivative(nodeY, "x").compile();
      const dfgdy = math.derivative(nodeY, "y").compile();

      setCompiled({ nodeX, nodeY, compiledX, compiledY });
      setDx({ dfxdx, dfxdy });
      setDy({ dfgdx, dfgdy });
      latex(`\\text{Parsed } f=${nodeX.toTex()}\\;,\\; g=${nodeY.toTex()}`);
    } catch (e) {
      setCompiled(null);
      setDx(null);
      setDy(null);
      error(e.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exprX, exprY]);

  const evalFG = React.useCallback((x, y, t = 0) => {
    if (!compiled) return [0, 0];
    try {
      const scope = { ...scopeBase, x, y, t, ...params };
      return [Number(compiled.compiledX.evaluate(scope)), Number(compiled.compiledY.evaluate(scope))];
    } catch {
      return [NaN, NaN];
    }
  }, [compiled, params, scopeBase]);

  const jacobianAt = React.useCallback((x, y) => {
    if (!dx || !dy) return [[0, 0], [0, 0]];
    const scope = { ...scopeBase, x, y, ...params };
    const a = Number(dx.dfxdx.evaluate(scope));
    const b = Number(dx.dfxdy.evaluate(scope));
    const c = Number(dy.dfgdx.evaluate(scope));
    const d = Number(dy.dfgdy.evaluate(scope));
    return [[a, b], [c, d]];
  }, [dx, dy, params, scopeBase]);

  // Parameter animation
  React.useEffect(() => {
    if (!anim.enabled || !anim.key) return;
    let raf = 0,
      last = performance.now();
    const { min, max, speed } = anim;
    const span = (max - min) || 1;
    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setParams((p) => {
        const cur = (p[anim.key] ?? 0) + speed * dt * span;
        let v = min + (((cur - min) % span) + span) % span; // wrap
        return { ...p, [anim.key]: v };
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [anim]);

  // Draw vector field + nullclines + seeds
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const { xMin, xMax, yMin, yMax } = domain;
    const x2px = (x) => ((x - xMin) / (xMax - xMin)) * w;
    const y2px = (y) => (1 - (y - yMin) / (yMax - yMin)) * h;
    const px2x = (px) => (px / w) * (xMax - xMin) + xMin;
    const px2y = (py) => (1 - py / h) * (yMax - yMin) + yMin;

    // vector field
    const N = gridN;
    ctx.save();
    ctx.globalAlpha = 0.35;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = lerp(xMin, xMax, i / (N - 1));
        const y = lerp(yMin, yMax, j / (N - 1));
        const [u, v] = evalFG(x, y);
        if (!isFinite(u) || !isFinite(v)) continue;
        const m = Math.hypot(u, v) || 1e-6;
        const scale = 0.6 * Math.min(w, h) / (N * 4);
        const dxv = (u / m) * scale;
        const dyv = (v / m) * scale;
        const px = x2px(x);
        const py = y2px(y);
        // arrow
        ctx.beginPath();
        ctx.moveTo(px - dxv, py - dyv);
        ctx.lineTo(px + dxv, py + dyv);
        ctx.strokeStyle = "#94a3b8";
        ctx.lineWidth = 1.2;
        ctx.stroke();
        // head
        const ang = Math.atan2(dyv, dxv);
        const head = 3;
        ctx.beginPath();
        ctx.moveTo(px + dxv, py + dyv);
        ctx.lineTo(px + dxv - head * Math.cos(ang - Math.PI / 6), py + dyv - head * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(px + dxv - head * Math.cos(ang + Math.PI / 6), py + dyv - head * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = "#94a3b8";
        ctx.fill();
      }
    }
    ctx.restore();

    // axes
    ctx.save();
    ctx.strokeStyle = "#475569";
    ctx.lineWidth = 1;
    // x-axis
    const y0 = y2px(0);
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(w, y0);
    ctx.stroke();
    // y-axis
    const x0 = x2px(0);
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    ctx.lineTo(x0, h);
    ctx.stroke();
    ctx.restore();

    // nullclines via coarse sampling & contour-ish lines
    function drawNullcline(which = "f") {
      const M = 120;
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = which === "f" ? "#22d3ee" : "#f472b6";
      // marching squares-ish: sample and connect zero-crossings in a grid
      const vals = new Array(M + 1);
      for (let i = 0; i <= M; i++) {
        vals[i] = new Array(M + 1);
        for (let j = 0; j <= M; j++) {
          const x = lerp(xMin, xMax, i / M);
          const y = lerp(yMin, yMax, j / M);
          const [u, v] = evalFG(x, y);
          vals[i][j] = which === "f" ? u : v;
        }
      }
      const eps = (xMax - xMin + yMax - yMin) / 400;
      for (let i = 0; i < M; i++) {
        for (let j = 0; j < M; j++) {
          // check if sign changes across cell edges
          const c00 = vals[i][j], c10 = vals[i+1][j], c01 = vals[i][j+1], c11 = vals[i+1][j+1];
          const hasZero =
            Math.sign(c00) !== Math.sign(c10) ||
            Math.sign(c00) !== Math.sign(c01) ||
            Math.sign(c11) !== Math.sign(c10) ||
            Math.sign(c11) !== Math.sign(c01) ||
            Math.abs(c00) < eps || Math.abs(c10) < eps || Math.abs(c01) < eps || Math.abs(c11) < eps;
          if (hasZero) {
            // draw cell outline in light color
            const xA = x2px(lerp(xMin, xMax, i / M));
            const yA = y2px(lerp(yMin, yMax, j / M));
            const xB = x2px(lerp(xMin, xMax, (i + 1) / M));
            const yB = y2px(lerp(yMin, yMax, (j + 1) / M));
            ctx.beginPath();
            ctx.moveTo(xA, yA);
            ctx.lineTo(xB, yA);
            ctx.lineTo(xB, yB);
            ctx.lineTo(xA, yB);
            ctx.closePath();
            ctx.stroke();
          }
        }
      }
      ctx.restore();
    }

    drawNullcline("f");
    drawNullcline("g");

    // trajectories
    function integrate(x0, y0, dir = +1, steps = 2000, hstep = 0.01) {
      let x = x0, y = y0;
      const pts = [];
      for (let k = 0; k < steps; k++) {
        const [u, v] = evalFG(x, y);
        if (!isFinite(u) || !isFinite(v)) break;
        // RK2 (midpoint) for a bit more stability
        const mx = x + 0.5 * dir * hstep * u;
        const my = y + 0.5 * dir * hstep * v;
        const [uu, vv] = evalFG(mx, my);
        x += dir * hstep * uu;
        y += dir * hstep * vv;
        if (x < xMin - 1 || x > xMax + 1 || y < yMin - 1 || y > yMax + 1) break;
        pts.push([x, y]);
      }
      return pts;
    }

    ctx.save();
    ctx.lineWidth = 2;
    seeds.forEach((s) => {
      // forward
      let pts = integrate(s[0], s[1], +1, 800, 0.01);
      // backward
      const ptsB = integrate(s[0], s[1], -1, 800, 0.01).reverse();
      pts = ptsB.concat([[s[0], s[1]]], pts);
      // draw with arrows along
      ctx.strokeStyle = "#eab308";
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const px = x2px(x), py = y2px(y);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // arrowheads sparsely
      for (let i = 15; i < pts.length; i += 25) {
        const [x1, y1] = pts[i - 1];
        const [x2, y2] = pts[i];
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const px = x2px(x2), py = y2px(y2);
        const head = 4;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - head * Math.cos(ang - Math.PI / 6), py - head * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(px - head * Math.cos(ang + Math.PI / 6), py - head * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fillStyle = "#eab308";
        ctx.fill();
      }
    });
    ctx.restore();

    // pointer handler
    const onClick = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const px = evt.clientX - rect.left;
      const py = evt.clientY - rect.top;
      const x = px2x(px);
      const y = px2y(py);
      setSeeds((S) => [...S, [x, y]]);
    };
    canvas.addEventListener("click", onClick);
    return () => canvas.removeEventListener("click", onClick);
  }, [compiled, params, domain, gridN, seeds, anim, dx, dy, evalFG]);

  // Console command handler
  const onCommand = (s) => {
    const [c, ...rest] = s.trim().split(/\s+/);
    if (c === "help") {
      return line("commands: set <param> <value> | grid <N> | bounds xMin xMax yMin yMax | clear");
    }
    if (c === "clear") {
      // clear logs
      return window.location.reload();
    }
    if (c === "set" && rest.length === 2) {
      const [name, val] = rest;
      if (!(name in params)) return line(`unknown param "${name}"`);
      const num = Number(val);
      if (!Number.isFinite(num)) return line("value must be a number");
      setParams((p) => ({ ...p, [name]: num }));
      return;
    }
    if (c === "grid" && rest.length === 1) {
      const n = Number(rest[0]);
      if (!Number.isInteger(n) || n < 8 || n > 200) return line("grid must be 8..200");
      setGrid(n);
      return;
    }
    if (c === "bounds" && rest.length === 4) {
      const [a, b, c1, d] = rest.map(Number);
      if ([a, b, c1, d].some((v) => !Number.isFinite(v)) || a >= b || c1 >= d) return line("bad bounds");
      setDomain({ xMin: a, xMax: b, yMin: c1, yMax: d });
      return;
    }
    line("unknown command (help)");
  };

  // Fixed points (coarse) + Jacobian report (in console)
  React.useEffect(() => {
    if (!compiled || !dx || !dy) return;
    if (anim?.enabled) return; // skip verbose logging during animation
    const { xMin, xMax, yMin, yMax } = domain;
    // coarse scan for near zeros
    const M = 30;
    const near = [];
    for (let i = 0; i <= M; i++) {
      for (let j = 0; j <= M; j++) {
        const x = lerp(xMin, xMax, i / M);
        const y = lerp(yMin, yMax, j / M);
        const [u, v] = evalFG(x, y);
        if (!isFinite(u) || !isFinite(v)) continue;
        const m = Math.hypot(u, v);
        if (m < 1e-2) near.push([x, y]);
      }
    }
    // unique cluster
    const uniq = [];
    for (const p of near) {
      if (!uniq.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.2)) uniq.push(p);
    }
    // Newton refine
    const refined = [];
    for (const [x0, y0] of uniq) {
      let x = x0, y = y0;
      for (let it = 0; it < 20; it++) {
        const [u, v] = evalFG(x, y);
        const J = jacobianAt(x, y);
        const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        if (Math.abs(det) < 1e-8) break;
        // solve J * delta = -F
        const dxn = (-u * J[1][1] + v * J[0][1]) / det;
        const dyn = (-v * J[0][0] + u * J[1][0]) / det;
        x += dxn; y += dyn;
        if (Math.hypot(dxn, dyn) < 1e-6) break;
      }
      if (isFinite(x) && isFinite(y)) refined.push([x, y]);
    }
    // unique again tighter
    const fixed = [];
    for (const p of refined) {
      if (!fixed.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3)) fixed.push(p);
    }

    // Report
    const fTex = compiled.nodeX.toTex();
    const gTex = compiled.nodeY.toTex();
    latex(`\\text{Nullclines: }\\; f(x,y)=0:\\; ${fTex}=0\\quad g(x,y)=0:\\; ${gTex}=0`);
    if (fixed.length === 0) {
      latex(`\\text{Fixed points: none detected in domain.}`);
      return;
    }
    latex(`\\text{Fixed points (approx): } ${fixed.map((p) => `(${p[0].toFixed(3)},\\;${p[1].toFixed(3)})`).join(",\\;")}`);
    for (const [x, y] of fixed) {
      const J = jacobianAt(x, y);
      const tr = J[0][0] + J[1][1];
      const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
      const disc = tr * tr - 4 * det;
      if (disc >= 0) {
        const l1 = 0.5 * (tr + Math.sqrt(disc));
        const l2 = 0.5 * (tr - Math.sqrt(disc));
        latex(`J(${x.toFixed(3)},${y.toFixed(3)})=\\begin{pmatrix}${J[0][0].toFixed(3)}&${J[0][1].toFixed(3)}\\\\${J[1][0].toFixed(3)}&${J[1][1].toFixed(3)}\\end{pmatrix},\\; \\operatorname{tr}=${tr.toFixed(3)},\\; \\det=${det.toFixed(3)},\\; \\lambda_{1,2}=${l1.toFixed(3)},\\;${l2.toFixed(3)}`);
      } else {
        const re = 0.5 * tr;
        const im = 0.5 * Math.sqrt(-disc);
        latex(`J(${x.toFixed(3)},${y.toFixed(3)})=\\begin{pmatrix}${J[0][0].toFixed(3)}&${J[0][1].toFixed(3)}\\\\${J[1][0].toFixed(3)}&${J[1][1].toFixed(3)}\\end{pmatrix},\\; \\operatorname{tr}=${tr.toFixed(3)},\\; \\det=${det.toFixed(3)},\\; \\lambda= ${re.toFixed(3)}\\pm ${im.toFixed(3)}i`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compiled, params, domain, evalFG, jacobianAt]);

  // UI

  return (
    <div className="bg-slate-900 text-slate-100 pt-4 px-4 pb-0">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 bg-slate-800/60 rounded-2xl p-3">
          <div className="flex items-center justify-between mb-3 gap-2">
            <div className="text-slate-200 font-semibold">Phase Plane</div>
            <div className="text-xs text-slate-400">click canvas to add a trajectory seed</div>
          </div>
          <div className="relative">
            <canvas ref={canvasRef} width={900} height={700} className="w-full rounded-xl bg-slate-950 border border-slate-700" />
            <div className="absolute top-3 left-3 bg-slate-900/70 backdrop-blur-md rounded-lg px-3 py-2 text-xs border border-slate-700 flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span>ẋ=</span>
                <input
                  className="w-56 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  value={exprX}
                  onChange={(e) => setExprX(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <span>ẏ=</span>
                <input
                  className="w-56 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  value={exprY}
                  onChange={(e) => setExprY(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="opacity-70">bounds</span>
                <input
                  title="xMin"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domain.xMin}
                  onChange={(e) => setDomain((d) => ({ ...d, xMin: Number(e.target.value) }))}
                />
                <input
                  title="xMax"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domain.xMax}
                  onChange={(e) => setDomain((d) => ({ ...d, xMax: Number(e.target.value) }))}
                />
                <input
                  title="yMin"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domain.yMin}
                  onChange={(e) => setDomain((d) => ({ ...d, yMin: Number(e.target.value) }))}
                />
                <input
                  title="yMax"
                  className="w-16 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  type="number"
                  value={domain.yMax}
                  onChange={(e) => setDomain((d) => ({ ...d, yMax: Number(e.target.value) }))}
                />
                <label className="text-xs text-slate-300">grid
                  <input
                    className="ml-2 w-20 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                    type="number"
                    value={gridN}
                    min={8}
                    max={200}
                    onChange={(e) => setGrid(clamp(Number(e.target.value)||40, 8, 200))}
                  />
                </label>
                <button
                  className="ml-2 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600"
                  title="Add a random seed"
                  onClick={() => {
                    const x = lerp(domain.xMin, domain.xMax, Math.random());
                    const y = lerp(domain.yMin, domain.yMax, Math.random());
                    setSeeds((S) => [...S, [x, y]]);
                  }}
                >
                  Seed
                </button>
                <button
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 border border-slate-600"
                  title="Clear seeds"
                  onClick={() => setSeeds([])}
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="md:col-span-1 space-y-4">
          <div className="bg-slate-800/60 rounded-2xl p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300 font-medium">Parameters</span>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={anim.enabled}
                    onChange={(e) => setAnim((a) => ({ ...a, enabled: e.target.checked }))}
                  />
                  Animate
                </label>
                <select
                  className="text-xs bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                  value={anim.key ?? ""}
                  onChange={(e) => setAnim((a) => ({ ...a, key: e.target.value || null }))}
                >
                  <option value="">(param)</option>
                  {Object.keys(params).map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <label className="text-xs text-slate-300">
                  speed
                  <input
                    className="ml-2 w-24 bg-slate-900/60 rounded px-2 py-1 border border-slate-700"
                    type="number"
                    step="0.1"
                    value={anim.speed}
                    onChange={(e) => setAnim((a) => ({ ...a, speed: Number(e.target.value) || 0 }))}
                    disabled={!anim.key}
                  />
                </label>
              </div>
            </div>

            <div className="mt-2 space-y-3">
              {Object.keys(params).length === 0 && (
                <div className="text-xs text-slate-400">
                  No free parameters detected. Use symbols like <code>mu</code> or Greek <code>μ</code> in f,g.
                </div>
              )}
              {Object.keys(params).map((k) => {
                const def = paramDefs[k] ?? { min: -3, max: 3, step: 0.1 };
                return (
                  <div key={k} className="flex items-center gap-3">
                    <div className="w-10 text-xs text-slate-300">{k}</div>
                    <input
                      className="flex-1"
                      type="range"
                      min={def.min}
                      max={def.max}
                      step={def.step}
                      value={params[k]}
                      onChange={(e) => setParams((p) => ({ ...p, [k]: Number(e.target.value) }))}
                    />
                    <input
                      className="w-24 bg-slate-900/60 rounded px-2 py-1 border border-slate-700 text-sm"
                      type="number"
                      step={def.step}
                      value={params[k]}
                      onChange={(e) => setParams((p) => ({ ...p, [k]: Number(e.target.value) }))}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <ConsolePanel logs={logs} onCommand={onCommand} />
        </div>
      </div>
    </div>
  );
}
