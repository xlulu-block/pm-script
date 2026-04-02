import { AssetType, OrderType, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { config } from "./config.js";

const CONDITIONAL_TOKEN_DECIMALS = 6;

function getErrorMessage(err) {
  if (typeof err === "string") return err;
  return err?.message || String(err);
}

export async function cancelOrderById(client, orderID) {
  try {
    await client.cancelOrder({ orderID });
    console.log(`[ORDER] 已取消订单 ${orderID}`);
    return { success: true };
  } catch (err) {
    const msg = getErrorMessage(err);
    console.error(`[ORDER] 取消订单 ${orderID} 失败: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function cancelOrdersForToken(client, tokenID, side = null) {
  try {
    const openOrders = await client.getOpenOrders({ asset_id: tokenID });
    if (!Array.isArray(openOrders) || openOrders.length === 0) {
      return { success: true, cancelledCount: 0 };
    }
    const filteredOrders = side
      ? openOrders.filter((order) => String(order?.side || "").toUpperCase() === String(side).toUpperCase())
      : openOrders;
    const orderIDs = filteredOrders.map((o) => o.id).filter(Boolean);
    if (orderIDs.length === 0) {
      return { success: true, cancelledCount: 0 };
    }
    await client.cancelOrders(orderIDs);
    const sideLabel = side ? ` ${String(side).toUpperCase()}` : "";
    console.log(`[ORDER] 已取消 token ${tokenID.slice(0, 12)}... 的 ${orderIDs.length}${sideLabel} 笔订单`);
    return { success: true, cancelledCount: orderIDs.length };
  } catch (err) {
    const msg = getErrorMessage(err);
    const sideLabel = side ? ` ${String(side).toUpperCase()}` : "";
    console.error(`[ORDER] 取消 token ${tokenID.slice(0, 12)}... 的${sideLabel}订单失败: ${msg}`);
    return { success: false, cancelledCount: 0, error: msg };
  }
}

export async function placeSellOrder(client, tokenID, price, size, orderBookOptions) {
  try {
    const orderParams = { tokenID, price: Number(price), side: Side.SELL, size };
    const order = await client.createOrder(orderParams, orderBookOptions);
    const response = await client.postOrder(order, OrderType.GTC);

    const orderID = response?.orderID || response?.id || null;
    console.log(`[ORDER] SELL 下单成功 token=${tokenID.slice(0, 12)}... price=${price} size=${size} orderID=${orderID || "n/a"}`);
    return { success: true, orderID };
  } catch (err) {
    const msg = getErrorMessage(err);
    console.error(`[ORDER] SELL 下单失败 token=${tokenID.slice(0, 12)}... price=${price}: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function getOpenOrdersForToken(client, tokenID) {
  try {
    const openOrders = await client.getOpenOrders({ asset_id: tokenID });
    const buyOrders = [];
    const sellOrders = [];
    if (Array.isArray(openOrders)) {
      for (const order of openOrders) {
        if (order.side === "BUY") buyOrders.push(order);
        else if (order.side === "SELL") sellOrders.push(order);
      }
    }
    return { buyOrders, sellOrders };
  } catch (err) {
    console.warn(`[ORDER] 获取 token ${tokenID.slice(0, 12)}... 的挂单失败: ${getErrorMessage(err)}`);
    return { buyOrders: [], sellOrders: [] };
  }
}

export async function getFilledShares(client, tokenID) {
  try {
    const result = await client.getBalanceAllowance({
      asset_type: AssetType.CONDITIONAL,
      token_id: tokenID,
    });
    return Number(ethers.utils.formatUnits(result?.balance || "0", CONDITIONAL_TOKEN_DECIMALS));
  } catch (err) {
    console.warn(`[ORDER] 获取 token ${tokenID.slice(0, 12)}... 的余额失败: ${getErrorMessage(err)}`);
    return 0;
  }
}

export async function getOrderStatus(client, orderID) {
  try {
    const order = await client.getOrder(orderID);
    return order || null;
  } catch {
    return null;
  }
}
