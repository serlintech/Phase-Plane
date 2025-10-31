/* eslint-env worker */
/* global self */
import { create, all } from "mathjs";

const workerScope = typeof self === "object" && self ? self : null;
if (!workerScope || typeof workerScope.addEventListener !== "function" || typeof workerScope.postMessage !== "function") {
  throw new Error("Phase worker running without a valid worker global scope.");
}

const math = create(all, {});
const RESERVED = new Set(["x", "y", "t", "e", "pi"]);
const scopeBase = { t: 0, e: Math.E, pi: Math.PI };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const toAscii = (s) => (s || "").replace(/\u03BC/g, "mu");

function symbolNames(node) {
  const out = new Set();
  if (node?.traverse) {
    node.traverse((n) => {
      if (n.isSymbolNode && !RESERVED.has(n.name)) out.add(n.name);
    });
  }
  return Array.from(out);
}

function safeEvaluate(compiled, scope) {
  try {
    return Number(compiled.evaluate(scope));
  } catch (err) {
    return NaN;
  }
}

function approxEqualPoint(a, b, eps = 1e-6) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
}

const cache = {
  exprX: null,
  exprY: null,
  compiled: null,
};

function getCompiled(exprX, exprY) {
  if (cache.exprX === exprX && cache.exprY === exprY && cache.compiled) {
    return cache.compiled;
  }
  const fx = toAscii(exprX);
  const gy = toAscii(exprY);
  const nodeX = math.parse(fx);
  const nodeY = math.parse(gy);
  const compiledX = nodeX.compile();
  const compiledY = nodeY.compile();
  const dfxdx = math.derivative(nodeX, "x").compile();
  const dfxdy = math.derivative(nodeX, "y").compile();
  const dfgdx = math.derivative(nodeY, "x").compile();
  const dfgdy = math.derivative(nodeY, "y").compile();
  const symbols = [...new Set([...symbolNames(nodeX), ...symbolNames(nodeY)])].sort();
  cache.exprX = exprX;
  cache.exprY = exprY;
  cache.compiled = {
    nodeX,
    nodeY,
    compiledX,
    compiledY,
    dfxdx,
    dfxdy,
    dfgdx,
    dfgdy,
    requiredParams: symbols,
  };
  return cache.compiled;
}

function evalFG(compiled, params, x, y, t = 0) {
  const scope = { ...scopeBase, ...params, x, y, t };
  const u = safeEvaluate(compiled.compiledX, scope);
  const v = safeEvaluate(compiled.compiledY, scope);
  if (!Number.isFinite(u) || !Number.isFinite(v)) return [NaN, NaN];
  return [u, v];
}

function jacobianAt(compiled, params, x, y) {
  const scope = { ...scopeBase, ...params, x, y };
  const a = safeEvaluate(compiled.dfxdx, scope);
  const b = safeEvaluate(compiled.dfxdy, scope);
  const c = safeEvaluate(compiled.dfgdx, scope);
  const d = safeEvaluate(compiled.dfgdy, scope);
  return [
    [Number.isFinite(a) ? a : NaN, Number.isFinite(b) ? b : NaN],
    [Number.isFinite(c) ? c : NaN, Number.isFinite(d) ? d : NaN],
  ];
}

function buildPolylines(segments) {
  const polylines = [];
  const used = new Array(segments.length).fill(false);
  const adjacency = new Map();

  const pointKey = (p) => `${Math.round(p[0] * 1e6)}:${Math.round(p[1] * 1e6)}`;

  segments.forEach((seg, idx) => {
    const [a, b] = seg;
    const ka = pointKey(a);
    const kb = pointKey(b);
    if (!adjacency.has(ka)) adjacency.set(ka, []);
    if (!adjacency.has(kb)) adjacency.set(kb, []);
    adjacency.get(ka).push(idx);
    adjacency.get(kb).push(idx);
  });

  const extend = (startPoint, forward, polyline) => {
    let current = startPoint;
    while (true) {
      const opts = adjacency.get(pointKey(current)) || [];
      let foundIdx = -1;
      let nextPoint = null;
      for (const idx of opts) {
        if (used[idx]) continue;
        const [p0, p1] = segments[idx];
        if (approxEqualPoint(current, p0)) {
          foundIdx = idx;
          nextPoint = p1;
          break;
        }
        if (approxEqualPoint(current, p1)) {
          foundIdx = idx;
          nextPoint = p0;
          break;
        }
      }
      if (foundIdx === -1 || !nextPoint) break;
      used[foundIdx] = true;
      if (forward) polyline.push(nextPoint);
      else polyline.unshift(nextPoint);
      current = nextPoint;
    }
  };

  segments.forEach((seg, idx) => {
    if (used[idx]) return;
    used[idx] = true;
    const polyline = [seg[0], seg[1]];
    extend(polyline[polyline.length - 1], true, polyline);
    extend(polyline[0], false, polyline);
    polylines.push(polyline);
  });

  return polylines;
}

