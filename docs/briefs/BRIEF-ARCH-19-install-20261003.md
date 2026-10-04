# ARCH-19: zero-setup install

Read ARCH-19 and its children ENG-76, ENG-93 and ENG-111 (record show), ARCH-10's definition of done, the fleet
(ARCH-17) and docs/ADOPTING.md. Goal: on a machine or user account with nothing set up, install Herdr, add the
plugin, and be running like this machine. The plugin install checks prerequisites with plain messages, works with
Codex only, Claude only or both (today native Codex is required even for Claude-only users), and needs no project
config; the first agent session in a repository joins the fleet (ARCH-17). Fold in ENG-76 (default housekeeping
startup through supervisor entry, ENG-128), ENG-93 (entry beyond fresh shell PATH launches, natively where the
harness supports it) and ENG-111 (native entry honours long promotion checks). Extend docs/adoption/rehearse.mjs so
the rehearsal can target a fresh macOS user account; the operator runs that account rehearsal.

Failure-path acceptance: a missing prerequisite names what to install and stops cleanly; Claude-only install works
with no Codex; install twice is a no-op; uninstall restores the machine.

How to work (operator, 2026-10-03): right the first time, then verify; minimal and native; worktree = branch, promotion = pull request. Write the acceptance tests first, including the failure paths named below, and ship the change with them; run them while developing as you see fit. The process requires no other test runs in the lane: no baseline, no npm test, test:promotion or test:lanes; the promotion batch runs the full suites once. Never the live harness. Review your own diff against this brief before reporting. Commit, write the report, record check it, commit it, run lane check last. Then stop. Keep evidence in the repository, not only in /private/tmp.
