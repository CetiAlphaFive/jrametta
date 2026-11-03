/* needle/simulate.js: a pretend election night for testing and the demo.
 *
 * Picks one of the forecast's own draws as the "true" result and writes an
 * NYT-shaped results-senate.json for any hour of the night, so the demo runs
 * through the same adapter and engine as the live feed. Counting errors follow
 * the needle's likelihood (county order, early-vote gap shared across states,
 * random noise), drawn once per night from a seed. Calls are made when the
 * count is well settled or the race is lopsided.
 * Nothing here is real data.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NeedleSim = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Approximate last poll closing, hours after 6 PM ET (the "hour" axis)
  const CLOSE = { KY: 1, GA: 1, SC: 1, VA: 1, NC: 1.5, OH: 1.5, WV: 1.5, AL: 2, DE: 2, FL: 2, IL: 2, ME: 2, MA: 2, MS: 2,
    NH: 2, NJ: 2, OK: 2, RI: 2, TN: 2, AR: 2.5, KS: 3, LA: 3, MI: 3, MN: 3, NE: 3, SD: 3, TX: 3, WY: 3, CO: 3,
    NM: 3, IA: 4, MT: 4, ID: 5, OR: 5, AK: 7 };
  const SPEED = { AK: 0.3, ME: 0.7, OR: 0.7, MI: 0.8, NE: 0.9 };

  function rng(seed) {
    let s = seed >>> 0 || 1;
    const u = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
    return { u, g: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
  }

  function night(prior, seed, cfg) {
    const R = rng(seed), S = prior.S, json = prior.json;
    const t = Math.floor(R.u() * prior.n);
    const truth = {};
    prior.states.forEach((st, j) => (truth[st] = prior.X[t * S + j]));
    const C = cfg;
    const shared = R.g() * C.TYPE_GAP * Math.sqrt(C.TYPE_RHO);
    const q = {};
    for (const st of prior.states) {
      const lik = json.races[st].lik;
      q[st] = { geo: R.g() * C.GEO_SHARE * lik.order_gap,
        type: shared + R.g() * C.TYPE_GAP * Math.sqrt(1 - C.TYPE_RHO),
        z: R.g(), lag: R.u() * 0.4, other: 0.01 + 0.03 * R.u() };
    }
    return { seed, row: t, truth, ind: prior.ind[t], q };
  }

  function feedAt(prior, nt, hour, cfg) {
    const json = prior.json, races = [];
    for (const st of prior.states) {
      const race = json.races[st], lik = race.lik, q = nt.q[st];
      const dt = hour - (CLOSE[st] ?? 2) - q.lag;
      let f = dt > 0 ? 1 - Math.exp(-(SPEED[st] || 1.2) * dt) : 0;
      f = Math.min(f, st === "AK" ? 0.65 : 0.99);
      const expected = 1e6;
      const total = Math.round(expected * f);
      const u = 1 - f;
      const err = f > 0 ? u * (q.geo + q.type) + q.z * Math.sqrt(lik.s_random ** 2 * u / f + cfg.FLOOR_SD ** 2) : 0;
      const m = nt.truth[st] + err;
      const oth = q.other, iv = race.ind ? Math.max(0, nt.ind) : 0;
      const two = total * (1 - oth - iv);
      const dem = Math.round(two * (0.5 + Math.max(-100, Math.min(100, m)) / 200));
      const rep = Math.round(two) - dem;
      const cands = [{ nyt_id: race.dem.id, votes: { total: dem } }, { nyt_id: race.rep.id, votes: { total: rep } }];
      const meta = {};
      meta[race.dem.id] = { last_name: race.dem.name, party: { nyt_id: ["NE", "ID", "SD"].includes(st) ? "IND" : "DEM" } };
      meta[race.rep.id] = { last_name: race.rep.name, party: { nyt_id: "GOP" } };
      if (race.ind) { cands.push({ nyt_id: race.ind.id, votes: { total: Math.round(total * iv) } }); meta[race.ind.id] = { last_name: race.ind.name, party: { nyt_id: "IND" } }; }
      const othId = "demo-other";
      cands.push({ nyt_id: othId, votes: { total: Math.round(total * oth) } });
      meta[othId] = { last_name: "Other", party: { nyt_id: st === "AK" ? "GOP" : "OTH" } };
      // Calls: lopsided races at poll close, close ones once nearly all is in
      const truthM = nt.truth[st];
      let won = [];
      const settled = (Math.abs(truthM) > 15 && dt > 0) || (f > 0.5 && Math.abs(truthM) > 6) || (f > 0.95 && Math.abs(truthM) > 1) || f >= 0.99;
      if (settled && st !== "AK" && st !== "ME") won = [winner(race, truthM, nt.ind)];
      races.push({
        nyt_id: race.nyt_race_id, candidate_metadata: meta,
        outcome: { won },
        reporting_units: [{ level: "state", eevp: Math.round(f * 100), total_votes: total,
          total_expected_vote: expected, candidates: cands, provider_updated_at: null }],
      });
    }
    return { races, resultsMeta: { resultsUpdatedAt: null }, demo: true };
  }

  function winner(race, m, ind) {
    if (!race.ind) return m > 0 ? race.dem.id : race.rep.id;
    const d = (1 - ind) * (0.5 + m / 200), r = (1 - ind) - d;
    return ind > d && ind > r ? race.ind.id : d > r ? race.dem.id : race.rep.id;
  }

  return { night, feedAt, CLOSE };
});