function computeNullcline(which, compiled, params, domain, gridN) {
  const { xMin, xMax, yMin, yMax } = domain;
  const M = Math.max(80, Math.min(200, Math.floor(gridN * 2.5)));
  const values = new Array(M + 1);
  const dxCell = (xMax - xMin) / M;
  const dyCell = (yMax - yMin) / M;

  for (let i = 0; i <= M; i++) {
    values[i] = new Array(M + 1);
    for (let j = 0; j <= M; j++) {
      const x = xMin + i * dxCell;
      const y = yMin + j * dyCell;
      const [u, v] = evalFG(compiled, params, x, y);
      values[i][j] = which === "f" ? u : v;
    }
  }

  const valEps = 1e-9;
  const segments = [];
  const pointKey = (p) => `${Math.round(p[0] * 1e6)}:${Math.round(p[1] * 1e6)}`;

  const edgePoint = (i, j, edge) => {
    const x0 = xMin + i * dxCell;
    const x1 = xMin + (i + 1) * dxCell;
    const y0 = yMin + j * dyCell;
    const y1 = yMin + (j + 1) * dyCell;
    switch (edge) {
      case 0: {
        const v0 = values[i][j];
        const v1 = values[i + 1][j];
        const denom = v0 - v1;
        const t = clamp(Math.abs(denom) < valEps ? 0.5 : v0 / denom, 0, 1);
        return [lerp(x0, x1, t), y0];
      }
      case 1: {
        const v0 = values[i + 1][j];
        const v1 = values[i + 1][j + 1];
        const denom = v0 - v1;
        const t = clamp(Math.abs(denom) < valEps ? 0.5 : v0 / denom, 0, 1);
        return [x1, lerp(y0, y1, t)];
      }
      case 2: {
        const v0 = values[i][j + 1];
        const v1 = values[i + 1][j + 1];
        const denom = v0 - v1;
        const t = clamp(Math.abs(denom) < valEps ? 0.5 : v0 / denom, 0, 1);
        return [lerp(x0, x1, t), y1];
      }
      case 3: {
        const v0 = values[i][j];
        const v1 = values[i][j + 1];
        const denom = v0 - v1;
        const t = clamp(Math.abs(denom) < valEps ? 0.5 : v0 / denom, 0, 1);
        return [x0, lerp(y0, y1, t)];
      }
      default:
        return [x0, y0];
    }
  };

  const crosses = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (Math.abs(a) < valEps && Math.abs(b) < valEps) return true;
    if (Math.abs(a) < valEps || Math.abs(b) < valEps) return true;
    return a * b < 0;
  };

  for (let i = 0; i < M; i++) {
    for (let j = 0; j < M; j++) {
      const c00 = values[i][j];
      const c10 = values[i + 1][j];
      const c11 = values[i + 1][j + 1];
      const c01 = values[i][j + 1];
      const pts = [];
      if (crosses(c00, c10)) pts.push({ edge: 0, point: edgePoint(i, j, 0) });
      if (crosses(c10, c11)) pts.push({ edge: 1, point: edgePoint(i, j, 1) });
      if (crosses(c01, c11)) pts.push({ edge: 2, point: edgePoint(i, j, 2) });
      if (crosses(c00, c01)) pts.push({ edge: 3, point: edgePoint(i, j, 3) });
      if (pts.length === 0) continue;
      const counts = new Map();
      const uniquePts = [];
      for (const entry of pts) {
        const key = pointKey(entry.point);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (!uniquePts.some((u) => approxEqualPoint(u.point, entry.point))) {
          uniquePts.push({ ...entry, key });
        }
      }
      if (uniquePts.length === 2) {
        segments.push([uniquePts[0].point, uniquePts[1].point]);
      } else if (uniquePts.length === 3) {
        const hub = uniquePts.find((u) => (counts.get(u.key) ?? 0) > 1);
        if (hub) {
          uniquePts.forEach((u) => {
            if (u === hub) return;
            segments.push([hub.point, u.point]);
          });
        } else {
          uniquePts
            .sort((a, b) => a.edge - b.edge)
            .reduce((prev, curr) => {
              if (prev) segments.push([prev.point, curr.point]);
              return curr;
            }, null);
        }
      } else if (uniquePts.length === 4) {
        const xc = xMin + (i + 0.5) * dxCell;
        const yc = yMin + (j + 0.5) * dyCell;
        const [uf, vf] = evalFG(compiled, params, xc, yc);
        const centerVal = which === "f" ? uf : vf;
        const ordered = uniquePts.slice().sort((a, b) => a.edge - b.edge);
        if (centerVal > 0) {
          segments.push([ordered[0].point, ordered[1].point]);
          segments.push([ordered[2].point, ordered[3].point]);
        } else {
          segments.push([ordered[0].point, ordered[3].point]);
          segments.push([ordered[1].point, ordered[2].point]);
        }
      }
    }
  }

  const polylines = buildPolylines(segments);
  return { segments, polylines };
}

