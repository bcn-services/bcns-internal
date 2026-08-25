/**
 * verbs/index.ts — the registry.
 *
 * This is the whole tool surface an agent has. There is no Bash in the runner
 * (see lib/agent/runner.ts), so if a capability is not in this list, an agent
 * does not have it. Adding an entry here is the moment a new power exists.
 *
 * `toolSchemas()` is what gets handed to a model. It is derived from the same
 * `defineVerb` call that implements each verb, so a described tool and a
 * callable tool cannot drift apart.
 */

import { activity_query } from "./activity_query";
import { clients_query } from "./clients_query";
import { clients_write } from "./clients_write";
import { inbox_post } from "./inbox_post";
import { leads_query } from "./leads_query";
import { leads_stats } from "./leads_stats";
import { leads_write } from "./leads_write";
import { log_activity } from "./log_activity";
import { os_publish } from "./os_publish";
import { profiles_query } from "./profiles_query";
import { read_site } from "./read_site";
import { search_places } from "./search_places";
import { tasks_query } from "./tasks_query";
import { tasks_write } from "./tasks_write";
import type { CallerRole, ToolSchema, VerbContext, VerbResult } from "./types";

/** A verb with its input type erased, so the registry can hold all of them. */
export interface AnyVerb {
  name: string;
  description: string;
  roles: readonly CallerRole[];
  schema: ToolSchema;
  run(ctx: VerbContext, input: unknown): Promise<VerbResult<unknown>>;
}

export const VERBS: Readonly<Record<string, AnyVerb>> = Object.freeze({
  leads_query,
  leads_write,
  leads_stats,
  clients_query,
  clients_write,
  tasks_query,
  tasks_write,
  activity_query,
  log_activity,
  profiles_query,
  inbox_post,
  read_site,
  os_publish,
  search_places,
});

export const VERB_NAMES: readonly string[] = Object.keys(VERBS);

/** Every verb this caller's role may use — the list a model should be shown. */
export function verbsFor(role: CallerRole): AnyVerb[] {
  return Object.values(VERBS).filter((v) => v.roles.includes(role));
}

/** Tool definitions to hand to a model, scoped to the caller when a role is given. */
export function toolSchemas(role?: CallerRole): ToolSchema[] {
  const list = role ? verbsFor(role) : Object.values(VERBS);
  return list.map((v) => v.schema);
}

/**
 * Dispatch by name. An unknown verb is a typed error, not a throw: a model that
 * invents a tool name should be told so and get another turn.
 */
export async function callVerb(
  name: string,
  ctx: VerbContext,
  input: Record<string, unknown> = {},
): Promise<VerbResult<unknown>> {
  const verb = VERBS[name];
  if (!verb) {
    return { ok: false, error: { code: "invalid_input", message: `no such verb: ${name}` } };
  }
  return verb.run(ctx, input);
}

export {
  activity_query, clients_query, clients_write, inbox_post, leads_query, leads_stats, leads_write,
  log_activity, os_publish, profiles_query, read_site, search_places, tasks_query, tasks_write,
};
export {
  CALLER_ROLES, MONEY_FIELDS, checkCaller, defineVerb, fail, isUuid, ok, requireDb, scrub, stripMoney,
} from "./types";
export type {
  Caller, CallerRole, DbClient, JsonSchemaProp, ToolSchema, Verb, VerbContext, VerbError,
  VerbErrorCode, VerbInputSchema, VerbResult,
} from "./types";
