# Polymarket Scanner

自动扫描 Polymarket 当前活跃市场，对通过风控过滤的 `YES` token 挂 `BUY` 限价单。

当前默认策略：

- 每 1 小时扫描一次全市场
- `FILTER_PROFILE=historical_winners` 时直接扫描全部市场
- 跳过已经挂过、买过、或当前还有未成交订单的 token

## 当前筛选逻辑

`FILTER_PROFILE=historical_winners` 时，不再按事件类型做命中筛选，而是直接扫描全部活跃市场。

当前保留的硬过滤只有：

- 非活跃或不可交易市场
- 临近结算市场
- 24 小时无成交且无流动性的市场
- 无法解析出 `YES` token ID 的市场

## 去重规则

正式运行时，脚本会同时跳过以下 token：

- 当前账户里已经存在 open order 的 token
- 交易历史里已经买入过的 token
- 本地状态文件 `scanner-state.json` 里已经记录为挂过单或买过的 token

这意味着脚本支持持续运行；新事件出来后会继续扫，但不会重复挂到你已经挂过或买过的同一 token。

## 订单方式

脚本当前下的是 `BUY` 限价单，不是市价单。

下单参数来自：

- `ORDER_PRICE`
- `ORDER_SIZE`
- `BUY_DEPTH_DEBOUNCE_MS`
- `SELL_DEPTH_DEBOUNCE_MS`

默认值：

- `ORDER_PRICE=0.001`
- `ORDER_SIZE=100`

所以单笔订单的最大名义占用约为：

`0.001 * 100 = 0.1 USDC`

说明：

- 这是按“全部成交”计算的最大本金占用
- 如果只部分成交，实际占用会更少
- 若平台额外收手续费，手续费不包含在这 `0.1 USDC` 里

## 环境要求

- Node.js 18+
- 可用于 Polymarket 的钱包私钥
- 若在中国大陆或受限网络环境，通常需要代理

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 为 `.env`，然后按需修改：

```env
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
HTTPS_PROXY=http://127.0.0.1:7897
FILTER_PROFILE=historical_winners
ORDER_PRICE=0.001
ORDER_SIZE=100
BUY_DEPTH_DEBOUNCE_MS=3000
SELL_DEPTH_DEBOUNCE_MS=3000
RUN_FOREVER=true
SCAN_INTERVAL_MS=3600000
MAX_PAGES=300
```

常用配置说明：

- `PRIVATE_KEY`: 正式下单必填；纯 `dry-run` 可不填
- `HTTPS_PROXY`: 代理地址；如果代理没开，会报 `ECONNREFUSED`
- `DISABLE_PROXY=true`: 强制忽略系统代理，直接连接
- `FILTER_PROFILE`: 当前建议用 `historical_winners`
- `ORDER_PRICE`: 限价单价格
- `ORDER_SIZE`: 每笔下单的 shares 数量
- 买入前要求 `0.001` 档买盘达到 `3 * ORDER_SIZE`，并在防抖等待后再次确认
- 卖出侧只保留一个强制清仓触发器：如果 `0.001` 档买盘小于 `3 * ORDER_SIZE`，或者已经没有 `0.001` 买盘，就撤掉该 token 的未完成买单；若已有持仓，则立即按 `0.001` 限价卖出全部；否则按 `0.002` 限价卖出全部
- `BUY_DEPTH_DEBOUNCE_MS` / `SELL_DEPTH_DEBOUNCE_MS`: 3 倍深度判断的防抖时间
- `RUN_FOREVER=true`: 持续扫描
- `SCAN_INTERVAL_MS=3600000`: 每 1 小时扫描一次
- `MAX_PAGES=300`: 当前可扫最多约 30000 个市场
- `STATE_FILE`: 本地去重状态文件
- `ERROR_LOG_FILE`: 正式运行的错误日志文件，默认 `order-errors.jsonl`

## 使用

只扫描，不下单：

```bash
npm run dry-run
```

正式运行：

```bash
npm run start
```

检查账户上下文是否一致：

```bash
npm run doctor
```

行为区别：

- `dry-run` 会导出命中的市场到 `scanned-targets.json` 和 `scanned-targets.txt`
- 正式运行不会导出命中列表
- 正式运行只会在下单失败时，把错误原因追加写入 `order-errors.jsonl`
- `doctor` 会输出 signer、signature type、effective funder、最近成交里的 owner/maker，以及最近买入 token 的 conditional balance

## 输出说明

`dry-run` 会输出：

- 各筛选类别命中数量
- 排除的年度事件数量
- 排除的加密事件数量
- 去重前的目标总数
- 估算总占用金额
- 导出的目标列表文件

正式运行会输出：

- 钱包地址
- 当前 open order 去重数量
- 历史买入去重数量
- 每笔订单的成功/失败结果
- 最终成功数、失败数、估算占用金额
- 如有失败，对应错误日志文件位置

## 常见问题

### 1. 报 `ECONNREFUSED` / `ECONNRESET` / `fetch failed`

先检查：

- 代理地址是否正确
- 代理程序是否真的在监听对应端口
- 如果不想走代理，是否已经设置 `DISABLE_PROXY=true`

例如你当前可用配置是：

```env
HTTPS_PROXY=http://127.0.0.1:7897
```

### 2. 能不能看到扫到了哪些事件？

可以。

执行：

```bash
npm run dry-run
```

然后查看：

- `scanned-targets.txt`
- `scanned-targets.json`

### 3. 持续扫描会不会重复挂同一个单？

按当前代码逻辑，不会重复挂到以下 token：

- 当前还有 open order 的
- 你历史上已经买过的
- 本地状态里已经记过的

但前提是：

- 你不要手动删除 `scanner-state.json`
- 同一个 token 的识别字段没有被平台改掉

## 风险提示

- 当前筛选规则本质上仍然是启发式规则，不保证命中一定优质
- 脚本默认对命中的 token 挂 `YES` 买单
- `MAX_PAGES` 设得太小会漏掉后面的市场
- 首次正式运行可能会触发 allowance 设置
