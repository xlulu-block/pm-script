# Polymarket Scanner 规则文档

本文档以当前代码实现和当前 `.env` 生效配置为准，描述的是“现在这份程序实际上会怎么运行”，不是理想化策略说明。

## 1. 当前生效的关键参数

以下数值来自当前代码和当前 `.env` 的非敏感配置：

- `FILTER_PROFILE=historical_winners`
- `SIGNATURE_TYPE=2`
- `ORDER_PRICE=0.001`
- `ORDER_SIZE=120`
- `POST_ONLY=true`
- `STRICT_ORDERBOOK_CHECK=true`
- `BUY_DEPTH_DEBOUNCE_MS=3000`
- `DEPTH_MULTIPLIER=3`
- `SELL_DEPTH_DEBOUNCE_MS=3000`
- `SELL_SCAN_INTERVAL_MS=180000`
- `SCAN_INTERVAL_MS=3600000`
- `PAGE_SIZE=200`
- `MAX_PAGES=220`
- `MIN_SELL_SIZE=1`（当前实现里不再用它阻止正余额卖出）
- `CIRCUIT_BREAKER_THRESHOLD=5`
- `MIN_MINUTES_TO_SETTLEMENT=60`

由这些参数推导出的核心阈值：

- 买入价位固定为 `0.001`
- 目标卖出价位固定为 `0.002`，即 `ORDER_PRICE * 2`
- 深度阈值为 `DEPTH_MULTIPLIER * ORDER_SIZE`
- 在当前配置下，深度阈值是 `360`
- 单笔买单名义占用约为 `0.001 * 120 = 0.12 USDC`

## 2. 程序整体运行方式

非 `dry-run` 模式下，程序分成两条循环：

1. 启动时先加载 `scanner-state.json`
2. 初始化 CLOB 客户端
3. 先执行一次卖出扫描，处理已有仓位或遗留订单
4. 启动独立的卖出定时器，每 `180000ms` 跑一次卖出扫描
5. 买入循环立即跑第 1 轮，之后每隔 `3600000ms` 再跑下一轮

补充说明：

- 卖出循环如果上一轮还没跑完，本轮会直接跳过，不并发执行
- `dry-run` 模式只执行一次买入扫描，不初始化 CLOB，不做鉴权，也不下单
- `RUN_FOREVER=true` 时买入循环持续运行；否则只跑一轮

## 3. 账户初始化与授权

当前代码支持三种签名上下文：

- `0 = EOA`
- `1 = POLY_PROXY`
- `2 = GNOSIS_SAFE`

当前 `.env` 使用的是 `SIGNATURE_TYPE=2`，因此代码会要求必须提供 `FUNDER_ADDRESS`。

初始化 CLOB 客户端时，实际步骤如下：

1. 用 `PRIVATE_KEY` 创建钱包
2. 先创建未鉴权客户端，派生 API key
3. 再创建正式鉴权客户端
4. 检查 collateral 状态

授权逻辑的真实行为：

- 当 `SIGNATURE_TYPE=0` 时，代码会检查 Polygon 链上 USDC.e 对 Polymarket 相关 spender 的 allowance
- 如果 allowance 不足且 `AUTO_APPROVE_COLLATERAL=true`，会自动发起 `approve(MaxUint256)`
- 当 `SIGNATURE_TYPE=1` 或 `2` 时，不做 EOA 链上授权检查
- 但仍会刷新 CLOB 侧 collateral cache；若发现非 EOA 上有余额但 allowance 为 0，会直接报错退出

## 4. 市场发现与初筛

### 4.1 Gamma 抓取

买入扫描通过 Gamma API 拉取市场：

- 仅请求 `active=true&closed=false`
- 每页 `PAGE_SIZE=200`
- 最多抓取 `MAX_PAGES=220` 页
- 每页之间固定等待 `200ms`
- 单页失败最多重试 3 次
- 超时由 `FETCH_TIMEOUT_MS` 控制，当前是 `15000ms`

如果抓满上限，程序只会打印警告，不会自动扩大抓取范围。

### 4.2 当前过滤 profile 的真实行为

