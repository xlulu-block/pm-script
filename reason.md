# 下单逻辑说明

以下内容基于当前代码实际实现，核心参考文件为 `src/buy-loop.js`、`src/clob.js`、`src/sell-loop.js`、`src/orders.js`、`src/depth.js`。

## 买单逻辑

1. 买单入口在 `runBuyScan()`。
2. 买入扫描先拿到候选 market，然后做去重。以下 token 不会再下买单：
   - 当前账户里已经有 open order 的 token
   - 本地状态里仍在跟踪中的 token
   - 当前批次里已经进入处理中、还没返回结果的 token
3. 真正下单前，会先批量拉取每个 token 的 order book，并执行买单前置检查：
   - order book 必须存在；如果 `STRICT_ORDERBOOK_CHECK=true`，缺失就直接跳过
   - 盘口不能是“只有 ask 没有 bid”
   - `tick_size` 必须等于 `ORDER_PRICE`
   - 在 `ORDER_PRICE` 这一档的买盘深度，必须大于等于 `3 * ORDER_SIZE`
4. 上面通过后，不会立刻下单，而是再等待 `BUY_DEPTH_DEBOUNCE_MS`，然后重新检查一次 order book；第二次仍满足条件才允许继续。
5. 最终下的是固定参数的限价买单：
   - `side = BUY`
   - `price = ORDER_PRICE`
   - `size = ORDER_SIZE`
   - `orderType = GTC`
   - 是否 `POST_ONLY` 由 `config.POST_ONLY` 控制
6. 买单成功后，会把该 token 写入本地状态，并把状态从 `candidate` 立即切到 `buy_open`，同时记录 `buyOrderId`。
7. 如果买单还挂着，但账户里已经出现部分持仓，卖出扫描会把状态从 `buy_open` 改成 `partial_fill`。
8. 如果买单已经不在 open orders 里：
   - 有持仓，则转成 `filled_wait_sell`
   - 没持仓，则转成 `buy_closed_without_fill`

## 卖单逻辑

1. 卖单入口在 `runSellScan()`，它会周期性执行。
2. 卖出逻辑处理的状态不只包含已买满的 token，也包含这些状态：
   - `buy_open`
   - `partial_fill`
   - `filled_wait_sell`
   - `sell_open_0.002`
   - `sell_open_0.001`
3. 卖出判断的核心仍然看 `ORDER_PRICE` 这一档的买盘深度：
   - 如果该档深度 `< 3 * ORDER_SIZE`，目标卖价定为 `ORDER_PRICE`
   - 如果该档深度 `>= 3 * ORDER_SIZE`，目标卖价定为 `ORDER_PRICE * 2`
4. 和买单一样，卖出信号也会先判断一次，再等待 `SELL_DEPTH_DEBOUNCE_MS` 复查一次；两次结果一致才执行。
5. 只要出现以下情况之一，就视为需要“防守式退出”：
   - 整个盘口没有 bid
   - `ORDER_PRICE` 这一档没有 bid
   - `ORDER_PRICE` 这一档买盘深度小于 `3 * ORDER_SIZE`
6. 触发防守式退出时，系统会进入 `forceClearMarket()`：
   - 先撤掉该 token 的所有 `BUY` 挂单
   - 如果撤买单后发现余额是 0，则直接收尾，不再挂卖单
   - 如果还有持仓，则尽量把全部持仓按 `ORDER_PRICE` 挂 `SELL`
   - 成功后状态记为 `sell_open_0.001`
7. 如果没有触发防守式退出：
   - 只要还有 `BUY` 挂单，本轮不会继续挂卖单
   - 如果当前没有 `SELL` 挂单，而且余额大于 0，就按目标卖价挂出全部余额
   - 如果目标卖价是 `ORDER_PRICE * 2`，成功后状态记为 `sell_open_0.002`
   - 如果目标卖价是 `ORDER_PRICE`，成功后状态记为 `sell_open_0.001`
8. 如果系统已经有一张数量与当前余额一致的卖单：
   - 卖在 `ORDER_PRICE * 2`，则只同步状态，不重复下单
   - 卖在 `ORDER_PRICE`，则根据当前行情决定是否继续保留，或者在冷却时间后改挂到 `ORDER_PRICE * 2`
9. 卖单成交后的收尾逻辑是：
   - open sell order 已消失，且余额也为 0，则状态改成 `sold`
   - open sell order 已消失，但余额还大于 0，则回到 `filled_wait_sell`，等待下一轮再卖

## 撤单逻辑

1. 撤单统一走 `cancelOrdersForToken(client, tokenID, side)`。
2. 这个函数会先拉该 token 的 open orders，再按 `side` 过滤：
   - `side = "BUY"` 时，只撤买单
   - `side = "SELL"` 时，只撤卖单
   - `side = null` 时，撤这个 token 的全部挂单
3. 当前代码里，主动撤单主要发生在这几种场景：
   - 行情走弱，触发 `forceClearMarket()` 时，先撤 `BUY` 挂单
   - 行情走弱，准备把持仓统一按 `ORDER_PRICE` 清掉时，先撤已有 `SELL` 挂单
   - 原先挂的是 `ORDER_PRICE` 卖单，但行情恢复后要改挂到 `ORDER_PRICE * 2` 时，先撤旧 `SELL` 单，再挂新单
   - 账户里已经没有余额，但还残留 `SELL` 挂单时，撤掉这类过期卖单
4. 当前实现里，买单不是在买入循环里主动撤的；买单撤销动作主要发生在卖出扫描阶段，由风控触发。
