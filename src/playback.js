// Playback controller — pure JS, no DOM. Drives a "playhead" across a neutral
// event record and reports which events have "arrived" (ts <= playhead time).
//
//   - play / pause / toggle
//   - speed: transcript ms per wall-clock ms (1 = real time, 5 = 5x, 0 = paused)
//   - seek(ts): jump the playhead to a transcript timestamp
//   - tick(nowMs): advance by wall-clock delta (call each animation frame)
//
// `tick` and `snapshot` return a plain object describing the current state.

export function createPlayer(events = [], opts = {}) {
  const evs = events.slice().sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  let first = evs[0]?.ts ?? 0; // moves only when a live stream starts empty
  let last = evs[evs.length - 1]?.ts ?? first;

  let time = opts.startTime != null ? opts.startTime : first;
  let playing = !!opts.playing;
  let speed = opts.speed != null ? opts.speed : 1; // transcript ms / wall ms
  let lastWall = null;

  // Index of how many events have arrived (ts <= time). Because events are
  // sorted, we can walk a frontier instead of re-filtering every tick.
  let arrived = 0;
  while (arrived < evs.length && (evs[arrived].ts ?? 0) <= time) arrived++;

  function snapshot() {
    return {
      time,
      playing,
      speed,
      duration: last - first || 0,
      eventsSoFar: evs.slice(0, arrived),
      total: evs.length,
      arrived,
      progress: progress(),
    };
  }

  // A session that spans no time is at its end once everything has arrived.
  function progress() {
    if (last === first) return evs.length && arrived === evs.length ? 1 : 0;
    return (time - first) / (last - first);
  }

  function advanceTo(nowWall) {
    if (!playing || lastWall === null) return;
    const dtWall = nowWall - lastWall; // wall-clock ms since last frame
    if (dtWall <= 0) return;
    const dt = dtWall * speed; // transcript ms to advance
    time += dt;
    if (time > last) time = last;
    while (arrived < evs.length && (evs[arrived].ts ?? 0) <= time) arrived++;
  }

  return {
    get time() { return time; },
    get playing() { return playing; },
    get speed() { return speed; },
    get arrived() { return arrived; },
    get total() { return evs.length; },
    get progress() { return progress(); },

    play() {
      if (playing) return;
      playing = true;
      lastWall = null; // so the first tick doesn't jump
    },
    pause() {
      playing = false;
      lastWall = null;
    },
    toggle() { playing ? this.pause() : this.play(); },

    setSpeed(s) {
      speed = s;
    },

    seek(ts) {
      time = Math.min(Math.max(ts ?? first, first), last);
      arrived = 0;
      while (arrived < evs.length && (evs[arrived].ts ?? 0) <= time) arrived++;
      lastWall = null;
    },

    // Append new events (live stream). Keeps the array sorted by ts.
    append(newEvents) {
      const toAdd = newEvents.filter((e) => e.ts != null);
      toAdd.sort((a, b) => a.ts - b.ts);
      // merge into evs maintaining sort
      let i = 0, j = 0, merged = [];
      while (i < evs.length && j < toAdd.length) {
        if (evs[i].ts <= toAdd[j].ts) merged.push(evs[i++]);
        else merged.push(toAdd[j++]);
      }
      while (i < evs.length) merged.push(evs[i++]);
      while (j < toAdd.length) merged.push(toAdd[j++]);
      evs.length = 0;
      evs.push(...merged);
      if (merged.length === toAdd.length) first = evs[0]?.ts ?? first; // was empty
      last = evs[evs.length - 1]?.ts ?? first;
      // recompute arrived frontier
      arrived = 0;
      while (arrived < evs.length && (evs[arrived].ts ?? 0) <= time) arrived++;
    },

    // Call once per animation frame with wall-clock ms (e.g. performance.now()).
    tick(nowWall) {
      advanceTo(nowWall);
      lastWall = nowWall;
      return snapshot();
    },


    snapshot,
  };
}