当前 `FILTER_PROFILE=historical_winners`。

这个 profile 在代码里的实际行为不是“命中若干历史赢家题型再保留”，而是：

- `scanAll=true`
- 所有通过硬过滤的活跃市场都会进入候选集
- 候选项的 `category` 统一记为 `ALL_MARKETS`

也就是说，在当前配置下：

- `historical_winners` 这组正则规则实际上不会参与筛选命中
- `legacy` 和 `extreme_reversal` 的规则只有切换 profile 后才会生效

### 4.3 当前启用的硬过滤

以下市场会被直接排除：

- `market.active === false`
- `market.closed === true`
- `market.accepting_orders === false`
- 距离 `end_date` 小于 `MIN_MINUTES_TO_SETTLEMENT`，当前是 60 分钟
- `volume_num_24hr == 0` 且 `liquidity == 0`
- 无法解析出 `YES` token ID

注意：

- 年度类排除、加密类排除只在 `legacy` / `extreme_reversal` 下启用
- 当前 `historical_winners` 不会额外排除 annual / crypto 市场

## 5. 买入前去重与状态同步

正式下单前，买入循环会构造一个 blocked 集合。以下 token 会被跳过：

- 当前账户已有任意 open order 的 token
- 当前账户历史 BUY trade 里出现过的 token
- 本地状态文件里所有非终态 token
- 当前这轮正在处理、尚未返回结果的 token

当前状态机里的终态只有 3 个：

- `dust`
- `sold`
- `buy_closed_without_fill`

因此有两个要点：

- 已经 `dust` / `sold` / `buy_closed_without_fill` 的 token 不会再被本地状态层阻塞
- 但只要历史 BUY trade 里出现过，这个 token 仍然会被“历史买过”这一层永久跳过

另外，买入扫描开始后还会做一次状态补写：

- 对于“交易历史里买过，但本地状态里还没有记录”的 token
- 代码会直接补写为 `filled_wait_sell`

这意味着卖出循环会接管这些历史仓位。

## 6. 买入 order book 检查与下单规则

### 6.1 当前真实的买入深度判断

买入判断使用的不是 `0.01` 档，而是 `ORDER_PRICE` 对应的档位。

在当前配置下：

- 买入观察价位是 `0.001`
- 买入深度要求是 `0.001` 档买盘总量 `>= 360`

代码里真正的判断逻辑：

1. order book 必须可取到；当前 `STRICT_ORDERBOOK_CHECK=true`
2. 如果盘口是“只有卖盘、没有买盘”，直接跳过
3. `tick_size` 必须严格等于 `ORDER_PRICE`，当前必须等于 `0.001`
4. 盘口里必须存在任意有效买盘
5. `0.001` 档的买盘份额总和必须 `>= DEPTH_MULTIPLIER * ORDER_SIZE`
6. 等待 `BUY_DEPTH_DEBOUNCE_MS=3000` 后再检查一次，二次检查也必须继续满足

所以当前买入门槛的精确表述是：

- `bidSharesAt0.001 >= 360`

### 6.2 买单提交方式

通过盘口检查后，系统提交的是：

- `BUY`
- `GTC`
- 限价单
- 价格固定 `0.001`
- 数量固定 `120`
- `POST_ONLY=true`

### 6.3 批处理与重试

买单按批执行，当前参数：

- `ORDER_BATCH_SIZE=10`
- `ORDER_BATCH_MIN_SIZE=1`
- `ORDER_BATCH_MAX_RETRIES=3`
- `ORDER_BATCH_RETRY_BASE_MS=1000`
- `ORDER_DELAY_MS=500`

重试规则：

- 遇到 `429` 或包含 `rate limit` 的错误，视为可重试
- 重试前会指数退避，并加入随机抖动
- 重试时会自动把批次缩小，最小缩到 `ORDER_BATCH_MIN_SIZE`

以下错误会被视为致命错误并停止本轮剩余批次：

- allowance 相关错误
- 余额不足相关错误

普通失败只会记录错误，不会中断整轮买入。

### 6.4 买单成功后的状态流转

