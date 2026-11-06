/**
 * Scenario engine (sandbox LLD §4, api-conventions §8). Pure: no I/O, no clock.
 *
 * The scenario key is the last two digits of the payment's pricing amount (fiat minor units or asset
 * base units, `scenario_amount`), falling back to the quoted amount. A timeline is computed once,
 * when the deposit happens, from the scenario, the deposited amount and the quote:
 *
 * | key | after a sufficient deposit                                                     |
 * |-----|--------------------------------------------------------------------------------|
 * | 00  | KNOWN_DEPOSIT_TX (1 s) → PROCESSING (3 s) → SUCCESS (5 s), exact amount           |
 * | 01  | same, SUCCESS after 120 s                                                       |
 * | 02  | (deposit below minAmountIn) INCOMPLETE_DEPOSIT → REFUNDED at the deadline          |
 * | 03  | (deposit above amountIn) SUCCESS, the excess refunded                            |
 * | 04  | FAILED after PROCESSING                                                         |
 * | 05  | SUCCESS, but the destination receives amountOut − 1 (short)                      |
 * | 06  | like 00; a deposit also pays the older open quotes of the same payment          |
 * | 07  | SUCCESS 5 min after the deposit deadline (late settlement)                       |
 *
 * The outcome follows the deposit, as with 1Click EXACT_OUTPUT: below `minAmountIn` the deposit is
 * refunded at the deadline (`PARTIAL_DEPOSIT`), above `amountIn` the excess is refunded with the
 * success, after `timeWhenInactive` it is refunded. Offsets scale with NP_SANDBOX_TIME_SCALE.
 */

export const SCENARIOS = ["00", "01", "02", "03", "04", "05", "06", "07"] as const;
export type Scenario = (typeof SCENARIOS)[number];

/** Provider statuses the sandbox emits (1Click v0). */
export type ProviderStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export const TERMINAL: ReadonlySet<ProviderStatus> = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export function isTerminal(s: string): boolean {
  return TERMINAL.has(s as ProviderStatus);
}

/** Last two digits of an amount string; unlisted suffixes are the happy path `00`. */
export function scenarioOf(amount: string): Scenario {
  if (!/^\d+$/.test(amount)) return "00";
  const key = amount.padStart(2, "0").slice(-2);
  return (SCENARIOS as readonly string[]).includes(key) ? (key as Scenario) : "00";
}

/** One step of a timeline; `at` is epoch ms. */
export interface Step {
  readonly status: ProviderStatus;
  readonly at: number;
  /** SUCCESS: amount the recipient receives. */
  readonly delivered?: string;
  /** SUCCESS/REFUNDED: amount returned to the payer's refund address. */
  readonly refunded?: string;
  readonly refundReason?: string;
}

export interface TimelineInput {
  readonly scenario: Scenario;
  /** When the deposit was made (epoch ms). */
  readonly depositAt: number;
  readonly deposited: bigint;
  readonly amountIn: bigint;
  readonly minAmountIn: bigint;
  readonly amountOut: bigint;
  /** Quote deadline (epoch ms): deposits after it are refunded. */
  readonly deadline: number;
  /** Multiplies every relative offset (1.0 real time; the testbed may use 0.1). */
  readonly timeScale: number;
}

const SECOND = 1_000;

export function timeline(i: TimelineInput): Step[] {
  if (!(i.timeScale > 0)) throw new RangeError("timeScale must be positive");
  if (i.deposited <= 0n) throw new RangeError("a deposit must be positive");
  const at = (seconds: number) => i.depositAt + Math.round(seconds * SECOND * i.timeScale);
  const deposited = i.deposited.toString();

  if (i.depositAt > i.deadline) {
    return [
      { status: "KNOWN_DEPOSIT_TX", at: at(1) },
      { status: "REFUNDED", at: at(3), refunded: deposited, refundReason: "DEPOSIT_AFTER_DEADLINE" },
    ];
  }
  if (i.deposited < i.minAmountIn) {
    return [
      { status: "INCOMPLETE_DEPOSIT", at: at(1) },
      {
        status: "REFUNDED",
        at: Math.max(i.deadline, at(2)),
        refunded: deposited,
        refundReason: "PARTIAL_DEPOSIT",
      },
    ];
  }
  const excess = i.deposited > i.amountIn ? i.deposited - i.amountIn : 0n;
  const success = (when: number): Step => ({
    status: "SUCCESS",
    at: when,
    delivered: (i.scenario === "05" ? i.amountOut - 1n : i.amountOut).toString(),
    refunded: excess.toString(),
  });
  const head: Step[] = [
    { status: "KNOWN_DEPOSIT_TX", at: at(1) },
    { status: "PROCESSING", at: at(3) },
  ];
  switch (i.scenario) {
    case "01":
      return [...head, success(at(120))];
    case "04":
      return [...head, { status: "FAILED", at: at(5) }];
    case "07":
      return [...head, success(Math.max(at(5), i.deadline + Math.round(300 * SECOND * i.timeScale)))];
    default:
      return [...head, success(at(5))];
  }
}

/** Steps due at `now` that were not applied yet (`applied` = count already applied), in order. */
export function dueSteps(steps: readonly Step[], applied: number, now: number): Step[] {
  const out: Step[] = [];
  for (const s of steps.slice(applied)) {
    if (s.at > now) break;
    out.push(s);
  }
  return out;
}

/** When the next pending step is due (epoch ms), or null when the timeline is finished. */
export function nextDue(steps: readonly Step[], applied: number): number | null {
  return steps[applied]?.at ?? null;
}

// ---------------------------------------------------------------------------------------------
// Manual control (`POST /sim/advance`, payments' test helper)
// ---------------------------------------------------------------------------------------------

export type AdvanceTarget = "deposit" | "processing" | "success" | "refund" | "fail";

export interface AdvanceInput {
  readonly current: ProviderStatus;
  readonly scenario: Scenario;
  readonly deposited: bigint | null;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

export type AdvancePlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** A deposit of `amountIn` must be recorded first. */
      deposit: boolean;
      step: Omit<Step, "at">;
    };

/**
 * What `advance(to)` does. Advancing switches the quote to manual mode: the timeline stops and only
 * further advances move it. Terminal quotes cannot move; `deposit` needs a quote without a deposit.
 */
export function planAdvance(i: AdvanceInput, to: AdvanceTarget): AdvancePlan {
  if (isTerminal(i.current)) return { ok: false, reason: `the quote is ${i.current}` };
  const needsDeposit = i.deposited === null;
  const deposited = i.deposited ?? i.amountIn;
  switch (to) {
    case "deposit":
      if (!needsDeposit) return { ok: false, reason: "a deposit was already made" };
      return { ok: true, deposit: true, step: { status: "KNOWN_DEPOSIT_TX" } };
    case "processing":
      return { ok: true, deposit: needsDeposit, step: { status: "PROCESSING" } };
    case "success": {
      const excess = deposited > i.amountIn ? deposited - i.amountIn : 0n;
      return {
        ok: true,
        deposit: needsDeposit,
        step: {
          status: "SUCCESS",
          delivered: (i.scenario === "05" ? i.amountOut - 1n : i.amountOut).toString(),
          refunded: excess.toString(),
        },
      };
    }
    case "refund":
      return {
        ok: true,
        deposit: needsDeposit,
        step: { status: "REFUNDED", refunded: deposited.toString(), refundReason: "MANUAL" },
      };
    case "fail":
      return { ok: true, deposit: false, step: { status: "FAILED" } };
  }
}
