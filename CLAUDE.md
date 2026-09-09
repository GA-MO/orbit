# Working on Orbit

Orbit runs the session you are working in. That makes two ordinary habits
dangerous here, because the thing that ends your session is often the thing you
just typed.

## Never stash to run a test

`git stash push -- some/file.tsx && <test>; git stash pop` looks reversible. It
is not: restarting the server on :3001, or a session dying mid-edit, kills the
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

Never point a test at :3001. The suites kill sessions, and :3001 is the Orbit
you are talking through. `scripts/test.sh` refuses, but nothing stops a
hand-rolled command.

    make test-clean    # reap a server or scratch HOME a killed run left behind

## What not to restart

- **:3001** — the live Orbit. `make stop` or a restart ends the conversation
  that asked for it. Hand the restart to the user, and write down where you got
  to first.
- **Tailscale serve on 443** — `make phone` set it up to proxy :3001. It is
  meant to be there; it is not a leftover.
