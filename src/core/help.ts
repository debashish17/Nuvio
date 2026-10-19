import { aedNumber, sayAed, sayInr } from "./money.js";
import { OTP, PAYOUT_POLICY, QUOTE_LOCK_MINUTES, REFUND_ETA, VERIFIED_TIER } from "./policy.js";
import type { TierConfig } from "./policy.js";

/**
 * get_help (SPEC tool 13): Nuvio's own answers to general remittance questions, so the assistant
 * never answers rules, documents or tax from general knowledge. Provider rules come from the same
 * policy values the limits and quotes enforce; the regulatory points name their source.
 *
 * REVIEW: this text is written for the hackathon and must be reviewed by a person who owns
 * compliance content before it is relied on. `last_reviewed` stays null until that review
 * happens. Tax: India's Income-tax Act, 2025 replaces the 1961 Act from April 2026, so the
 * reviewer should confirm the current gift provision before naming a section.
 */

export const HELP_TOPICS = [
  "overview",
  "documents",
  "how_to_send",
  "recipients",
  "payout_methods",
  "fees_and_rates",
  "limits_and_tiers",
  "tracking_and_receipts",
  "cancellations_and_refunds",
  "nre_nro",
  "lrs",
  "tax",
  "safety",
] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export interface HelpAnswer {
  topic: HelpTopic;
  title: string;
  /** Two or three sentences, written to be read aloud. */
  answer: string;
  points: string[];
  source: string;
  /** Date of the compliance review; null until one has happened. */
  last_reviewed: string | null;
  disclaimer?: string;
  related: HelpTopic[];
}

const LAST_REVIEWED: string | null = null; // not yet reviewed: see REVIEW above
const NUVIO = "Nuvio Remit customer policy (simulated for this demo)";
const GENERAL =
  "General information, not legal or tax advice. Rules can change; check with your bank or a tax adviser.";

