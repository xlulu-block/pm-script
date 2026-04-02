export const States = {
  CANDIDATE: "candidate",
  BUY_OPEN: "buy_open",
  PARTIAL_FILL: "partial_fill",
  FILLED_WAIT_SELL: "filled_wait_sell",
  SELL_OPEN_002: "sell_open_0.002",
  SELL_OPEN_001: "sell_open_0.001",
  DUST: "dust",
  SOLD: "sold",
  BUY_CLOSED_NO_FILL: "buy_closed_without_fill",
  ERROR_PAUSE: "error_pause",
};

const TRANSITIONS = {
  [States.CANDIDATE]: [States.BUY_OPEN],
  [States.BUY_OPEN]: [States.PARTIAL_FILL, States.FILLED_WAIT_SELL, States.BUY_CLOSED_NO_FILL, States.ERROR_PAUSE],
  [States.PARTIAL_FILL]: [States.FILLED_WAIT_SELL, States.SELL_OPEN_001, States.DUST, States.ERROR_PAUSE],
  [States.FILLED_WAIT_SELL]: [States.SELL_OPEN_002, States.SELL_OPEN_001, States.DUST, States.ERROR_PAUSE],
  [States.SELL_OPEN_002]: [States.FILLED_WAIT_SELL, States.SELL_OPEN_001, States.SOLD, States.DUST, States.ERROR_PAUSE],
  [States.SELL_OPEN_001]: [States.FILLED_WAIT_SELL, States.SELL_OPEN_002, States.SOLD, States.DUST, States.ERROR_PAUSE],
  [States.DUST]: [States.FILLED_WAIT_SELL, States.ERROR_PAUSE],
  [States.SOLD]: [],
  [States.BUY_CLOSED_NO_FILL]: [],
  [States.ERROR_PAUSE]: [States.BUY_OPEN, States.FILLED_WAIT_SELL, States.SELL_OPEN_002, States.SELL_OPEN_001],
};

export const TERMINAL_STATES = new Set([States.DUST, States.SOLD, States.BUY_CLOSED_NO_FILL]);

export const BUY_ACTIVE_STATES = new Set([States.BUY_OPEN, States.PARTIAL_FILL]);

export const SELL_ACTIVE_STATES = new Set([
  States.FILLED_WAIT_SELL,
  States.SELL_OPEN_002,
  States.SELL_OPEN_001,
]);

export function validateTransition(from, to) {
  const allowed = TRANSITIONS[from];
  if (!allowed) {
    throw new Error(`Unknown state: ${from}`);
  }
  if (!allowed.includes(to)) {
    throw new Error(`Invalid transition: ${from} -> ${to}`);
  }
}

export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

// Per-token promise-chain lock
const locks = new Map();

export function acquireTokenLock(tokenID) {
  let release;
  const newLock = new Promise((resolve) => {
    release = resolve;
  });

  const prev = locks.get(tokenID) || Promise.resolve();
  const wait = prev.then(() => {});

  locks.set(tokenID, newLock);

  const cleanup = () => {
    if (locks.get(tokenID) === newLock) {
      locks.delete(tokenID);
    }
    release();
  };

  return { wait, release: cleanup };
}
