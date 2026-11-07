/** Explorer mirror rows (sandbox LLD §3 `GET /api/v0/transactions`). */
import { ExplorerTransaction } from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import {
  EXPLORER_DEFAULT_STATUSES,
  type ExplorerSource,
  explorerRow,
  explorerStatus,
  statesForStatuses,
} from "../../src/domain/explorer.js";

const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const src: ExplorerSource = {
  request: {
    originAsset: USDC_BASE,
    destinationAsset: USDC_NEAR,
    recipient: "merchant.near",
    refundTo: "0x52908400098527886e0f7030069857d2e4169ee7",
    depositType: "ORIGIN_CHAIN",
    recipientType: "INTENTS",
    refundType: "ORIGIN_CHAIN",
    referral: "nearpay",
  },
  appFees: [
    { recipient: "treasury.nearpay.near", fee: 25, limitOrderId: null } as never,
    { recipient: "sandbox-oneclick-fees.near", fee: 25 },
  ],
  refundFee: "0",
  depositAddress: "0x76b4c56085ed136a8744d52be956396624a730e8",
  depositMemo: null,
  state: "PENDING_DEPOSIT",
  createdAt: new Date("2026-11-07T12:00:00.500Z"),
  depositedAmount: null,
  deliveredAmount: null,
  refundReason: null,
  nearTxHashes: [],
  originTxHashes: [],
  destinationTxHashes: [],
};

describe("explorerStatus / statesForStatuses", () => {
  it("reads KNOWN_DEPOSIT_TX as PROCESSING and keeps the documented statuses", () => {
    expect(explorerStatus("KNOWN_DEPOSIT_TX")).toBe("PROCESSING");
    for (const s of ["PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED"])
      expect(explorerStatus(s)).toBe(s);
  });

  it("defaults to the Explorer default (no *_DEPOSIT statuses)", () => {
    expect(EXPLORER_DEFAULT_STATUSES).toEqual(["FAILED", "PROCESSING", "REFUNDED", "SUCCESS"]);
    expect(statesForStatuses(undefined)).toEqual(["FAILED", "KNOWN_DEPOSIT_TX", "PROCESSING", "REFUNDED", "SUCCESS"]);
  });

  it("maps an explicit list, PROCESSING including KNOWN_DEPOSIT_TX; unknown values match nothing", () => {
    expect(statesForStatuses("PENDING_DEPOSIT,INCOMPLETE_DEPOSIT")).toEqual(["INCOMPLETE_DEPOSIT", "PENDING_DEPOSIT"]);
    expect(statesForStatuses("PROCESSING")).toEqual(["KNOWN_DEPOSIT_TX", "PROCESSING"]);
    expect(statesForStatuses("SUCCESS,BOGUS")).toEqual(["SUCCESS"]);
    expect(statesForStatuses("BOGUS")).toEqual([]);
  });
});

describe("explorerRow", () => {
  it("renders a pending quote with zero amounts, a schema-valid row", () => {
    const row = explorerRow(src);
    expect(ExplorerTransaction.parse(row)).toEqual(row);
    expect(row).toMatchObject({
      status: "PENDING_DEPOSIT",
      createdAt: "2026-11-07T12:00:00.500Z",
      createdAtTimestamp: Date.parse("2026-11-07T12:00:00Z") / 1000,
      amountIn: "0",
      amountInFormatted: "0",
      amountInUsd: "0",
      amountOut: "0",
      referral: "nearpay",
      depositMemo: null,
      refundFee: "0",
      refundFeeFormatted: "0",
      refundReason: null,
      intentHashes: null,
      senders: [],
    });
    expect(row.appFees).toEqual([
      { recipient: "treasury.nearpay.near", fee: 25 },
      { recipient: "sandbox-oneclick-fees.near", fee: 25 },
    ]);
  });

  it("keeps amounts at 0 while in flight, even with a deposit", () => {
    const row = explorerRow({
      ...src,
      state: "KNOWN_DEPOSIT_TX",
      depositedAmount: "2014018",
      originTxHashes: ["0xab"],
    });
    expect([row.status, row.amountIn, row.amountOut]).toEqual(["PROCESSING", "0", "0"]);
    expect(row.originChainTxHashes).toEqual(["0xab"]);
  });

  it("shows the deposit and the delivered amount once settled", () => {
    const row = explorerRow({
      ...src,
      state: "SUCCESS",
      depositedAmount: "2014018",
      deliveredAmount: "2000017",
      nearTxHashes: ["h1"],
      destinationTxHashes: ["h1"],
    });
    expect(row).toMatchObject({
      amountIn: "2014018",
      amountInFormatted: "2.014018",
      amountInUsd: "2.0140",
      amountOut: "2000017",
      amountOutFormatted: "2.000017",
      nearTxHashes: ["h1"],
      destinationChainTxHashes: ["h1"],
    });
  });

  it("shows the deposit but no output for a refunded execution, with its reason", () => {
    const row = explorerRow({
      ...src,
      state: "REFUNDED",
      depositedAmount: "5",
      deliveredAmount: null,
      refundReason: "PARTIAL_DEPOSIT",
    });
    expect([row.amountIn, row.amountOut, row.refundReason]).toEqual(["5", "0", "PARTIAL_DEPOSIT"]);
  });

  it("handles a quote without referral, app fees or refund fee, a memo, and a non-zero refund fee", () => {
    const row = explorerRow({
      ...src,
      request: { ...src.request, referral: undefined },
      appFees: undefined,
      refundFee: undefined,
      depositMemo: "1234567890",
    });
    expect([row.referral, row.appFees, row.refundFee, row.depositMemo]).toEqual([null, null, "0", "1234567890"]);
    expect(explorerRow({ ...src, refundFee: "2400" }).refundFeeFormatted).toBe("0.0024");
  });

  it("renders unknown assets with raw zero amounts instead of failing", () => {
    const row = explorerRow({
      ...src,
      request: { ...src.request, originAsset: "nep141:unknown.near", destinationAsset: "nep141:unknown.near" },
      state: "SUCCESS",
      depositedAmount: "10",
      deliveredAmount: "9",
      refundFee: "1",
    });
    expect([row.amountIn, row.amountOut, row.refundFeeFormatted]).toEqual(["0", "0", "0"]);
  });
});
