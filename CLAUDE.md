# Working on Orbit

Orbit runs the session you are working in. That makes two ordinary habits
dangerous here, because the thing that ends your session is often the thing you
just typed.

## Never stash to run a test

`git stash push -- some/file.tsx && <test>; git stash pop` looks reversible. It
is not: restarting the live server, or a session dying mid-edit, kills the
shell before `pop` runs. The work then sits in a stash while `git status` looks
clean — which is the worst possible way to lose it, because nothing points at
it.

If you need a clean tree, commit instead:

    git commit -am "wip"      # …test…      git reset --soft HEAD~1

A WIP commit survives everything and is visible in `git log`. A stash is not.

## Testing

    bash scripts/test.sh <suite>     # smoke, touch, changes, preview-url, idle, ask, all

The run picks its own spare port from 3099 up and gets a scratch `HOME` named
after it (`/tmp/orbit-smoke-<port>`), which it deletes when the suites pass and
keeps when they fail — a failed run's server log is the reason to keep it, and
the last line tells you where it is. Do not set `ORBIT_TEST_PORT` or
`ORBIT_TEST_HOME` to work around a busy port; that is what left six orphaned
scratch directories behind, and it is now handled for you.

Never point a test at a live Orbit — :7788, or :3001 for an instance started
before 7788 became the default. The suites kill sessions, and one of those is
the Orbit you are talking through. `scripts/test.sh` refuses both, but nothing
stops a hand-rolled command.

    make test-clean    # reap a server or scratch HOME a killed run left behind

## What not to restart

- **The live Orbit** — :7788 by default, and :3001 for one started before that
  was the default. `make stop` or a restart ends the conversation that asked
  for it. Hand the restart to the user, and write down where you got to first.
- **Tailscale serve on 443** — `orbit start` (`make start`) set it up to proxy
  the live Orbit. It is meant to be there; it is not a leftover. `orbit stop`
  takes it down along with the server, which is exactly what not to run here.
  It is also now the only way in: the server binds `127.0.0.1` unless it was
  started with `--lan`, so dropping the front door does not merely inconvenience
  the phone, it cuts it off. And it is what tells Orbit the caller is the owner
  — without it a phone gets a token prompt where it used to walk in.

## No comments in the source

The code carries no comments — not `//`, not `/* */`, not JSDoc — and that
is deliberate, not neglect. Directive comments that change behaviour
(`// eslint-disable-next-line`, `// @ts-expect-error`) are the only
exception.

If a piece of code needs explaining, change the code: name the constant,
extract the function, rename the variable until it says what it holds. If
the explanation is a *why* that no name can carry — an iOS or WebKit
quirk, a constant chosen for a reason, an alternative that was tried and
rejected — it goes in `docs/DESIGN-NOTES.md` under "Implementation
notes", keyed by the function or constant it belongs to. Never in the
source.

## Never publish a build you have not seen start elsewhere

A bundler bakes absolute paths into the executable, so a build works on the
machine that built it for reasons that do not travel. 0.2.0 was published from
CI and died on the first Mac that ran it, looking for a `node_modules` under
`/Users/runner`. Every local build had passed, because locally that path
exists.

So a release is not the tag; it is the rehearsal:

    scripts/rehearse-release.sh all    # then scripts/release.sh <version>

It builds from a copy of the tree somewhere else, deletes that somewhere else,
installs the result through the real `install.sh`, and runs the smoke suite
against what it installed. Building elsewhere and then deleting it is the whole
point: it is the only way a baked-in path fails here rather than on someone's
Mac. `release.yml` does the same on the runner before it publishes anything, so
a red release job means fix the build, not retag.

A rehearsal proves one tree, not the branch. Any commit after it — a merge, a
one-line fix, someone else's work landing on main — is unrehearsed, and the
one that breaks the build is never the one that looks like it might. So the
rehearsal writes `.rehearsed` naming the tree it proved, and `release.sh`
refuses to tag a tree that stamp does not name. Rehearse last, tag next; do
not rehearse, merge, then tag.

A tag that published nothing can be moved. Check `gh release view v<version>`
first: if there are no assets, delete the tag and re-push it rather than
burning the next number.

## Nothing waits for approval

Claude Code here runs in auto mode, and a gate that stops the agent to
wait for a tap is an interruption, not a safeguard. `orbit setup`
installs only the notify hooks by default; the phone-side approval hook
exists for other machines and is opted into with `orbit setup
--approval`. Do not add anything else that blocks and waits.