function refinePoint(compiled, params, x0, y0) {
  let x = x0;
  let y = y0;
  for (let it = 0; it < 25; it++) {
    const [u, v] = evalFG(compiled, params, x, y);
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    const J = jacobianAt(compiled, params, x, y);
    const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
    const dxn = (-u * J[1][1] + v * J[0][1]) / det;
    const dyn = (-v * J[0][0] + u * J[1][0]) / det;
    x += dxn;
    y += dyn;
    if (Math.hypot(dxn, dyn) < 1e-9) break;
  }
  const [uf, vf] = evalFG(compiled, params, x, y);
  if (!Number.isFinite(uf) || !Number.isFinite(vf) || Math.hypot(uf, vf) > 1e-5) return null;
  return [x, y];
}

function integrateTrajectory(compiled, params, domain, x0, y0, dir = +1, steps = 800, hstep = 0.01) {
  let x = x0;
  let y = y0;
  const pts = [];
  const { xMin, xMax, yMin, yMax } = domain;
  for (let k = 0; k < steps; k++) {
    const [u, v] = evalFG(compiled, params, x, y);
    if (!Number.isFinite(u) || !Number.isFinite(v)) break;
    const mx = x + 0.5 * dir * hstep * u;
    const my = y + 0.5 * dir * hstep * v;
    const [uu, vv] = evalFG(compiled, params, mx, my);
    if (!Number.isFinite(uu) || !Number.isFinite(vv)) break;
    x += dir * hstep * uu;
    y += dir * hstep * vv;
    if (x < xMin - 1 || x > xMax + 1 || y < yMin - 1 || y > yMax + 1) break;
    pts.push([x, y]);
  }
  return pts;
}

