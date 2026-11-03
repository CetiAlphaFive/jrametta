/* needle/nyt_adapter.js: turn NYT's results-senate.json into the engine's
 * per-state snapshot, keyed by the race ids in prior.json (from race_map.csv).
 *
 * Feed: https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-senate.json
 * (AP data, state level). Field use:
 *   races[].nyt_id                       -> matched to prior.races[st].nyt_race_id
 *   races[].reporting_units[level=state] -> eevp, total_votes, total_expected_vote,
 *                                           candidates[].votes.total by candidate id
 *   races[].candidate_metadata[id].party.nyt_id -> party of the other candidates (RCV)
 *   races[].outcome.won[0]               -> the call, mapped to D / R / I / O
 *
 * A race that is missing, or whose D or R candidate id is missing, is marked
 * with a problem and gives no observation; nothing here throws on feed data.
 * The Gate holds a state's last accepted numbers when a new snapshot looks
 * broken (votes fall by more than 5%, or eevp falls by more than 5 points).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NytAdapter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FEED_URL = "https://static01.nyt.com/elections-assets/pages/data/2026-11-03/results-senate.json";

  function normalize(feed, priorJson) {
    const snapshot = {}, problems = {}, names = {};
    const byId = {};
    for (const r of (feed && feed.races) || []) byId[r.nyt_id] = r;
    for (const st of priorJson.states) {
      const race = priorJson.races[st];
      const r = byId[race.nyt_race_id];
      if (!r) { problems[st] = "race not in feed"; continue; }
      const ru = r.top_reporting_unit
        || (r.reporting_units || []).find((u) => u.level === "state")
        || (r.reporting_units || [])[0];
      if (!ru) { problems[st] = "no state reporting unit"; continue; }
      const votes = {};
      for (const c of ru.candidates || []) votes[c.nyt_id] = num(c.votes && c.votes.total);
      const meta = r.candidate_metadata || {};
      if (!(race.dem.id in votes) || !(race.rep.id in votes)) {
        problems[st] = "candidate ids changed (" + race.dem.id + " / " + race.rep.id + ")"; continue;
      }
      if (race.ind && !(race.ind.id in votes)) { problems[st] = "independent's id changed (" + race.ind.id + ")"; continue; }
      const known = new Set([race.dem.id, race.rep.id, race.ind && race.ind.id]);
      const others = [];
      for (const id in votes) if (!known.has(id)) {
        others.push({ id, votes: votes[id], party: meta[id] && meta[id].party ? meta[id].party.nyt_id : "OTH" });
      }
      const won = r.outcome && Array.isArray(r.outcome.won) ? r.outcome.won : [];
      let called = null;
      if (won.length === 1) {
        called = won[0] === race.dem.id ? "D" : won[0] === race.rep.id ? "R"
               : race.ind && won[0] === race.ind.id ? "I" : "O";
      }
      const total = num(ru.total_votes);
      snapshot[st] = {
        dem: votes[race.dem.id], rep: votes[race.rep.id],
        ind: race.ind ? votes[race.ind.id] : null,
        others, total: total || Object.values(votes).reduce((a, b) => a + b, 0),
        eevp: num(ru.eevp), expected: num(ru.total_expected_vote),
        called, updated: ru.provider_updated_at || r.updated_at || null,
      };
      names[st] = {
        dem: lastName(meta[race.dem.id]) || race.dem.name,
        rep: lastName(meta[race.rep.id]) || race.rep.name,
        ind: race.ind ? lastName(meta[race.ind.id]) || race.ind.name : null,
      };
    }
    const updated = (feed && feed.resultsMeta && feed.resultsMeta.resultsUpdatedAt) || null;
    return { snapshot, problems, names, updated };
  }

  function num(x) { const v = Number(x); return Number.isFinite(v) && v >= 0 ? v : 0; }
  function lastName(m) { return m && m.last_name ? m.last_name : null; }

  // Keeps the last accepted snapshot per state; rejects implausible drops.
  function Gate() {
    const last = {};
    const held = {};
    return {
      filter(snapshot) {
        const out = {};
        for (const st in snapshot) {
          const s = snapshot[st], p = last[st];
          const bad = p && ((p.total > 0 && s.total < 0.95 * p.total) || (s.eevp < p.eevp - 5));
          if (bad) { out[st] = Object.assign({}, p, { called: s.called || p.called }); held[st] = (held[st] || 0) + 1; }
          else { out[st] = s; last[st] = s; held[st] = 0; }
          // A drop that persists for 3 refreshes is a real correction: accept it
          if (held[st] >= 3) { out[st] = s; last[st] = s; held[st] = 0; }
        }
        return { snapshot: out, held: Object.keys(held).filter((k) => held[k] > 0) };
      },
    };
  }

  return { FEED_URL, normalize, Gate };
});