买单成功后，状态更新顺序是：

1. 先把 token 写入本地状态，状态设为 `candidate`
2. 立即再转成 `buy_open`
3. 保存 `buyOrderId`

因此：

- `candidate` 只是极短暂的中间态
- 正常情况下你几乎只会看到 `buy_open`

### 6.5 买入失败后的记录

买入失败会追加写入 `order-errors.jsonl`，内容包括：

- 时间
- iteration
- question
- category
- tokenID
- error
- 是否 `stopAll`

## 7. 卖出循环的真实逻辑

卖出循环分三步：

1. 检查买单状态
2. 处理可卖 token
3. 检查卖单状态

### 7.1 买单状态检查

会检查这些状态的 token：

- `buy_open`
- `partial_fill`

判断规则：

- 如果已经没有 open buy order，且 `balance > 0`，转为 `filled_wait_sell`
- 如果已经没有 open buy order，且 `balance == 0`，转为 `buy_closed_without_fill`
- 如果 buy order 还在，但余额已经 `> 0`，且当前状态是 `buy_open`，转为 `partial_fill`

注意：

- 即使余额小于 `MIN_SELL_SIZE`，只要大于 0，也会先转成 `filled_wait_sell`
- 当前实现不会再因为“余额太小”而把正余额仓位归类成 `dust`
- 如果历史状态里已经是 `dust`，但实际余额仍大于 0，卖出扫描也会自动恢复成 `filled_wait_sell`

### 7.2 哪些 token 会进入卖出决策

当前代码会对以下状态都跑卖出判断：

- `buy_open`
- `partial_fill`
- `filled_wait_sell`
- `sell_open_0.002`
- `sell_open_0.001`

这点非常关键：

- 卖出循环不只处理“已经完全买完”的 token
- 对 `buy_open` / `partial_fill`，只要出现风控触发，也可能直接进入清仓路径

### 7.3 当前真实的卖出决策基线

卖出决策同样看 `ORDER_PRICE` 档的买盘深度。

在当前配置下：

- 观察档位是 `0.001`
- 深度阈值还是 `360`
- 目标卖价是 `0.002`

卖出判断的底层函数是：

- 当 `bidSharesAt0.001 < 360` 时，目标卖价判为 `0.001`
- 当 `bidSharesAt0.001 >= 360` 时，目标卖价判为 `0.002`

然后代码会再等待 `SELL_DEPTH_DEBOUNCE_MS=3000`，重新拉一次盘口复核。

只有两次判断一致时，卖出信号才算确认。

### 7.4 强制清到 `0.001` 的条件

当前强制退出条件只有一条：

- `bidSharesAt0.001 < 360`

这条规则会自然覆盖下面几种情况：

- 根本没有买盘
- 有买盘，但 `0.001` 档没有量
- `0.001` 档买盘有量，但不足 360

触发后，代码会执行 `forceClearMarket()`，真实行为如下：

1. 如果还有 open buy order，先取消 `BUY` 单
2. 如果取消后余额为 0：
   - 原状态是 `buy_open` 时，转 `buy_closed_without_fill`
   - 其他情况转 `dust`
3. 如果原状态是 `buy_open` 且余额大于 0，先转 `partial_fill`
4. 如果此时已经存在一张数量完全对齐的 `0.001` 卖单，则只同步状态，不重复下单
5. 否则取消所有 `SELL` 单
6. 按当前全部可卖余额挂一张 `0.001` 的 `SELL`
7. 成功后转成 `sell_open_0.001`

### 7.5 非强制退出时的真实卖出行为

如果没有触发强制退出：

- 只要还有 `BUY` 单挂着，代码本轮就不会继续卖
- 只要余额 `> 0`，并且没有任何 `SELL` 单，就会继续尝试挂卖单
- 不会因为余额小于 `MIN_SELL_SIZE=1` 就停止卖出

如果已经有 `SELL` 单，当前代码不会做完整的改价逻辑，只会做“识别并同步”：

