/* needle/engine.js: Bayesian election-night update of the Senate forecast.
 *
 * Prior: the locked forecast's 50,000 joint draws of all 35 state margins
 * (needle/data/prior.json, from export_prior.R). Nothing is refit; the draws
 * carry the model's own national, regional and state correlation.
 *
 * Data: for each state, the counted D-minus-R margin m and the share f of the
 * expected vote counted (AP's "expected vote", eevp).
 *
 * Likelihood: the counted margin is the final margin plus an error that
 * vanishes as the count completes:
 *     m = M + (1-f) * (g_geo + g_type) + e,
 *     e      ~ N(0, s_random^2 * (1-f)/f)     which counties happen to be in
 *     g_geo  ~ N(0, (order_gap/2)^2)           counted vs. uncounted gap from
 *                                              the state's own geography
 *     g_type ~ N(0, TYPE_GAP^2), correlated    early/mail vs. Election Day
 *              across states (TYPE_RHO)        votes; same direction nationwide
 *   plus a small floor for late corrections. s_random and order_gap are per
 *   state, measured by simulating county reporting orders on 2024 county
 *   results (needle/calibration/).
 *
 * Update: the prior draws are moved to the posterior with an ensemble
 * square-root Kalman update. The posterior mean and covariance are exact
 * Gaussian conditioning on all reporting states at once (so one state's count
 * also moves its correlated neighbours), and each draw is mapped by a fixed
 * linear transform, which keeps the prior's shape and makes no random draws:
 * the needle moves only when the data move. With no data the draws are
 * returned untouched, so the needle starts exactly at the forecast.
 * Every refresh conditions the ORIGINAL prior on the CURRENT snapshot; counts
 * from successive refreshes are not independent and are never chained.
 *
 * Race calls (optional) are applied last as sign constraints by importance
 * weighting the posterior draws.
 *
 * Works in the browser (window.NeedleEngine) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NeedleEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CONFIG = {
    TYPE_GAP: 8,          // SD (pts) of the early/mail vs Election Day margin gap
    TYPE_RHO: 0.5,        // its correlation across states
    GEO_SHARE: 0.5,       // order_gap is the gap under a strongly sorted count; use half as 1 SD
    FLOOR_SD: 0.5,        // SD (pts) that never goes away: corrections, cures, provisionals
    MIN_F: 0.002,         // below this share of the vote counted, a state is ignored
    MIN_VOTES: 200,
    RCV_TRANSFER: 0.55,   // net transfer of a same-party eliminated candidate's ballots
    RCV_EXHAUST: 0.3,     // share of eliminated ballots that exhaust
    RCV_TRANSFER_SD: 0.25,
    MIN_ESS_FOR_CALLS: 2000,
  };

  // ---------------------------------------------------------------- decoding
  function b64ToBytes(b64) {
    if (typeof atob === "function") {
      const bin = atob(b64), out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, "base64"));
  }

  function loadPrior(json) {
    const n = json.n_draws, S = json.n_states, states = json.states;
    const mb = b64ToBytes(json.draws.margin_int16);
    if (mb.length !== n * S * 2) throw new Error("prior: margin block has the wrong length");
    const dv = new DataView(mb.buffer, mb.byteOffset, mb.byteLength);
    const X = new Float64Array(n * S);
    for (let k = 0; k < n * S; k++) X[k] = dv.getInt16(2 * k, true) / json.scale;
    const ncb = b64ToBytes(json.draws.nc_int8);
    if (ncb.length !== n) throw new Error("prior: non-contest block has the wrong length");
    const nc = new Int8Array(ncb.buffer, ncb.byteOffset, n).slice();
    const ib = b64ToBytes(json.draws.mt_ind_uint16_e4);
    const idv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
    const ind = new Float64Array(n);
    for (let i = 0; i < n; i++) ind[i] = idv.getUint16(2 * i, true) / 10000;

    const idx = {};
    states.forEach((s, j) => (idx[s] = j));
    for (const s of states) if (!json.races[s]) throw new Error("prior: no race entry for " + s);

    // Mean and covariance of the prior draws
    const mu = new Float64Array(S);
    for (let i = 0; i < n; i++) for (let j = 0; j < S; j++) mu[j] += X[i * S + j];
    for (let j = 0; j < S; j++) mu[j] /= n;
    const C = new Float64Array(S * S);
    const d = new Float64Array(S);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < S; j++) d[j] = X[i * S + j] - mu[j];
      for (let a = 0; a < S; a++) { const da = d[a]; for (let b = a; b < S; b++) C[a * S + b] += da * d[b]; }
    }
    for (let a = 0; a < S; a++) for (let b = a; b < S; b++) { C[a * S + b] /= (n - 1); C[b * S + a] = C[a * S + b]; }
    const eig = jacobiEigen(C, S);
    const invSqrt = fromEigen(eig, S, (l) => 1 / Math.sqrt(Math.max(l, 1e-9)));

    const mtj = idx.MT;
    const mtInd = { mean: mean(ind), var: variance(ind) };
    return { json, n, S, states, idx, X, nc, ind, mu, C, invSqrt, mtj, mtInd,
             maj: json.seats_for_majority };
  }

  // ------------------------------------------------------- linear algebra
  function jacobiEigen(A0, n) {
    const A = Float64Array.from(A0), V = new Float64Array(n * n);
    for (let i = 0; i < n; i++) V[i * n + i] = 1;
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
      if (off < 1e-22) break;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq; A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk; A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq; V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
    const vals = new Float64Array(n);
    for (let i = 0; i < n; i++) vals[i] = A[i * n + i];
    return { vals, V };
  }

  function fromEigen(eig, n, fn) {
    const out = new Float64Array(n * n), { vals, V } = eig;
    for (let k = 0; k < n; k++) {
      const g = fn(vals[k]);
      for (let a = 0; a < n; a++) { const va = V[a * n + k] * g; for (let b = 0; b < n; b++) out[a * n + b] += va * V[b * n + k]; }
    }
    return out;
  }

  function matmul(A, B, n) {
    const out = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) {
      const a = A[i * n + k]; if (a === 0) continue;
      for (let j = 0; j < n; j++) out[i * n + j] += a * B[k * n + j];
    }
    return out;
  }

  function cholesky(A, n) {
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
      let s = A[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) { if (s <= 0) throw new Error("cholesky: matrix not positive definite"); L[i * n + i] = Math.sqrt(s); }
      else L[i * n + j] = s / L[j * n + j];
    }
    return L;
  }
  function cholSolve(L, b, n) {   // solves (L L') x = b
    const y = new Float64Array(n), x = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k]; y[i] = s / L[i * n + i]; }
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i]; }
    return x;
  }

  function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
  function variance(a) { const m = mean(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return s / (a.length - 1); }

  // ------------------------------------------------------- observations
  // A state's snapshot (normalized by an adapter):
  //   { dem, rep, ind, others: [{votes, party}], total, eevp (0-100), expected,
  //     called: "D" | "R" | "I" | "O" | null }
  function observation(prior, st, snap) {
    const race = prior.json.races[st];
    if (!snap || !(snap.total >= CONFIG.MIN_VOTES)) return null;
    if (!((snap.dem || 0) + (snap.rep || 0) >= CONFIG.MIN_VOTES)) return null;
    let f = snap.eevp != null && snap.eevp > 0 ? snap.eevp / 100
          : (snap.expected > 0 ? snap.total / snap.expected : 0);
    f = Math.min(1, Math.max(0, f));
    if (f < CONFIG.MIN_F) return null;
    const D = snap.dem || 0, R = snap.rep || 0;
    let y, extraVar = 0, counted;
    if (race.ind) {
      // MT: the model's margin is D vs R between themselves; the IND is separate
      if (D + R <= 0) return null;
      y = 100 * (D - R) / (D + R);
      counted = 100 * (D - R) / snap.total;
    } else if (race.rcv) {
      // First choices only on election night. Approximate the final round:
      // eliminated candidates' ballots flow to their own party's finalist.
      let num = D - R, den = D + R, spread = 0;
      for (const o of snap.others || []) {
        const dir = o.party === "DEM" ? 1 : o.party === "GOP" ? -1 : 0;
        num += o.votes * dir * CONFIG.RCV_TRANSFER;
        den += o.votes * (1 - CONFIG.RCV_EXHAUST);
        spread += o.votes * CONFIG.RCV_TRANSFER_SD;
      }
      if (den <= 0) return null;
      y = 100 * num / den;
      extraVar = (100 * spread / den) ** 2;
      counted = 100 * (D - R) / snap.total;
    } else {
      y = 100 * (D - R) / snap.total;
      counted = y;
    }
    const u = 1 - f;
    const geo = CONFIG.GEO_SHARE * race.lik.order_gap;
    const indep = race.lik.s_random ** 2 * u / Math.max(f, 1e-6) + (geo * u) ** 2
                + CONFIG.FLOOR_SD ** 2 + extraVar;
    return { st, j: prior.idx[st], y, f, u, indep, counted, total: snap.total };
  }

  // ------------------------------------------------------- the update
  function update(prior, snapshot, opts) {
    opts = Object.assign({ useCalls: true }, opts || {});
    const { S, n, X, mu, C } = prior;
    const obs = [];
    for (const st of prior.states) {
      const o = observation(prior, st, snapshot && snapshot[st]);
      if (o) obs.push(o);
    }
    const k = obs.length;
    let post;              // posterior draws (Float64Array n*S), or the prior itself
    let muA = mu, CA = C;
    if (k === 0) {
      post = X;
    } else {
      // Innovation covariance  Sy = C[O,O] + R,  R = indep (diag) + correlated type gap
      const Sy = new Float64Array(k * k);
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
        const oa = obs[a], ob = obs[b];
        let r = (a === b ? 1 : CONFIG.TYPE_RHO) * CONFIG.TYPE_GAP ** 2 * oa.u * ob.u;
        if (a === b) r += oa.indep;
        Sy[a * k + b] = C[oa.j * S + ob.j] + r;
      }
      const L = cholesky(Sy, k);
      const innov = new Float64Array(k);
      for (let a = 0; a < k; a++) innov[a] = obs[a].y - mu[obs[a].j];
      const w = cholSolve(L, innov, k);
      muA = new Float64Array(S);
      for (let s = 0; s < S; s++) { let acc = mu[s]; for (let a = 0; a < k; a++) acc += C[s * S + obs[a].j] * w[a]; muA[s] = acc; }
      // CA = C - C[:,O] Sy^-1 C[O,:]
      CA = Float64Array.from(C);
      const col = new Float64Array(k);
      const SyInvCO = [];   // Sy^-1 C[O, t] for each t
      for (let t = 0; t < S; t++) {
        for (let a = 0; a < k; a++) col[a] = C[obs[a].j * S + t];
        SyInvCO.push(cholSolve(L, col, k));
      }
      for (let s = 0; s < S; s++) for (let t = 0; t < S; t++) {
        let acc = 0; const v = SyInvCO[t];
        for (let a = 0; a < k; a++) acc += C[s * S + obs[a].j] * v[a];
        CA[s * S + t] -= acc;
      }
      for (let s = 0; s < S; s++) for (let t = s + 1; t < S; t++) {   // symmetrize
        const m = 0.5 * (CA[s * S + t] + CA[t * S + s]); CA[s * S + t] = m; CA[t * S + s] = m;
      }
      // Map every draw:  x_a = muA + A (x - mu),  A = CA^(1/2) C^(-1/2)
      const sqrtA = fromEigen(jacobiEigen(CA, S), S, (l) => Math.sqrt(Math.max(l, 0)));
      const A = matmul(sqrtA, prior.invSqrt, S);
      post = new Float64Array(n * S);
      const d = new Float64Array(S);
      for (let i = 0; i < n; i++) {
        const base = i * S;
        for (let s = 0; s < S; s++) d[s] = X[base + s] - mu[s];
        for (let s = 0; s < S; s++) {
          let acc = muA[s]; const row = s * S;
          for (let t = 0; t < S; t++) acc += A[row + t] * d[t];
          post[base + s] = acc;
        }
      }
    }

    // MT's independent: her share gets its own scalar update (outside the joint
    // update, as in the forecast, where it is drawn independently)
    let ind = prior.ind;
    const mtSnap = snapshot && snapshot.MT;
    const mtObs = obs.find((o) => o.st === "MT");
    if (mtObs && mtSnap && mtSnap.ind != null) {
      const yInd = mtSnap.ind / mtSnap.total;
      const sdMarg = Math.sqrt(mtObs.indep + (CONFIG.TYPE_GAP * mtObs.u) ** 2);
      const r = (sdMarg / 200) ** 2;
      const v = prior.mtInd.var, m0 = prior.mtInd.mean;
      const kk = v / (v + r), m1 = m0 + kk * (yInd - m0), scale = Math.sqrt(1 - kk);
      ind = new Float64Array(n);
      for (let i = 0; i < n; i++) ind[i] = Math.min(0.95, Math.max(0, m1 + scale * (prior.ind[i] - m0)));
    }

    // Winners per draw
    const dw = new Uint8Array(n * S);
    const mtj = prior.mtj;
    for (let i = 0; i < n; i++) {
      const base = i * S;
      for (let s = 0; s < S; s++) dw[base + s] = post[base + s] > 0 ? 1 : 0;
      const m = post[base + mtj], iv = ind[i];
      const dS = (1 - iv) * Math.min(0.99, Math.max(0.01, 0.5 + m / 200)), rS = (1 - iv) - dS;
      dw[base + mtj] = ((dS > rS && dS > iv) || (iv > dS && iv > rS)) ? 1 : 0;
    }

    // Calls as sign constraints (importance weights)
    let weights = null, ess = n, callsMode = "none";
    const called = [];
    if (opts.useCalls && snapshot) {
      for (const st of prior.states) {
        const c = snapshot[st] && snapshot[st].called;
        if (c === "D" || c === "R" || (c === "I" && st === "MT")) called.push({ j: prior.idx[st], dem: c !== "R" });
      }
      if (called.length) {
        weights = new Float64Array(n);
        let sw = 0;
        for (let i = 0; i < n; i++) {
          let ok = 1;
          for (const c of called) if (dw[i * S + c.j] !== (c.dem ? 1 : 0)) { ok = 0; break; }
          weights[i] = ok; sw += ok;
        }
        ess = sw;   // 0/1 weights: the effective sample size is the count kept
        callsMode = "weighted";
        if (ess < CONFIG.MIN_ESS_FOR_CALLS) {
          // The calls disagree with the counts in too many draws: apply them to
          // their own states only, without letting them move anything else.
          weights = null; ess = n; callsMode = "override";
          for (let i = 0; i < n; i++) for (const c of called) dw[i * S + c.j] = c.dem ? 1 : 0;
        }
      }
    }

    // Summaries
    const W = weights;
    const wsum = W ? W.reduce((a, b) => a + b, 0) : n;
    const seatsHist = new Float64Array(101);
    let pMaj = 0, eSeats = 0;
    for (let i = 0; i < n; i++) {
      const wi = W ? W[i] : 1; if (!wi) continue;
      let t = prior.nc[i];
      for (let s = 0; s < S; s++) t += dw[i * S + s];
      seatsHist[t] += wi; eSeats += wi * t; if (t >= prior.maj) pMaj += wi;
    }
    pMaj /= wsum; eSeats /= wsum;
    for (let t = 0; t <= 100; t++) seatsHist[t] /= wsum;

    const races = {};
    const obsBy = {}; obs.forEach((o) => (obsBy[o.st] = o));
    for (const st of prior.states) {
      const j = prior.idx[st];
      let pD = 0;
      for (let i = 0; i < n; i++) { const wi = W ? W[i] : 1; if (wi) pD += wi * dw[i * S + j]; }
      pD /= wsum;
      const q = weightedQuantiles(post, n, S, j, W, [0.05, 0.25, 0.5, 0.75, 0.95]);
      const o = obsBy[st];
      const sn = snapshot && snapshot[st];
      const votes = sn ? sn.total || 0 : 0;
      races[st] = {
        p_dem: pD, q, median: q[2],
        reporting: !!o,                       // counted votes are moving the estimate
        status: o ? "counting" : votes > 0 ? "too_few" : "none",
        n_votes: votes,
        f: o ? o.f : (sn ? fOf(sn) : 0),
        counted: o ? o.counted : (sn && votes > 0 ? 100 * ((sn.dem || 0) - (sn.rep || 0)) / votes : null),
        called: sn ? sn.called || null : null,
      };
    }
    const indSummary = { mean: mean(ind) };
    return { control: { p_dem_majority: pMaj, expected_dem_seats: eSeats, seats_hist: seatsHist },
             races, n_reporting: k, ess, calls_mode: callsMode, mt_ind: indSummary, muA, CA };
  }

  function fOf(s) {
    if (s.eevp != null && s.eevp > 0) return s.eevp / 100;
    return s.expected > 0 ? Math.min(1, (s.total || 0) / s.expected) : 0;
  }

  // Quantiles of column j via a 0.02-pt histogram (fast, no sort)
  function weightedQuantiles(P, n, S, j, W, probs) {
    const lo = -110, hi = 110, step = 0.02, nb = Math.round((hi - lo) / step);
    const h = new Float64Array(nb);
    let tot = 0;
    for (let i = 0; i < n; i++) {
      const wi = W ? W[i] : 1; if (!wi) continue;
      let b = Math.floor((P[i * S + j] - lo) / step);
      if (b < 0) b = 0; else if (b >= nb) b = nb - 1;
      h[b] += wi; tot += wi;
    }
    const out = []; let acc = 0, b = 0;
    for (const p of probs) {
      const target = p * tot;
      while (b < nb && acc + h[b] < target) { acc += h[b]; b++; }
      const frac = h[b] > 0 ? (target - acc) / h[b] : 0;
      out.push(lo + (b + frac) * step);
    }
    return out;
  }

  return { CONFIG, loadPrior, update, observation, weightedQuantiles, _la: { jacobiEigen, fromEigen, matmul, cholesky, cholSolve } };
});
