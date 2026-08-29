import { ethers } from "ethers";

export const EXCHANGE_V2_ORDER = "tuple(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder,bytes signature)";

export const MATCH_ORDERS_IFACE = new ethers.Interface([
  `function matchOrders(bytes32,${EXCHANGE_V2_ORDER},${EXCHANGE_V2_ORDER}[],uint256,uint256[],uint256,uint256[])`,
]);

export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
};

const lower = (value) => String(value || "").toLowerCase();

function orderFields(tuple) {
  return {
    salt: tuple[0].toString(),
    maker: lower(tuple[1]),
    signer: lower(tuple[2]),
    tokenId: tuple[3].toString(),
    makerAmount: tuple[4].toString(),
    takerAmount: tuple[5].toString(),
    side: Number(tuple[6]),
    signatureType: Number(tuple[7]),
    timestamp: tuple[8].toString(),
    metadata: lower(tuple[9]),
    builder: lower(tuple[10]),
  };
}

export function signedOrderHash(order, verifyingContract, version = "2") {
  return lower(ethers.TypedDataEncoder.hash({
    name: "Polymarket CTF Exchange",
    version: String(version),
    chainId: 137,
    verifyingContract,
  }, ORDER_TYPES, order));
}

/**
 * Decode only the target wallet's signed orders from a settlement transaction.
 *
 * The signed `timestamp` is deliberately named signedTimestampMs below. It is an
 * order-construction field and is NOT treated as submit/fire time. Fire time is
 * inferred independently from order-book changes.
 */
export function decodeTargetOrders(tx, targetWallet, domainVersion = "2") {
  if (!tx?.input || !tx?.to) return [];
  let parsed;
  try {
    parsed = MATCH_ORDERS_IFACE.parseTransaction({ data: tx.input });
  } catch {
    return [];
  }
  if (!parsed || parsed.name !== "matchOrders") return [];
  const target = lower(targetWallet);
  const tagged = [
    { tuple: parsed.args[1], settlementRole: "taker", tupleIndex: 0 },
    ...parsed.args[2].map((tuple, index) => ({ tuple, settlementRole: "maker", tupleIndex: index })),
  ];
  const out = [];
  for (const taggedOrder of tagged) {
    const fields = orderFields(taggedOrder.tuple);
    if (fields.maker !== target) continue;
    const makerAmount = Number(fields.makerAmount) / 1e6;
    const takerAmount = Number(fields.takerAmount) / 1e6;
    const isBuy = fields.side === 0;
    const limitPrice = isBuy
      ? (takerAmount > 0 ? makerAmount / takerAmount : null)
      : (makerAmount > 0 ? takerAmount / makerAmount : null);
    out.push({
      orderHash: signedOrderHash(fields, tx.to, domainVersion),
      settlementRole: taggedOrder.settlementRole,
      tupleIndex: taggedOrder.tupleIndex,
      tradeId: lower(parsed.args[0]),
      contract: lower(tx.to),
      isBuy,
      tokenId: fields.tokenId,
      limitPrice,
      signedShares: isBuy ? takerAmount : makerAmount,
      signedBudgetUsd: isBuy ? makerAmount : takerAmount,
      signedTimestampMs: Number(fields.timestamp),
      salt: fields.salt,
      maker: fields.maker,
      signer: fields.signer,
      signatureType: fields.signatureType,
      metadata: fields.metadata,
      builder: fields.builder,
      signatureBytes: Math.max(0, (String(taggedOrder.tuple[11] || "").length - 2) / 2),
    });
  }
  return out;
}

export function groupSignedOrders(decodedTransactions, publicTrades) {
  const fillsByTxAssetRole = new Map();
  for (const row of publicTrades || []) {
    const key = [lower(row.transactionHash), String(row.asset || ""), row.role === "maker" ? "maker" : "taker"].join(":");
    let fill = fillsByTxAssetRole.get(key);
    if (!fill) {
      fill = { rows: 0, shares: 0, usd: 0, firstPublicTs: Infinity, lastPublicTs: -Infinity,
        slug: row.slug, outcome: row.outcome, conditionId: lower(row.conditionId) };
      fillsByTxAssetRole.set(key, fill);
    }
    const size = Number(row.size) || 0, price = Number(row.price) || 0, ts = Number(row.timestamp) || 0;
    fill.rows++;
    fill.shares += size;
    fill.usd += size * price;
    fill.firstPublicTs = Math.min(fill.firstPublicTs, ts);
    fill.lastPublicTs = Math.max(fill.lastPublicTs, ts);
  }

  const groups = new Map();
  let decodedOrders = 0, joinedOrders = 0;
  for (const tx of decodedTransactions || []) {
    for (const order of tx.orders || []) {
      decodedOrders++;
      const fillKey = [lower(tx.txHash), order.tokenId, order.settlementRole].join(":");
      const fill = fillsByTxAssetRole.get(fillKey) || null;
      if (fill) joinedOrders++;
      let group = groups.get(order.orderHash);
      if (!group) {
        group = {
          orderHash: order.orderHash,
          tokenId: order.tokenId,
          tradeId: order.tradeId,
          contract: order.contract,
          isBuy: order.isBuy,
          limitPrice: order.limitPrice,
          signedShares: order.signedShares,
          signedBudgetUsd: order.signedBudgetUsd,
          signedTimestampMs: order.signedTimestampMs,
          salt: order.salt,
          signer: order.signer,
          signatureType: order.signatureType,
          metadata: order.metadata,
          builder: order.builder,
          settlementRoles: [],
          settlements: [],
          fillRows: 0,
          filledShares: 0,
          filledUsd: 0,
          firstPublicTs: null,
          lastPublicTs: null,
        };
        groups.set(order.orderHash, group);
      }
      if (!group.settlementRoles.includes(order.settlementRole)) group.settlementRoles.push(order.settlementRole);
      group.settlements.push({
        txHash: lower(tx.txHash),
        role: order.settlementRole,
        ...(fill ? {
          slug: fill.slug,
          outcome: fill.outcome,
          conditionId: fill.conditionId,
          rows: fill.rows,
          shares: fill.shares,
          usd: fill.usd,
          vwap: fill.shares > 0 ? fill.usd / fill.shares : null,
          firstPublicTs: fill.firstPublicTs,
          lastPublicTs: fill.lastPublicTs,
        } : { unmatchedPublicFill: true }),
      });
      if (fill) {
        group.fillRows += fill.rows;
        group.filledShares += fill.shares;
        group.filledUsd += fill.usd;
        group.firstPublicTs = group.firstPublicTs == null ? fill.firstPublicTs : Math.min(group.firstPublicTs, fill.firstPublicTs);
        group.lastPublicTs = group.lastPublicTs == null ? fill.lastPublicTs : Math.max(group.lastPublicTs, fill.lastPublicTs);
      }
    }
  }
  return {
    decodedOrders,
    joinedOrders,
    groups: [...groups.values()].map((group) => ({
      ...group,
      settlementRoles: group.settlementRoles.sort(),
      settlements: group.settlements.sort((a, b) => (a.firstPublicTs ?? Infinity) - (b.firstPublicTs ?? Infinity)),
      vwap: group.filledShares > 0 ? group.filledUsd / group.filledShares : null,
      fillFractionOfSignedShares: group.signedShares > 0 ? group.filledShares / group.signedShares : null,
    })).sort((a, b) => (a.firstPublicTs ?? Infinity) - (b.firstPublicTs ?? Infinity)),
  };
}
