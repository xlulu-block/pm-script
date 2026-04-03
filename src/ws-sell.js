import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config.js";
import { States, acquireTokenLock } from "./state-machine.js";
import { getToken, transitionToken, saveState } from "./state.js";
import { getFilledShares, placeSellOrder, cancelOrdersForToken } from "./orders.js";
import { analyzeBidDepth, getBuyPriceLevel, getTargetSellPrice } from "./depth.js";
import { inspectBatchOrderBooks } from "./clob.js";

const SELLABLE_STATES = new Set([
  States.BUY_OPEN,
  States.PARTIAL_FILL,
  States.FILLED_WAIT_SELL,
]);

function getWsDepthThreshold() {
  return config.WS_SELL_DEPTH_MULTIPLIER * config.ORDER_SIZE;
}

export function createWsSellTrigger(client, creds, state) {
  let ws = null;
  let stopped = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let pingTimer = null;
  let pongTimer = null;

  function getReconnectDelay() {
    const base = config.WS_RECONNECT_BASE_MS;
    const delay = base * 2 ** Math.min(reconnectAttempt, 4);
    return Math.min(delay, 60_000);
  }

  function clearTimers() {
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function schedulePing() {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    pingTimer = setTimeout(() => {
      if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send("ping");
      } catch {}
      pongTimer = setTimeout(() => {
        console.warn("[WS] ping 超时，关闭连接准备重连");
        try { ws.close(); } catch {}
      }, config.WS_PING_INTERVAL_MS);
    }, config.WS_PING_INTERVAL_MS);
  }

  function onPong() {
    if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    schedulePing();
  }

  async function handleFillEvent(tokenID) {
    const lock = acquireTokenLock(tokenID);
    await lock.wait;
    try {
      const token = getToken(state, tokenID);
      if (!token) {
        console.log(`[WS-SELL] ${tokenID.slice(0, 12)}... 不在追踪状态中，跳过`);
        return;
      }

      if (!SELLABLE_STATES.has(token.state)) {
        console.log(`[WS-SELL] ${token.question} 当前状态 ${token.state} 不可卖出，跳过`);
        return;
      }

      const balance = await getFilledShares(client, tokenID);
      if (balance <= 0) {
        console.log(`[WS-SELL] ${token.question} 余额为 0，跳过`);
        return;
      }

      console.log(`[WS-SELL] ${token.question} 检测到买单成交，balance=${balance}，立即挂卖单`);

      if (token.state !== States.FILLED_WAIT_SELL) {
        await transitionToken(state, tokenID, States.FILLED_WAIT_SELL, {
          filledShares: balance,
          buyOrderId: null,
        });
      }

      const books = await inspectBatchOrderBooks(client, [{ target: { tokenID } }]);
      const orderBook = books.get(tokenID);
      if (!orderBook) {
        console.warn(`[WS-SELL] ${token.question} 无法获取盘口，跳过`);
        return;
      }

      const targetSellPrice = getTargetSellPrice(config);
      const result = await placeSellOrder(client, tokenID, targetSellPrice, balance, {
        tickSize: orderBook.tick_size,
        negRisk: orderBook.neg_risk,
      });

      if (!result.success) {
        console.error(`[WS-SELL] ${token.question} 挂 ${targetSellPrice} 卖单失败: ${result.error}`);
        return;
      }

      await transitionToken(state, tokenID, States.SELL_OPEN_002, {
        sellOrderId: result.orderID,
        sellPrice: targetSellPrice,
        filledShares: balance,
      });
      console.log(`[WS-SELL] ${token.question} 已挂 ${targetSellPrice} 卖单，orderID=${result.orderID}`);

      const depth = analyzeBidDepth(orderBook, config);
      const threshold = getWsDepthThreshold();
      if (depth.bidSharesAtBuyPrice < threshold) {
        console.log(
          `[WS-SELL] ${token.question} 深度不足（${depth.bidSharesAtBuyPrice} < ${threshold}），调整为 ${getBuyPriceLevel(config)} 卖出`
        );

        const cancelResult = await cancelOrdersForToken(client, tokenID, "SELL");
        if (!cancelResult.success) {
          console.warn(`[WS-SELL] ${token.question} 取消卖单失败，保持 0.002 卖单`);
          return;
        }

        const freshBalance = await getFilledShares(client, tokenID);
        if (freshBalance <= 0) {
          await transitionToken(state, tokenID, States.SOLD, {
            filledShares: 0,
            sellOrderId: null,
            sellPrice: null,
          });
          console.log(`[WS-SELL] ${token.question} 取消后余额为 0，标记为已卖出`);
          return;
        }

        const buyPrice = getBuyPriceLevel(config);
        const result2 = await placeSellOrder(client, tokenID, buyPrice, freshBalance, {
          tickSize: orderBook.tick_size,
          negRisk: orderBook.neg_risk,
        });

        if (!result2.success) {
          console.error(`[WS-SELL] ${token.question} 挂 ${buyPrice} 卖单失败: ${result2.error}`);
          await transitionToken(state, tokenID, States.FILLED_WAIT_SELL, {
            sellOrderId: null,
            sellPrice: null,
            filledShares: freshBalance,
          });
          return;
        }

        await transitionToken(state, tokenID, States.SELL_OPEN_001, {
          sellOrderId: result2.orderID,
          sellPrice: buyPrice,
          filledShares: freshBalance,
        });
        console.log(`[WS-SELL] ${token.question} 已调整为 ${buyPrice} 卖单，orderID=${result2.orderID}`);
      }

      await saveState(config.STATE_FILE, state);
    } catch (err) {
      console.error(`[WS-SELL] 处理成交事件失败 ${tokenID.slice(0, 12)}...: ${err.message}`);
    } finally {
      lock.release();
    }
  }

  function onMessage(data) {
    const raw = String(data);
    if (raw === "pong") {
      onPong();
      return;
    }

    if (!raw.includes("payload")) return;

    try {
      const message = JSON.parse(raw);
      if (message.topic !== "clob_user") return;

      const payload = message.payload;
      if (!payload) return;

      const side = String(payload.side || "").toUpperCase();
      const tokenID = payload.asset_id || payload.tokenID;
      if (side === "BUY" && tokenID) {
        void handleFillEvent(tokenID);
      }
    } catch (err) {
      console.error(`[WS] 解析消息失败: ${err.message}`);
    }
  }

  function subscribe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      action: "subscribe",
      subscriptions: [
        {
          topic: "clob_user",
          type: "*",
          clob_auth: {
            key: creds.key,
            secret: creds.secret,
            passphrase: creds.passphrase,
          },
        },
      ],
    };
    try {
      ws.send(JSON.stringify(msg));
      console.log("[WS] 已订阅 clob_user");
    } catch (err) {
      console.error(`[WS] 订阅失败: ${err.message}`);
    }
  }

  function onOpen() {
    console.log("[WS] 已连接");
    reconnectAttempt = 0;
    subscribe();
    schedulePing();
  }

  function onClose(code, reason) {
    console.warn(`[WS] 连接关闭 code=${code} reason=${reason || "n/a"}`);
    clearTimers();
    if (!stopped) {
      const delay = getReconnectDelay();
      console.log(`[WS] ${delay}ms 后重连（第 ${reconnectAttempt + 1} 次）`);
      reconnectTimer = setTimeout(() => {
        reconnectAttempt++;
        connect();
      }, delay);
    }
  }

  function onError(err) {
    console.error(`[WS] 错误: ${err.message || err}`);
  }

  function connect() {
    if (stopped) return;
    clearTimers();

    const options = {};
    if (config.PROXY_URL) {
      options.agent = new HttpsProxyAgent(config.PROXY_URL);
    }

    try {
      ws = new WebSocket(config.WS_CLOB_URL, options);
      ws.on("open", onOpen);
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    } catch (err) {
      console.error(`[WS] 连接失败: ${err.message}`);
      onClose(0, err.message);
    }
  }

  function start() {
    if (stopped) return;
    console.log(`[WS] 启动 WebSocket 卖出触发器，连接到 ${config.WS_CLOB_URL}`);
    connect();
  }

  function stop() {
    stopped = true;
    clearTimers();
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    console.log("[WS] WebSocket 卖出触发器已停止");
  }

  return { start, stop };
}
