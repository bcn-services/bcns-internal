# Kickoff prompt for the manual test window

Paste everything below the line as the first message. Then drive with one word per step: `next`, or paste the failing output. Do not paste the steps in yourself; the model reads them from the artifact.

---

We are running the manual test of the bcns outreach pipeline in this repo, step by step, with me watching. The plan is section 06 of https://claude.ai/code/artifact/e5b31229-1934-4cbc-a759-ebb8772d2ac0 . Read that artifact (sections 04, 05, 06) and CLAUDE.md before doing anything. Section 05 config steps are already done unless I say otherwise.

How we work:
- One step per turn. Announce the step number and the command, run it, read the `events` table, then say PASS or FAIL against the expectation written in the artifact for that step. Stop and wait for me to say `next`. Never run two steps in one turn.
- Pass means the named event row and stage exist in the DB. A clean exit is not a pass. Show me the events query output every time.
- On FAIL: give one diagnosis and one proposed fix, then wait. Do not retry more than twice. Do not edit job code to make a test pass; if the code is wrong, say so and stop.
- Some steps need me: replying from my inbox, attaching a PDF, checking Gmail. Tell me exactly what to do, then wait until I say done.

Hard limits:
- DRY_RUN stays unset (on) except for the exact commands where the artifact writes `DRY_RUN=false`. Never export it globally.
- SEND_ALLOWED_RECIPIENTS is only ever my own address until step 12, and step 12 is not part of this session.
- Never DELETE FROM, DROP, or TRUNCATE. Test rows get cleaned by setting suppressed_at, or left in place.
- Never read or print `.env.local` values. Reference variables by name only.
- Never commit to main, never force push. Commits the jobs make to ~/os are expected; do not revert them without asking.
- Never send mail from a test file or an ad-hoc script. Only the jobs send.
- Never run `claude` with `--bare`.
- Any step touching a real repo create (step 10) or a real push: confirm with me first, name the repo or branch, then proceed.

Events query to use after every step:
select e.job, e.kind, e.detail->>'business' as business_id, b.name, e.created_at
from events e left join businesses b on b.id=(e.detail->>'business')::uuid
order by e.created_at desc limit 20;

Start with step 1.