- 若仅有一张价格为 `0.002` 且数量与余额对齐的卖单，状态同步为 `sell_open_0.002`
- 若仅有一张价格为 `0.001` 且数量与余额对齐的卖单，状态同步为 `sell_open_0.001`
- 其他所有已有卖单场景，本轮直接返回，不撤单，不补单，不改价

这意味着当前实现的真实特点是：

- 会在风控变差时主动降级到 `0.001`
- 但不会在风控恢复后主动把 `0.001` 升回 `0.002`
- 也不会使用“撤旧单再挂新单”的常规改价流程

## 8. 卖单完成后的收尾规则

会检查这些状态：

- `sell_open_0.002`
- `sell_open_0.001`

处理规则：

- 如果已经没有 open sell order，且余额 `<= 0`，转为 `sold`
- 如果已经没有 open sell order，但余额 `> 0`，转回 `filled_wait_sell`

所以：

- `sold` 的判定现在只依赖“卖单消失”且“余额已经为 0”
- 如果卖单不见了但仓位还在，无论余额多小，下一轮都会重新回到待卖状态

## 9. 当前状态机

当前状态定义如下：

- `candidate`
- `buy_open`
- `partial_fill`
- `filled_wait_sell`
- `sell_open_0.002`
- `sell_open_0.001`
- `dust`
- `sold`
- `buy_closed_without_fill`
- `error_pause`

终态只有：

- `dust`
- `sold`
- `buy_closed_without_fill`

`error_pause` 不是终态，但当前代码没有自动恢复机制。进入这个状态通常意味着：

- 某个 token 在卖出或买单状态检查时抛了异常
- 需要人工排查后，再手动决定是否恢复

补充：

- `dust` 虽然仍被本地去重逻辑视为终态，但卖出扫描现在会在发现正余额时自动把它救回 `filled_wait_sell`

## 10. 风控与熔断

买入流程维护一个连续错误计数器：

- 每成功下一单，计数清零
- 每出现一次下单失败，计数加一
- 达到 `CIRCUIT_BREAKER_THRESHOLD=5` 后，买入循环进入暂停

实际效果：

- 后续买入扫描会直接跳过
- 卖出循环不受影响，仍会继续运行
- 当前代码没有自动解熔逻辑；通常需要进程重启，或者之后刚好有新的成功下单才能清零

## 11. 本地文件与落盘行为

当前程序会使用这些文件：

- `scanner-state.json`
- `order-errors.jsonl`
- `state-changes.jsonl`

对应行为：

- `scanner-state.json`：主状态文件，原子写入，保存所有 token 跟踪状态
- `order-errors.jsonl`：只记录买单失败
- `state-changes.jsonl`：每次合法状态流转都会追加一条记录

`dry-run` 额外会导出：

- `scanned-targets.json`
- `scanned-targets.txt`

正式模式不会导出这两个目标列表文件。

## 12. 代码里已经存在、但当前未真正生效的点

下面这些内容在配置里存在，但当前主流程并没有真正用上，文档不能把它们写成“已实现能力”：

- `REPLACE_COOLDOWN_MS`
  - 当前卖出逻辑没有按这个冷却时间做撤单改价
- “卖单自动从 `0.001` 升回 `0.002`”
  - 当前没有这条逻辑
- “已有异常卖单会自动修正”
  - 当前也没有；多数情况下只是识别后直接跳过
- `historical_winners` 的规则命中筛选
  - 当前 profile 因为 `scanAll=true`，实际上是扫描全部通过硬过滤的市场

## 13. 一句话总结当前策略

当前这份代码在你现在的配置下，实际运行规则可以概括为：

- 扫描全部通过硬过滤的活跃市场
- 只买 `YES` token
- 只有当 `0.001` 档买盘深度 `>= 360`，并且 3 秒后复核仍成立时，才挂 `0.001` 的 `POST_ONLY BUY`
- 买到后，优先尝试在 `0.002` 卖出
- 但只要 `0.001` 档买盘深度跌破 `360`，就会进入强制防守路径，撤买单、撤旧卖单，并尽量改为 `0.001` 卖出
- 卖出逻辑当前既支持“降级防守”，也支持在深度恢复后将 `0.001` 卖单主动升回 `0.002`
