class RollingBase {
  constructor(windowSize, initialState = null) {
    this.windowSize = windowSize;
    this.lastTickSeen = -1;
    this.values = new Array(windowSize).fill(0);
    this.ptr = 0;
    this.total = 0;

    if (initialState) {
      this.fromJSON(initialState);
    }
  }

  getWindowSlot(tick) {
    return tick % this.windowSize;
  }

  advanceToTick(tick) {
    if (this.lastTickSeen === -1) {
      this.lastTickSeen = tick - 1;
    }
    if (tick <= this.lastTickSeen) {
      return;
    }
    const gap = Math.min(this.windowSize, tick - this.lastTickSeen);
    for (let i = 0; i < gap; i += 1) {
      const slot = this.getWindowSlot(this.lastTickSeen + 1 + i);
      this.total -= this.values[slot];
      this.values[slot] = 0;
    }
    this.lastTickSeen = tick;
  }

  record(tick, value = 0) {
    this.advanceToTick(tick);
    const slot = this.getWindowSlot(tick);
    this.total -= this.values[slot];
    this.values[slot] = value;
    this.total += value;
    this.ptr = slot;
  }

  sum() {
    return this.total;
  }

  avg() {
    return this.total / this.windowSize;
  }

  toJSON() {
    return {
      windowSize: this.windowSize,
      lastTickSeen: this.lastTickSeen,
      values: this.values,
      ptr: this.ptr,
      total: this.total
    };
  }

  fromJSON(state) {
    if (!state || !Array.isArray(state.values)) {
      return;
    }
    this.windowSize = state.windowSize || this.windowSize;
    this.lastTickSeen = typeof state.lastTickSeen === "number" ? state.lastTickSeen : -1;
    this.values = state.values.slice(0, this.windowSize);
    while (this.values.length < this.windowSize) {
      this.values.push(0);
    }
    this.ptr = typeof state.ptr === "number" ? state.ptr : 0;
    this.total = typeof state.total === "number" ? state.total : this.values.reduce((acc, n) => acc + n, 0);
  }
}

class RollingCounter extends RollingBase {
  increment(tick, delta = 1) {
    this.advanceToTick(tick);
    const slot = this.getWindowSlot(tick);
    this.values[slot] += delta;
    this.total += delta;
    this.ptr = slot;
  }
}

class RollingAvg extends RollingBase {}

class RollingVar extends RollingBase {
  constructor(windowSize, initialState = null) {
    super(windowSize, null);
    this.sumSq = 0;
    if (initialState) {
      this.fromJSON(initialState);
    }
  }

  advanceToTick(tick) {
    if (this.lastTickSeen === -1) {
      this.lastTickSeen = tick - 1;
    }
    if (tick <= this.lastTickSeen) {
      return;
    }
    const gap = Math.min(this.windowSize, tick - this.lastTickSeen);
    for (let i = 0; i < gap; i += 1) {
      const slot = this.getWindowSlot(this.lastTickSeen + 1 + i);
      const old = this.values[slot];
      this.total -= old;
      this.sumSq -= old * old;
      this.values[slot] = 0;
    }
    this.lastTickSeen = tick;
  }

  record(tick, value = 0) {
    this.advanceToTick(tick);
    const slot = this.getWindowSlot(tick);
    const old = this.values[slot];
    this.total -= old;
    this.sumSq -= old * old;
    this.values[slot] = value;
    this.total += value;
    this.sumSq += value * value;
    this.ptr = slot;
  }

  variance() {
    const mean = this.avg();
    return Math.max(0, this.sumSq / this.windowSize - mean * mean);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      sumSq: this.sumSq
    };
  }

  fromJSON(state) {
    super.fromJSON(state);
    if (typeof state?.sumSq === "number") {
      this.sumSq = state.sumSq;
      return;
    }
    this.sumSq = this.values.reduce((acc, v) => acc + v * v, 0);
  }
}

module.exports = {
  RollingCounter,
  RollingAvg,
  RollingVar
};
