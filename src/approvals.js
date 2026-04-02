import { ethers } from "ethers";
import { config } from "./config.js";
import { getPolygonProvider } from "./rpc.js";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

export const POLYMARKET_CONTRACTS = Object.freeze({
  USDC_E: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  CTF: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  NEG_RISK_CTF_EXCHANGE: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  NEG_RISK_ADAPTER: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
});

export const USDC_SPENDERS = Object.freeze([
  { key: "CTF", address: POLYMARKET_CONTRACTS.CTF },
  { key: "CTF_EXCHANGE", address: POLYMARKET_CONTRACTS.CTF_EXCHANGE },
  { key: "NEG_RISK_CTF_EXCHANGE", address: POLYMARKET_CONTRACTS.NEG_RISK_CTF_EXCHANGE },
  { key: "NEG_RISK_ADAPTER", address: POLYMARKET_CONTRACTS.NEG_RISK_ADAPTER },
]);

function formatUsdc(value) {
  return ethers.utils.formatUnits(value, 6);
}

function formatGwei(value) {
  return ethers.utils.formatUnits(value, "gwei");
}

async function getApprovalFeeOverrides(provider) {
  const minPriorityFeePerGas = ethers.utils.parseUnits(
    String(config.POLYGON_MIN_PRIORITY_FEE_GWEI),
    "gwei"
  );

  const [feeData, latestBlock] = await Promise.all([
    provider.getFeeData(),
    provider.getBlock("latest"),
  ]);

  const maxPriorityFeePerGas =
    feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas.gt(minPriorityFeePerGas)
      ? feeData.maxPriorityFeePerGas
      : minPriorityFeePerGas;

  if (latestBlock?.baseFeePerGas) {
    const networkSuggestedMaxFee =
      feeData.maxFeePerGas && feeData.maxFeePerGas.gt(0)
        ? feeData.maxFeePerGas
        : null;
    const floorMaxFeePerGas = latestBlock.baseFeePerGas.mul(2).add(maxPriorityFeePerGas);
    const maxFeePerGas =
      networkSuggestedMaxFee && networkSuggestedMaxFee.gt(floorMaxFeePerGas)
        ? networkSuggestedMaxFee
        : floorMaxFeePerGas;

    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      type: 2,
    };
  }

  const gasPrice =
    feeData.gasPrice && feeData.gasPrice.gt(minPriorityFeePerGas)
      ? feeData.gasPrice
      : minPriorityFeePerGas;

  return {
    gasPrice,
  };
}

export function getRequiredCollateralBaseUnits(orderPrice, orderSize) {
  const microUsdc = Math.ceil(Number(orderPrice) * Number(orderSize) * 1_000_000);
  return ethers.BigNumber.from(String(microUsdc));
}

async function collectAllowanceSnapshot(usdc, owner, minimumAllowance) {
  const [balance, spenderAllowances] = await Promise.all([
    usdc.balanceOf(owner),
    Promise.all(
      USDC_SPENDERS.map(async (spender) => ({
        ...spender,
        allowance: await usdc.allowance(owner, spender.address),
      }))
    ),
  ]);

  const missing = spenderAllowances.filter((entry) => entry.allowance.lt(minimumAllowance));

  return { balance, allowances: spenderAllowances, missing };
}

export async function ensureEoaCollateralApprovals(
  wallet,
  preferredRpcUrl,
  minimumAllowance,
  autoApprove = true
) {
  const { provider, rpcUrl } = await getPolygonProvider(preferredRpcUrl);
  const signer = wallet.connect(provider);
  const usdc = new ethers.Contract(POLYMARKET_CONTRACTS.USDC_E, ERC20_ABI, signer);

  const before = await collectAllowanceSnapshot(usdc, wallet.address, minimumAllowance);
  const approvals = [];

  if (autoApprove) {
    const feeOverrides = await getApprovalFeeOverrides(provider);

    for (const entry of before.missing) {
      if ("gasPrice" in feeOverrides) {
        console.log(
          `[CLOB] Approving ${entry.key} with gasPrice=${formatGwei(feeOverrides.gasPrice)} gwei`
        );
      } else {
        console.log(
          `[CLOB] Approving ${entry.key} with maxPriorityFeePerGas=${formatGwei(feeOverrides.maxPriorityFeePerGas)} gwei, maxFeePerGas=${formatGwei(feeOverrides.maxFeePerGas)} gwei`
        );
      }

      const tx = await usdc.approve(
        entry.address,
        ethers.constants.MaxUint256,
        feeOverrides
      );
      approvals.push({
        spender: entry.key,
        address: entry.address,
        hash: tx.hash,
      });
      await tx.wait();
    }
  }

  const after = before.missing.length > 0 && autoApprove
    ? await collectAllowanceSnapshot(usdc, wallet.address, minimumAllowance)
    : before;

  return {
    rpcUrl,
    balance: after.balance,
    minimumAllowance,
    approvals,
    missingBefore: before.missing,
    missingAfter: after.missing,
    allowancesBefore: before.allowances,
    allowancesAfter: after.allowances,
    balanceFormatted: formatUsdc(after.balance),
    minimumAllowanceFormatted: formatUsdc(minimumAllowance),
  };
}
