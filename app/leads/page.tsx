/**
 * leads/page.tsx — the funnel. Every account that is not yet a client, plus
 * the ones that are, with the actions that move them.
 *
 * Forms post to server actions in ./actions.ts. No client-side JavaScript is
 * required for any of it, which is why the buttons are plain form submits.
 *
 * The lead record renders as a <dl>, not a sentence: label/value pairs survive
 * a missing field, line up in a grid, and give money and scores tabular
 * numerals. The action forms sit in their own wrapper so controls never read
 * as part of the record.
 *
 * DEAL VALUE IS VISIBLE TO EVERYONE, deliberately, and it is the one money
 * figure that is. The admin-only rule covers active income and expenses — a
 * client's monthly rate, the revenue totals — because those are the shape of
 * the business. A deal value on a lead is the quote, and quoting is employee
 * work: a member who cannot see the number cannot do the job.
 *
 * OWNERSHIP IS ADMIN-ONLY. An admin runs the lead skill, then hands the
 * results out; a member advances the leads they were given. That is a UI hide,
 * not the control — `accounts` RLS still lets a member write, and the reason it
 * does is that the same member must be able to advance a stage and log a call
 * on the very row they own.
 */
import Link from "next/link";
import { listAccounts, STAGES, centsToDollars, type Stage } from "@/lib/accounts";
import { listProfiles } from "@/lib/profiles";
import { getViewer } from "@/lib/supabase-server";
import { asJobFunction, skillButtonsFor } from "@/lib/agent/skills";
import { advanceStage, addNote, convertLead, assignLead } from "./actions";
import ActivityCapture from "../activity-capture";
import SkillButtons from "../skill-buttons";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; assigned?: string; error?: string }>;
}) {
  const { status, assigned, error } = await searchParams;
  const filter = (STAGES as readonly string[]).includes(status ?? "")
    ? (status as Stage)
    : undefined;

  const { role, email, userId, client: db } = await getViewer();
  const isAdmin = role === "admin";
  // Absent means "use my default": an admin opens the whole funnel, a member
  // opens their own leads. `assigned=anyone` is how either asks for the other
  // view, so the choice survives a refresh and a shared link.
  const ownerFilter =
    assigned === "unassigned" || assigned === "mine"
      ? assigned
      : assigned === "anyone"
        ? undefined
        : isAdmin
          ? undefined
          : "mine";

  // The WHOLE directory, not just the active half: a lead may still be owned by
  // someone who has left, and an activeOnly list would render that owner as
  // "Unassigned" — a lead that looks free but is not.
  const staff = db ? await listProfiles(db) : [];
  const nameOf = new Map(staff.map((p) => [p.id, p.display_name]));

  // getViewer() hands back the session email, not the auth user id — and
  // profiles.id IS that id, so the directory is the bridge between the two.
  const viewerId =
    staff.find((p) => p.email.toLowerCase() === (email ?? "").toLowerCase())?.id ?? null;

  // The button sets. Both come out of lib/agent/skills.ts and are not
  // re-derived here — the route re-checks the role anyway, so this is purely
  // about not showing a developer five buttons none of their work uses.
  // Read off the directory row that is already loaded; no extra query.
  const jobFunction = asJobFunction(staff.find((p) => p.id === userId)?.job_function);
  const pageSkills = skillButtonsFor("leads", role, jobFunction);
  const leadSkills = skillButtonsFor("lead", role, jobFunction);

  // "Mine" with no directory row of your own is not "everyone" — filtering by
  // an absent id would silently widen to every lead, so the page says so and
  // lists nothing instead.
  const noProfile = ownerFilter === "mine" && viewerId === null;
  const assignedTo =
    ownerFilter === "unassigned" ? null : ownerFilter === "mine" ? viewerId ?? undefined : undefined;

  const shown =
    db && !noProfile
      ? await listAccounts(db, {
          ...(filter ? { status: filter } : {}),
          ...(ownerFilter ? { assignedTo } : {}),
        })
      : [];

  const stageHref = (s?: Stage) =>
    `/leads?${new URLSearchParams({
      ...(s ? { status: s } : {}),
      assigned: ownerFilter ?? "anyone",
    })}`;
  // "Anyone" is spelled out rather than omitted, because an omitted param is
  // what triggers the role default above — a bare /leads would send a member
  // straight back to their own list.
  const ownerHref = (o: "anyone" | "unassigned" | "mine") =>
    `/leads?${new URLSearchParams({
      ...(filter ? { status: filter } : {}),
      assigned: o,
    })}`;

  return (
    <main>
      <h1>Leads</h1>

      {/* Prospecting is admin work, so this set is normally just `leads`. */}
      <SkillButtons buttons={pageSkills} />

      {/* Set by a server action that failed — a permission denial, usually. */}
      {error && <p role="alert"><strong>Could not save:</strong> {error}</p>}

      <nav aria-label="Filter by stage">
        <Link href={stageHref()}>All</Link>
        {STAGES.map((s) => (
          <Link key={s} href={stageHref(s)}>{s}</Link>
        ))}
      </nav>

      <nav aria-label="Filter by owner">
        <Link href={ownerHref("anyone")}>Anyone</Link>
        <Link href={ownerHref("unassigned")}>Unassigned</Link>
        <Link href={ownerHref("mine")}>Mine</Link>
      </nav>

      <p>
        {shown.length} shown{filter ? ` in ${filter}` : ""}
        {ownerFilter === "unassigned" ? ", unassigned" : ""}
        {ownerFilter === "mine" ? ", assigned to you" : ""}.
      </p>

      {noProfile && (
        <p role="alert">
          You have no staff directory entry yet, so nothing can be assigned to you.
          An admin can add one with <code>npm run provision-user</code>.
        </p>
      )}
      {shown.length === 0 && !noProfile && <p>Nothing here yet.</p>}

      {shown.map((a) => {
        // The id is what an inbox notice links to (lib/inbox.ts itemHref): the
        // funnel is one list, so a deep link to a lead is an anchor on its row.
        return (
          <article key={a.id} id={`account-${a.id}`}>
            <h2>{a.business_name}</h2>

            <dl>
              <dt>Type</dt><dd>{a.business_type ?? "—"}</dd>
              <dt>City</dt><dd>{a.city ?? "—"}</dd>
              <dt>Phone</dt><dd>{a.phone ?? "no phone"}</dd>
              <dt>Website</dt><dd>{a.has_website ? a.website ?? "yes" : "none"}</dd>
              <dt>Score</dt><dd>{a.lead_score ?? "—"}</dd>
              <dt>Calls</dt><dd>{a.call_count}</dd>
              <dt>Stage</dt><dd><strong>{a.status}</strong></dd>
              <dt>Deal value</dt>
              <dd>
                {a.deal_value_cents == null ? "—" : `$${centsToDollars(a.deal_value_cents)}`}
              </dd>
              <dt>Assigned to</dt>
              <dd>{(a.assigned_to && nameOf.get(a.assigned_to)) ?? "Unassigned"}</dd>
            </dl>

            <div>
              {isAdmin && (
              <form action={assignLead}>
                <input type="hidden" name="accountId" value={a.id} />
                <label>
                  Owner{" "}
                  <select name="assignedTo" defaultValue={a.assigned_to ?? ""}>
                    {/* Blank means unassigned — the action writes SQL NULL. */}
                    <option value="">— unassigned —</option>
                    {/* Inactive staff are offered only where they are already
                        the owner. Otherwise a defaultValue naming a departed
                        person would find no option and quietly unassign the
                        lead the moment anyone pressed Save. */}
                    {staff
                      .filter((p) => p.active || p.id === a.assigned_to)
                      .map((p) => (
                        <option key={p.id} value={p.id}>{p.display_name}</option>
                      ))}
                  </select>
                </label>
                <button type="submit">Save owner</button>
              </form>
              )}

              <form action={advanceStage}>
                <input type="hidden" name="accountId" value={a.id} />
                <label>
                  Move to{" "}
                  <select name="status" defaultValue={a.status}>
                    {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
                <button type="submit">Save stage</button>
              </form>

              {/* Runs as THIS employee, on their own Claude seat, about this
                  lead. Empty for a developer and for anyone with no
                  job_function, in which case it renders nothing at all. */}
              <SkillButtons buttons={leadSkills} accountId={a.id} />

              {/* Free text first, structured fallback second. The old
                  kind+note form stays: it works with JavaScript off, and the
                  capture box does not. */}
              <ActivityCapture target={{ accountId: a.id }} />

              <form action={addNote}>
                <input type="hidden" name="accountId" value={a.id} />
                <select name="kind" defaultValue="call">
                  <option value="call">call</option>
                  <option value="email">email</option>
                  <option value="note">note</option>
                  <option value="meeting">meeting</option>
                </select>
                <input name="note" placeholder="What happened?" />
                <button type="submit">Log contact</button>
              </form>

              {/* Shown to admins only. A member who forges this post is still
                  stopped by RLS — the UI hide is convenience, not the control. */}
              {isAdmin && a.status === "won" && (
                <form action={convertLead}>
                  <input type="hidden" name="accountId" value={a.id} />
                  <input name="slug" placeholder="slug (optional)" />
                  <input name="dealValue" placeholder="deal value in dollars" />
                  <button type="submit">Convert to client</button>
                </form>
              )}
            </div>
          </article>
        );
      })}

      <p><Link href="/clients">Clients</Link></p>
    </main>
  );
}
