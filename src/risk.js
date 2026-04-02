export function createCircuitBreaker(cfg) {
  return {
    consecutiveErrors: 0,
    paused: false,
    threshold: cfg.CIRCUIT_BREAKER_THRESHOLD,
    recordSuccess() {
      this.consecutiveErrors = 0;
      this.paused = false;
    },
    recordError() {
      this.consecutiveErrors++;
      if (this.consecutiveErrors >= this.threshold) {
        this.paused = true;
        console.warn(`[RISK] Circuit breaker tripped after ${this.consecutiveErrors} consecutive errors`);
      }
    },
    isPaused() {
      return this.paused;
    },
  };
}