export function helpAnswer(topic: HelpTopic, tier: TierConfig = VERIFIED_TIER): HelpAnswer {
  const t = tier;
  const cash = t.cashPickup;
  const card = (a: Omit<HelpAnswer, "topic" | "last_reviewed">): HelpAnswer => ({
    topic,
    last_reviewed: LAST_REVIEWED,
    ...a,
  });
  switch (topic) {
    case "overview":
      return card({
        title: "What I can help with",
        answer:
          "I can explain the documents you need, the steps to send money, recipients, payout methods, fees and rates, limits, tracking, cancellations, NRE and NRO accounts, the Liberalised Remittance Scheme, tax on money received in India, and staying safe.",
        points: HELP_TOPICS.filter((x) => x !== "overview").map((x) => x.replaceAll("_", " ")),
        source: NUVIO,
        related: ["how_to_send", "documents"],
      });
    case "documents":
      return card({
        title: "Documents you may need",
        answer: `Your Emirates ID is enough for the ${t.name} tier, with up to ${sayAed(t.monthlyMinor)} a month. To raise that to ${sayAed(t.nextTier.monthlyMinor)}, add ${t.nextTier.requirement} in the Nuvio app. A single transfer of ${sayAed(t.sourceOfFundsThresholdMinor)} or more needs proof of where the money came from, such as a salary certificate or bank statement.`,
        points: [
          "Open an account: Emirates ID (and passport) checked in the Nuvio app",
          `${t.nextTier.name}: ${t.nextTier.requirement}, such as a salary certificate or 3 months of bank statements`,
          `Source of funds: needed for a transfer of ${aedNumber(t.sourceOfFundsThresholdMinor)} AED or more`,
          "Property payments: the sale agreement, before sending",
          "If a transfer is under review: only what the review asks for, uploaded in the app",
        ],
        source: NUVIO,
        related: ["limits_and_tiers", "tracking_and_receipts"],
      });
    case "how_to_send":
      return card({
        title: "How sending works",
        answer: `Ask me to send an amount to a saved recipient. I quote the fee, the rate and the guaranteed receive amount, read the whole transfer back, and after your yes I text a ${OTP.digits}-digit code to your phone; the money moves only when you read me that code.`,
        points: [
          "1. The recipient is saved and name-checked in the Nuvio app",
          `2. Quote: fee, rate and receive amount, held ${QUOTE_LOCK_MINUTES} minutes`,
          "3. Read-back: every detail, then your yes",
          `4. Approval: the ${OTP.digits}-digit code texted to your phone`,
          "5. Track it: payment received, checking details, sent to the payout partner, paid out",
        ],
        source: NUVIO,
        related: ["fees_and_rates", "tracking_and_receipts", "safety"],
      });
    case "recipients":
      return card({
        title: "Recipients",
        answer: `Recipients are added and changed only in the Nuvio app, never by voice, and their name is checked with their bank. The first transfer to a recipient added in the last ${t.newRecipientWindowHours} hours is capped at ${sayAed(t.newRecipientFirstTransferMinor)}.`,
        points: [
          "Bank deposit: account number and IFSC",
          "UPI: the recipient's UPI ID",
          "Cash pickup: name as on their ID, mobile number",
          `New recipient: first transfer within ${t.newRecipientWindowHours} hours capped at ${aedNumber(t.newRecipientFirstTransferMinor)} AED`,
        ],
        source: NUVIO,
        related: ["payout_methods", "safety"],
      });
    case "payout_methods":
      return card({
        title: "Ways your recipient can receive money",
        answer: `Bank deposit by IMPS and UPI both arrive within minutes, any time. Cash pickup arrives within about two hours and follows India's Money Transfer Service Scheme, so it is capped at ${sayInr(cash.maxReceiveMinor)} in cash and ${cash.perRecipientPerYear} pickups per recipient a year.`,
        points: [
          `Bank deposit (${PAYOUT_POLICY.bank_deposit.rail}): ${PAYOUT_POLICY.bank_deposit.eta}, fee ${aedNumber(PAYOUT_POLICY.bank_deposit.feeMinor)} AED`,
          `UPI: ${PAYOUT_POLICY.upi.eta}, fee ${aedNumber(PAYOUT_POLICY.upi.feeMinor)} AED`,
          `Cash pickup (${PAYOUT_POLICY.cash_pickup.rail}): ${PAYOUT_POLICY.cash_pickup.eta}, fee ${aedNumber(PAYOUT_POLICY.cash_pickup.feeMinor)} AED, at most ${aedNumber(cash.perTransactionMinor)} AED per transfer`,
        ],
        source: `${NUVIO}; cash pickup caps from the RBI Master Direction on the Money Transfer Service Scheme`,
        related: ["fees_and_rates", "recipients"],
      });
    case "fees_and_rates":
      return card({
        title: "Fees and rates",
        answer: `The fee is ${sayAed(PAYOUT_POLICY.bank_deposit.feeMinor)} for bank deposit or UPI and is included in what you send. Nuvio's rate is the mid-market rate less a small margin, and a quote holds the rate and the receive amount for ${QUOTE_LOCK_MINUTES} minutes, so what your recipient gets is guaranteed.`,
        points: [
          "You see Nuvio's rate, the mid-market rate and a typical bank's rate side by side",
          "The fee is taken from the amount you send; your card is charged the amount you send",
          `Quotes hold for ${QUOTE_LOCK_MINUTES} minutes; after that, ask for a new one`,
        ],
        source: NUVIO,
        related: ["payout_methods", "how_to_send"],
      });
    case "limits_and_tiers":
      return card({
        title: "Limits and how to raise them",
        answer: `On ${t.label} you can send up to ${sayAed(t.perTransactionMinor)} per transfer, ${sayAed(t.dailyMinor)} a day and ${sayAed(t.monthlyMinor)} a month. Adding ${t.nextTier.requirement} in the Nuvio app moves you to ${t.nextTier.name}, with ${sayAed(t.nextTier.monthlyMinor)} a month.`,
        points: [
          `Per transfer: ${aedNumber(t.perTransactionMinor)} AED (card-funded)`,
          `Per day: ${aedNumber(t.dailyMinor)} AED, resets at midnight UAE time`,
          `Per month: ${aedNumber(t.monthlyMinor)} AED, resets on the 1st`,
          "Your own numbers right now: ask me what your limits are",
        ],
        source: NUVIO,
        related: ["documents"],
      });
    case "tracking_and_receipts":
      return card({
        title: "Tracking and receipts",
        answer:
          "A transfer moves through payment received, checking details, sent to the payout partner and paid out. Once it is paid out you get the bank reference, called the UTR, and the receipt and FIRA, the foreign inward remittance advice, appear in the Nuvio app.",
        points: [
          "Under review: Nuvio may ask for a document; you'll be told exactly what, and nothing else",
          "UTR: the Indian bank's reference, useful if the recipient asks their bank",
          "FIRA: proof of an inward remittance, which the recipient's bank may ask for",
        ],
        source: NUVIO,
        related: ["cancellations_and_refunds"],
      });
    case "cancellations_and_refunds":
      return card({
        title: "Cancelling and refunds",
        answer: `You can cancel a transfer until it is sent to the payout partner, and the full amount, fee included, goes back to your card within ${REFUND_ETA}. After that it can only be recalled with the recipient's consent, through Nuvio support in the app.`,
        points: [
          "Cancel: before it is sent to the payout partner, including while it is under review",
          `Refund: the amount charged, fee included, ${REFUND_ETA}`,
          "Returned transfers (for example a closed account) are refunded the same way",
        ],
        source: NUVIO,
        related: ["tracking_and_receipts"],
      });
    case "nre_nro":
      return card({
        title: "NRE and NRO accounts",
        answer:
          "An NRE account holds money earned abroad; the interest it earns is tax-free in India, and the money can be moved back out freely. An NRO account holds income earned in India, such as rent; its interest is taxed in India, and moving it out is limited to one million US dollars a financial year.",
        points: [
          "NRE: rupee account for foreign earnings, fully repatriable, interest exempt from Indian tax",
          "NRO: rupee account for Indian income, interest taxed in India, repatriation up to USD 1 million per financial year",
          "Money you send from the UAE to your own NRE account counts as foreign earnings",
        ],
        source: "Reserve Bank of India rules under FEMA for non-resident accounts",
        disclaimer: GENERAL,
        related: ["tax", "lrs"],
      });
    case "lrs":
      return card({
        title: "The Liberalised Remittance Scheme (LRS)",
        answer:
          "The Liberalised Remittance Scheme covers money that residents of India send out of India, up to 250,000 US dollars a financial year. It does not apply to you sending money into India from the UAE, so there's no LRS limit on these transfers.",
        points: [
          "LRS: outward remittances by resident Indians, USD 250,000 per financial year",
          "Your transfers: inward remittances to India from the UAE, so LRS does not apply",
          "If your family later sends money out of India, LRS (and tax collected at source) may apply to them",
        ],
        source: "Reserve Bank of India, Liberalised Remittance Scheme",
        disclaimer: GENERAL,
        related: ["nre_nro", "tax"],
      });
    case "tax":
      return card({
        title: "Tax on money received in India",
        answer:
          "Money a relative receives from you as a gift is not taxed as their income in India. Gifts to someone who is not a relative are taxable for them once they exceed 50,000 rupees in a year, and the UAE has no personal income tax on what you send.",
        points: [
          "Gifts from relatives (parents, siblings, spouse and others defined in the law): exempt",
          "Gifts from non-relatives: taxable for the recipient above 50,000 rupees a year",
          "Money sent to your own NRE account is not a gift",
        ],
        source: "Indian income-tax law on gifts received",
        disclaimer: GENERAL,
        related: ["nre_nro"],
      });
    case "safety":
      return card({
        title: "Staying safe",
        answer:
          "Nuvio will never ask you for your code, password or card number, by phone, message or email. Only send money to people you know, and never read your approval code to anyone but this assistant while you are sending.",
        points: [
          `The ${OTP.digits}-digit code approves one transfer, for the amount and recipient in the text`,
          "Recipients can only be added in the app, never by voice",
          "If something feels wrong, say no: nothing is sent without your yes and the code",
        ],
        source: NUVIO,
        related: ["how_to_send", "recipients"],
      });
  }
}
