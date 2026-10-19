import type { PayoutMethod, Purpose } from "./types.js";

/**
 * Every product value from docs/SPEC.md "Data model and seed data" in one place. Changing any of
 * these needs sign-off (CLAUDE.md "Ask before"). Amounts in minor units.
 */

/** The one demo user behind the Bearer secret (seeded as Priya Nair, Dubai). */
export const DEMO_USER_ID = "usr_priya";

export interface TierConfig {
  name: string;
  label: string;
  perTransactionMinor: number;
  dailyMinor: number;
  monthlyMinor: number;
  newRecipientFirstTransferMinor: number;
  newRecipientWindowHours: number;
  sourceOfFundsThresholdMinor: number;
  /** Warn when what is left this month after the transfer falls below this fraction. */
  nearMonthlyLimitFraction: number;
  cashPickup: {
    perTransactionMinor: number;
    perRecipientPerYear: number;
    maxReceiveMinor: number; // INR paise
  };
  nextTier: { name: string; requirement: string; monthlyMinor: number };
}

export const VERIFIED_TIER: TierConfig = {
  name: "Verified",
  label: "Verified (Emirates ID)",
  perTransactionMinor: 500_000,
  dailyMinor: 1_000_000,
  monthlyMinor: 2_000_000,
  newRecipientFirstTransferMinor: 200_000,
  newRecipientWindowHours: 24,
  sourceOfFundsThresholdMinor: 1_500_000,
  nearMonthlyLimitFraction: 0.25,
  cashPickup: {
    perTransactionMinor: 918_000,
    perRecipientPerYear: 30,
    maxReceiveMinor: 5_000_000,
  },
  nextTier: { name: "Verified Plus", requirement: "salary proof", monthlyMinor: 6_000_000 },
};

export interface PayoutMethodPolicy {
  feeMinor: number;
  rail: string;
  eta: string;
}

export const PAYOUT_POLICY: Record<PayoutMethod, PayoutMethodPolicy> = {
  bank_deposit: { feeMinor: 1500, rail: "IMPS", eta: "within minutes, 24x7" },
  upi: { feeMinor: 1500, rail: "UPI", eta: "within minutes, 24x7" },
  cash_pickup: { feeMinor: 2000, rail: "MTSS partner", eta: "within 2 hours" },
};

/** FX margin per pair, in basis points; one board rate per corridor, no per-method difference. */
export const FX_MARGIN_BP: Record<string, number> = {
  "AED/INR": 90,
  "USD/INR": 80,
  "GBP/INR": 100,
};

/** CBUAE peg, fixed since 1997. ECB/Frankfurter publish no AED, so AED/INR is derived from USD/INR. */
export const AED_PER_USD = 3.6725;

/**
 * Gulf currencies fixed to the US dollar by their central banks (units per USD). ECB publishes none
 * of them, so their rates are derived from the USD rates. The Kuwaiti dinar follows a basket, so it
 * is not here.
 */
export const USD_PEGS: Record<string, number> = {
  AED: AED_PER_USD,
  SAR: 3.75,
  QAR: 3.64,
  OMR: 0.3845,
  BHD: 0.376,
};

/** The one corridor Nuvio sends money in. Every other pair get_rate quotes is for information. */
export const SENDING_PAIR = "AED/INR";

/** Illustrative "typical bank" benchmark for compare_options, derived from the same mid. */
export const BENCHMARK = { name: "typical bank", marginBp: 250, feeMinor: 2500 };

export const QUOTE_LOCK_MINUTES = 30;
export const TOKEN_TTL_MINUTES = 5;

/**
 * Step-up before money moves (like 3-D Secure on a card payment): a 6-digit code by SMS to the
 * registered phone, valid 5 minutes and never past the confirmation token, 3 wrong tries void
 * the confirmation, and at most 3 codes are sent per confirmation.
 */
export const OTP = { digits: 6, ttlMinutes: 5, maxAttempts: 3, maxSends: 3 } as const;
export const RATES_CACHE_MINUTES = 15;

/** Relationships for which a gift is not flagged as taxable in India. */
export const RELATIVES = new Set([
  "self",
  "mother",
  "father",
  "brother",
  "sister",
  "spouse",
  "wife",
  "husband",
  "son",
  "daughter",
  "grandmother",
  "grandfather",
]);

export const PURPOSE_WORDS: Record<Purpose, string> = {
  family_maintenance: "family maintenance",
  savings_own_account: "savings to your own account",
  education: "education",
  medical: "medical expenses",
  loan_repayment: "loan repayment",
  gift: "a gift",
  property_purchase: "a property purchase",
  business: "business",
};

export const REFUND_ETA = "2-7 working days";
export const REFUND_ETA_SPOKEN = "within 2 to 7 working days";
