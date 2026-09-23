# Restore the approved browser design in the live Ink trial

The operator correctly identified a design regression. The first live trial
implemented a separate frame renderer focused on working data, scope isolation,
and terminal navigation. It retained the broad resource hierarchy but replaced
the approved HTML's visual composition with a dark text layout. Its functional
checks and independent navigation review did not establish visual fidelity.
Calling that trial the accepted layout connected to live data overstated what
had been delivered.

The HTML at <http://127.0.0.1:8765/modern-console-preview.html> remains the design
reference. This correction changes the Ink implementation, not that preview.

## Reference and correction

The running HTTP response was fetched and matched the local export byte for
byte. The editable source is `.lane/design-preview/modern-console-overview.html`.
Isolated Chromium captures confirmed the actual light/dark colors and the
monospace layout. The work uses the frontend-design skill with the operator's
approved direction taking precedence over a new visual interpretation.

Restored in the live trial:

- The reference's exact light/dark palette, including the light canvas, blue
  navigation rail, indigo Goals surface and amber Needs you surface. Light is
  the default; `D` toggles appearance without changing view or selection.
- A project breadcrumb/title and central tab strip with a persistent active
  underline. The rail retains Main checkout with its worktrees directly below,
  session counts/activity markers, and horizontal checkout tabs in the main area.
- A sessions band with separate Session, Goal › task, Checkout and State columns,
  and an always-available Full table link. Session output, linked goals/tasks,
  and checkouts have distinct mouse/keyboard targets.
- Goals at left, with observed priority order and linked active-task counts;
  goal-grouped Tasks at right, with Needs you directly underneath Tasks.
  Narrow layouts stack the sections, as the browser reference does.
- Compact rows, space between groups, reserved task states, and separate
  foreground/background treatment for interactive rows. The earlier painter
  dropped section backgrounds from controls; those surfaces now survive focus
  rendering and adjacent-cell painting.
- Explicit summary counts when the live backlog exceeds the overview. The
  complete lists remain reachable; the UI does not imply that six shown tasks
  represent the whole current project.
- The existing `herdr brain` branding. Projects is still a naming recommendation,
  not an approved rebrand to apply during design translation.

The header's Instruct/Chat/Goal/Task actions retain their design positions and
explain the read-only handoff when selected. They do not perform or simulate
writes. Full workflow parity with the browser prototype has not been completed.

## Verification and evidence

Before this correction, `npm test` passed 204/204. Afterward, `npm test` passed
208/208 and `npm --prefix console test` passed 121/121; the suites overlap.
Four new behavior checks cover independent relationship targets and precise Back
focus, overview grouping/responsive placement, access beyond summary limits,
and appearance changes without navigation or organizational side effects.

A real PTY ran the actual launch command against live BCH data. It recorded light
and dark overviews, Goals, selected live output, Back, and terminal resize from
140×43 to 80×25 and 100×35. Quit restored alternate-screen and mouse modes.
The terminal bytes and resize events were replayed in xterm, using the copy
bundled in the task-local Playwright installation, and captured in Chromium.
Assertions verify the resulting route, appearance, and console identity in all
six frames. These are recordings of Ink output, not a newly styled HTML mockup.

Visual inspection compared the reference with the corrected wide light/dark
screens and narrow layouts. The terminal owns font metrics and cell dimensions;
this is a composition/interaction translation, not pixel identity. Live records
also differ from the browser's selected historical sample. This pass does not
claim human usability acceptance, physical mouse forwarding, native focus round
trips, or full write-workflow integration.

Local evidence:

- `.lane/design-fidelity/reference-{light,dark}.png`: browser reference.
- `.lane/design-fidelity/ink-overview-light-140x43.png`: corrected live overview.
- `.lane/design-fidelity/ink-overview-dark-140x43.png`: dark counterpart.
- `.lane/design-fidelity/ink-overview-light-{80x25,100x35}.png`: resized frames.
- `.lane/design-fidelity/ink-{goals,output}-light-140x43.png`: live drill-down.
- The corresponding `.ansi`, `.json` and `.txt` files retain the terminal bytes,
  resize events and decoded screen text. Evidence remains local under `.lane`.
- `.lane/design-preview/fidelity-before.log` and
  `.lane/design-fidelity/{root-after,console-after}.log`: offline suites.

Reference export SHA-256:
`2adcfa5e3c45ca8ae763be6f3cbe67b201a2e865dfbb192f7686d10678fa51a7`.
Reference fragment SHA-256:
`464f9596208666cef69563e3bc000f8af377e913acb3266baad2dd0248ad8b15`.

## Run the corrected trial

Branch: `lane/console-autonomy`. Relaunch an existing trial to load the changes.

```sh
cd /Users/rewt/development/rewt/.worktrees/herdr-brain/lane-console-autonomy
node bin/org.mjs console --modern --project bch-cloak
```

Use `D` for dark appearance or `HERDR_CONSOLE_THEME=dark` before the command.
The existing console remains the default. No live org edits, agent messages,
dispatches, native focus changes, plugin installation or browser-preview changes
were performed. The recorded R-25 report is unchanged.

Next integration work must retain this HTML reference and compare rendered
terminal evidence with it, in addition to functional checks. Remaining work is
the already identified creation/decision workflows and durable project onboarding;
those should enter this design rather than another parallel presentation.
