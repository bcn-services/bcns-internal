# os-staging — a skill written HERE, installed by a human THERE

The briefing skill belongs in the operator's `~/os`, which this run is not
allowed to write to. It is authored here instead. **It is staged, not
installed:** until someone does the three steps below, `bcns-os:briefing` does
not resolve and a briefing run will produce an unguided reply.

## 1. Copy the folder

```sh
cp -R os-staging/skills/briefing ~/os/skills/briefing
```

Destination: `~/os/skills/briefing/SKILL.md`. The folder name, the `name:`
frontmatter field, and the `/briefing` invocation all already match.

## 2. Add this line to `~/os/skills/INDEX.md`

Under the **`## Apps & clients`** heading, after the `leads` bullet and before
`pitch` (the section is not alphabetical, but this keeps the app-facing skills
together). Verbatim:

```
- `briefing` — Write one person's daily briefing from their tasks, leads, and clients; run by the bcns internal app on login
```

## 3. Wikilinks

`SKILL.md` carries one path-qualified `[[...]]` wikilink, per
`knowledge/frameworks/os-maintenance.md`:

- `[[skills/brief/SKILL|brief]]` — exists today, resolves on install. It is
  path-qualified because 28 files in `~/os` are named `SKILL.md`.

Nothing needs to link BACK to this skill. If `~/os/skills/brief/SKILL.md` is
being edited anyway, a reciprocal "not to be confused with `briefing`" line
there would earn its keep — optional.

## Not registered as a button, on purpose

`lib/agent/skills.ts` gates the skill BUTTONS. The briefing is never invoked
from a browser: `lib/briefing.ts` builds the prompt server-side from the
person's own identity. Adding `briefing` to that registry would put a button on
a page and open a second, weaker invocation path. Leave it out.
