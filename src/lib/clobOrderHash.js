import { ethers } from "ethers";

const EXCHANGE_V1 = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE_V1 = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const EXCHANGE_V2 = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_EXCHANGE_V2 = "0xe2222d279d744050d28e00520010520000310F59";
const EXCHANGE_V3 = "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa";

const V1_ORDER = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "taker", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "expiration", type: "uint256" },
  { name: "nonce", type: "uint256" },
  { name: "feeRateBps", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
];

const V2_ORDER = [
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
];

function unwrap(value, versionHint) {
  if (value?.order && value?.version != null) return { order: value.order, version: Number(value.version) };
  return { order: value, version: Number(versionHint) };
}

function sideCode(value) {
  if (value === 0 || value === "0" || String(value).toUpperCase() === "BUY") return 0;
  if (value === 1 || value === "1" || String(value).toUpperCase() === "SELL") return 1;
  throw new TypeError(`unsupported signed order side: ${value}`);
}

export function signedBuyShares(value) {
  const order = value?.order && value?.version != null ? value.order : value;
  const raw = Number(order?.takerAmount);
  return Number.isFinite(raw) && raw >= 0 ? raw / 1_000_000 : NaN;
}

export function signedBuyPrincipalUsd(value) {
  const order = value?.order && value?.version != null ? value.order : value;
  const raw = Number(order?.makerAmount);
  return Number.isFinite(raw) && raw >= 0 ? raw / 1_000_000 : NaN;
}

export function hashSignedClobOrder(value, { version, negRisk = false, chainId = 137 } = {}) {
  const resolved = unwrap(value, version);
  const order = resolved.order;
  const v = resolved.version;
  if (!order || typeof order !== "object") throw new TypeError("signed order is required");
  if (![1, 2, 3].includes(v)) throw new TypeError(`unsupported CLOB order version: ${v}`);
  const isV1 = v === 1;
  const verifyingContract = isV1
    ? (negRisk ? NEG_RISK_EXCHANGE_V1 : EXCHANGE_V1)
    : v === 2
      ? (negRisk ? NEG_RISK_EXCHANGE_V2 : EXCHANGE_V2)
      : EXCHANGE_V3;
  const message = isV1 ? {
    salt: BigInt(order.salt), maker: order.maker, signer: order.signer, taker: order.taker,
    tokenId: BigInt(order.tokenId), makerAmount: BigInt(order.makerAmount), takerAmount: BigInt(order.takerAmount),
    expiration: BigInt(order.expiration), nonce: BigInt(order.nonce), feeRateBps: BigInt(order.feeRateBps),
    side: sideCode(order.side), signatureType: Number(order.signatureType),
  } : {
    salt: BigInt(order.salt), maker: order.maker, signer: order.signer,
    tokenId: BigInt(order.tokenId), makerAmount: BigInt(order.makerAmount), takerAmount: BigInt(order.takerAmount),
    side: sideCode(order.side), signatureType: Number(order.signatureType), timestamp: BigInt(order.timestamp),
    metadata: order.metadata, builder: order.builder,
  };
  return ethers.TypedDataEncoder.hash(
    { name: "Polymarket CTF Exchange", version: String(v), chainId: Number(chainId), verifyingContract },
    { Order: isV1 ? V1_ORDER : V2_ORDER },
    message,
  );
}
