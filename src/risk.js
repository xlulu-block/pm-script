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
        console.warn(`[RISK] 连续错误达到 ${this.consecutiveErrors} 次，已触发熔断`);
      }
    },
    isPaused() {
      return this.paused;
    },
  };
}
