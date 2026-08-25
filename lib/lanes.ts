/**
 * lanes.ts — the lane vocabulary, and nothing else.
 *
 * A LEAF MODULE ON PURPOSE: it imports nothing. `outreach_mode` is named by the
 * server action, the leads page, the `leads_write` verb and the drafting job,
 * and before this file existed all four reached it through lib/outreach.ts —
 * which imports lib/jobs.ts, which imports the Anthropic SDK, the notifier and
 * the mailer. Four modules that need one string list were pulling a model
 * client into the leads server bundle to get it.
 *
 * The list is also a DATABASE CHECK (`accounts_outreach_mode_check`, 0015). One
 * TS list per CHECK: a second copy of these four strings somewhere else is the
 * way the model-facing enum and the constraint end up disagreeing.
 */

/** Every value `accounts.outreach_mode` may hold, after 0015. */
export const LANE_MODES = ["ai", "human", "paused", "no_response"] as const;
export type LaneMode = (typeof LANE_MODES)[number];

/**
 * The lanes a PERSON may choose — in the UI, or through the `leads_write` verb.
 * `no_response` is missing on purpose: it is a conclusion the bot reached, not a
 * setting — a rep who wants the bot off a lead picks 'human' or 'paused', and
 * one who wants it back on picks 'ai', which is also how a parked lead is
 * un-parked.
 */
export const MANUAL_LANE_MODES = ["ai", "human", "paused"] as const;
export type ManualLaneMode = (typeof MANUAL_LANE_MODES)[number];

export const isLaneMode = (v: unknown): v is LaneMode =>
  typeof v === "string" && (LANE_MODES as readonly string[]).includes(v);
export const isManualLaneMode = (v: unknown): v is ManualLaneMode =>
  typeof v === "string" && (MANUAL_LANE_MODES as readonly string[]).includes(v);