workerScope.addEventListener("message", (event) => {
  const { type, payload, requestId } = event.data || {};
  if (type !== "compute") return;

  const result = {
    status: "ok",
    requiredParams: [],
    logs: [],
    reportSignature: "",
    vectorField: [],
    nullclines: { f: [], g: [] },
    equilibria: [],
    trajectories: [],
    domain: payload?.domain ?? null,
    gridN: payload?.gridN ?? 0,
  };

  try {
    const { exprX, exprY, params = {}, domain, gridN = 40, seeds = [] } = payload || {};
    if (!domain) {
      result.status = "error";
      result.message = "Domain missing";
      workerScope.postMessage({ type: "result", payload: result, requestId });
      return;
    }

    const { xMin, xMax, yMin, yMax } = domain;
    if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) {
      result.status = "invalidDomain";
      result.message = "Invalid domain bounds";
      const compiled = getCompiled(exprX, exprY);
      result.requiredParams = compiled.requiredParams;
      workerScope.postMessage({ type: "result", payload: result, requestId });
      return;
    }

    const compiled = getCompiled(exprX, exprY);
    result.requiredParams = compiled.requiredParams;

    const missingParams = compiled.requiredParams.filter((k) => !Number.isFinite(params[k]));
    if (missingParams.length > 0) {
      result.status = "missingParams";
      result.missingParams = missingParams;
      workerScope.postMessage({ type: "result", payload: result, requestId });
      return;
    }

    // Vector field
    const vectorField = [];
    for (let i = 0; i < gridN; i++) {
      for (let j = 0; j < gridN; j++) {
        const x = lerp(xMin, xMax, gridN === 1 ? 0 : i / (gridN - 1));
        const y = lerp(yMin, yMax, gridN === 1 ? 0 : j / (gridN - 1));
        const [u, v] = evalFG(compiled, params, x, y);
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        vectorField.push({ x, y, u, v });
      }
    }
    result.vectorField = vectorField;

    // Nullclines
    const nullclineF = computeNullcline("f", compiled, params, domain, gridN);
    const nullclineG = computeNullcline("g", compiled, params, domain, gridN);
    result.nullclines = {
      f: nullclineF.polylines,
      g: nullclineG.polylines,
    };

    // Intersections + refinement
    const intersections = [];
    const segTol = 1e-6;
    const segmentIntersect = (a0, a1, b0, b1) => {
      const r0 = [a1[0] - a0[0], a1[1] - a0[1]];
      const r1 = [b1[0] - b0[0], b1[1] - b0[1]];
      const det = r0[0] * r1[1] - r0[1] * r1[0];
      if (Math.abs(det) < segTol) return null;
      const diff = [b0[0] - a0[0], b0[1] - a0[1]];
      const t = (diff[0] * r1[1] - diff[1] * r1[0]) / det;
      const u = (diff[0] * r0[1] - diff[1] * r0[0]) / det;
      if (t < -segTol || t > 1 + segTol || u < -segTol || u > 1 + segTol) return null;
      return [a0[0] + t * r0[0], a0[1] + t * r0[1]];
    };

    for (const segF of nullclineF.segments) {
      for (const segG of nullclineG.segments) {
        const pt = segmentIntersect(segF[0], segF[1], segG[0], segG[1]);
        if (pt) intersections.push(pt);
      }
    }

    const refinedPoints = [];
    for (const pt of intersections) {
      const refined = refinePoint(compiled, params, pt[0], pt[1]);
      if (!refined) continue;
      if (!refinedPoints.some((q) => approxEqualPoint(q, refined, 1e-4))) {
        refinedPoints.push(refined);
      }
    }

    const Mseed = 36;
    for (let i = 0; i <= Mseed; i++) {
      for (let j = 0; j <= Mseed; j++) {
        const x = lerp(xMin, xMax, i / Mseed);
        const y = lerp(yMin, yMax, j / Mseed);
        const [u, v] = evalFG(compiled, params, x, y);
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        if (Math.hypot(u, v) < 1e-2) {
          const refined = refinePoint(compiled, params, x, y);
          if (refined && !refinedPoints.some((q) => approxEqualPoint(q, refined, 1e-4))) {
            refinedPoints.push(refined);
          }
        }
      }
    }
    result.equilibria = refinedPoints.map((p) => ({ x: p[0], y: p[1] }));

    // Logs
    const logs = [];
    const fTex = compiled.nodeX.toTex();
    const gTex = compiled.nodeY.toTex();
    logs.push({ type: "latex", text: `\\text{Parsed } f=${fTex}\\;,\\; g=${gTex}` });
    logs.push({ type: "latex", text: `\\text{Nullclines: }\\; f(x,y)=0:\\; ${fTex}=0\\quad g(x,y)=0:\\; ${gTex}=0` });
    const fmtPt = (x, y) => `(${x.toFixed(3)},\\;${y.toFixed(3)})`;
    if (refinedPoints.length === 0) {
      logs.push({ type: "latex", text: `\\text{Fixed points: none detected in domain.}` });
    } else {
      logs.push({
        type: "latex",
        text: `\\text{Fixed points (approx): } ${refinedPoints
          .map((p, i) => `P_{${i + 1}}=${fmtPt(p[0], p[1])}`)
          .join(",\\;")}`,
      });
      const classify = (tr, det, disc) => {
        if (!Number.isFinite(tr) || !Number.isFinite(det)) return "indeterminate";
        if (Math.abs(det) < 1e-10) return "degenerate";
        if (det < 0) return "saddle";
        if (disc < 0) return Math.abs(tr) < 1e-6 ? "center" : tr < 0 ? "spiral sink" : "spiral source";
        if (disc > 0) return tr < 0 ? "node sink" : "node source";
        return tr < 0 ? "degenerate sink" : "degenerate source";
      };
      for (const [x, y] of refinedPoints) {
        const J = jacobianAt(compiled, params, x, y);
        const tr = J[0][0] + J[1][1];
        const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        const disc = tr * tr - 4 * det;
        const cls = classify(tr, det, disc);
        const stability = cls.includes("sink") || cls === "center" ? (cls === "center" ? "neutral" : "stable") : cls === "saddle" ? "unstable" : tr > 0 ? "unstable" : "stable";
        if (disc >= 0) {
          const l1 = 0.5 * (tr + Math.sqrt(Math.max(0, disc)));
          const l2 = 0.5 * (tr - Math.sqrt(Math.max(0, disc)));
          logs.push({
            type: "latex",
            text: `\\text{At } ${fmtPt(x, y)}:\\; J=\\begin{pmatrix}${J[0][0].toFixed(3)}&${J[0][1].toFixed(3)}\\\\${J[1][0].toFixed(3)}&${J[1][1].toFixed(3)}\\end{pmatrix},\\; \\mathrm{tr}=${tr.toFixed(3)},\\; \\det=${det.toFixed(3)},\\; \\lambda_{1,2}=${l1.toFixed(3)}\\;${l2.toFixed(3)}\\;,\\; \\text{class: ${cls} (${stability})}`,
          });
        } else {
          const re = 0.5 * tr;
          const im = 0.5 * Math.sqrt(-disc);
          logs.push({
            type: "latex",
            text: `\\text{At } ${fmtPt(x, y)}:\\; J=\\begin{pmatrix}${J[0][0].toFixed(3)}&${J[0][1].toFixed(3)}\\\\${J[1][0].toFixed(3)}&${J[1][1].toFixed(3)}\\end{pmatrix},\\; \\mathrm{tr}=${tr.toFixed(3)},\\; \\det=${det.toFixed(3)},\\; \\lambda=${re.toFixed(3)}\\pm ${im.toFixed(3)}i\\;,\\; \\text{class: ${cls} (${stability})}`,
          });
        }
      }
    }
    result.logs = logs;

    // Trajectories
    const validSeeds = (seeds || []).filter((s) => Array.isArray(s) && s.length === 2 && s.every(Number.isFinite));
    const trajectories = [];
    for (const seed of validSeeds) {
      const [sx, sy] = seed;
      const forward = integrateTrajectory(compiled, params, domain, sx, sy, +1, 800, 0.01);
      const backward = integrateTrajectory(compiled, params, domain, sx, sy, -1, 800, 0.01).reverse();
      const combined = [...backward, [sx, sy], ...forward];
      if (combined.length > 1) {
        trajectories.push({ seed: [sx, sy], path: combined });
      }
    }
    result.trajectories = trajectories;

    const sortedParams = Object.keys(params)
      .sort()
      .map((k) => `${k}:${Number(params[k]).toFixed(3)}`)
      .join("|");
    const eqSignature = refinedPoints
      .map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`)
      .join("|");
    result.reportSignature = `${exprX}|${exprY}|${sortedParams}|${eqSignature}`;
  } catch (err) {
    result.status = "error";
    result.message = err?.message || String(err);
  }

  workerScope.postMessage({ type: "result", payload: result, requestId });
});
