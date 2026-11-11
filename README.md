# Registry Signal Monitor for VitaSmart™ HOPE (concept)

**Live demo:** https://mohith26.github.io/bridge-to-life-registry-signal-monitor/

An unofficial concept feature for Bridge to Life's post-market **Bridge to HOPE Registry** (NCT07578441: real-world VitaSmart HOPE liver transplants, up to 20 U.S. centers). It watches each center's 90-day graft loss as cases accrue and raises a signal when outcomes are worse than that center's own case mix predicts, with a false-alarm rate you choose up front.

Built by Mohith Gajjela (Duke CS). Not affiliated with Bridge to Life. **All data is synthetic**; center codes are anonymous and no real patient or program outcomes are shown.

## Why

HOPE's promise is that centers can safely use more marginal livers (DCD, older, steatotic). That creates a monitoring problem for a registry sponsor:

- A center that leans into marginal grafts will have more raw losses than the registry average. A naive chart flags it, which is exactly the signal that discourages organ use.
- A center whose outcomes really drift (a new procurement team, a protocol change, a device-handling issue) needs to be caught early, not at the next annual analysis.
- 90-day outcomes arrive with a lag. Waiting for complete follow-up wastes months; counting early losses before the successes are known biases everything upward.

## How it works

1. **Risk model.** A logistic model of 90-day graft loss on donor age, DCD, macrosteatosis >= 30%, cold time before HOPE, recipient MELD and re-transplant, fitted (IRLS) only on cases whose 90-day window has closed, so early losses do not bias it.
2. **Continuous-time risk-adjusted CUSUM** (in the style of Biswas & Kalbfleisch 2008, the approach behind SRTR's program CUSUMs). Every day, each patient still inside their 90-day window adds their expected hazard; each observed loss adds ln(rho). `G(t) = max(0, G(t-1) + ln(rho) dN(t) - (rho-1) dLambda(t))`. Partial follow-up counts, so the chart moves the day something happens. Within-window hazard is front-loaded (Weibull shape 0.5).
3. **Control limits by simulation.** For each center, outcomes are re-drawn from the model under its actual case mix and transplant dates (600 runs), and the limit h is the (1 - alpha) quantile of the in-control maximum. A separate 1,000-run check on fresh draws reports the realized false-alarm rate (5.7% for C-07 at a 5% budget).
4. **Unadjusted comparison.** The same CUSUM with every patient given the pooled average risk, calibrated the same way.
5. **Drivers.** Observed vs expected (at-risk-time adjusted) by case type, to say whether an excess is a case-mix story or not.

Everything shown is computed in the browser from `data/registry.js` by `core/monitor.js`. Nothing is hard-coded.

## Result on the synthetic registry

The seeded generator (`data/generate.js`, seed 2) creates 1,146 HOPE cases at 20 centers (Feb to Oct 2026, data cut Nov 6 2026): 16 in-control centers, 3 in-control centers that take mostly DCD and older, steatotic livers, and 1 center (C-07) whose loss odds triple from its 21st case.

- Risk-adjusted chart: signals **only C-07**, on its 37th case (17 cases after the drift began).
- Unadjusted chart: also signals C-07 (case 40), and **also flags C-08**, an in-control center with 65% DCD donors.

Robustness (`node data/sweep.js`, 12 seeds): the drifting center was caught on 10 of 12 seeds by both charts. High-DCD in-control centers were falsely flagged 1 time in 36 with risk adjustment vs 9 times in 36 without. In-control centers were flagged 9 of 204 times (4.4%, budget 5%).

## Run it

```
node data/generate.js     # regenerate synthetic data
node --test               # unit tests (6)
node data/sweep.js        # 12-seed robustness sweep
open index.html           # or serve the folder statically
```

Tests cover: hazard bookkeeping, the CUSUM jump and decay, IRLS coefficient recovery, false-alarm calibration on fresh draws, power against a tripled-odds center, and internal consistency of the full analysis (observed counts, expected totals and subgroup sums).

## Honest limitations

- Synthetic data, and the generator uses the same hazard shape the monitor assumes, so real data will fit less cleanly.
- The risk model is fitted on the pooled registry including the center being monitored. A production version would fit on a reference period or use leave-one-center-out.
- Six covariates only. A real model would use the registry's full donor/recipient set and be validated (calibration, discrimination) before use.
- Per-center 5% budgets mean about one false alarm across 20 centers per window by design; a registry-wide false discovery control is a natural next step.
- This is a monitoring aid for the registry sponsor, not a clinical decision tool, and it says nothing about individual organ viability.

## Novelty note

Bridge to Life's site, press releases (2024-2026), the VitaSmart IFU (v7) and the registry record describe no outcome-surveillance software: the External Console shows a 60-second pressure/flow/resistance trend and is display-only. The announced viability assessment tool is about individual organs (biomarker-based), which this deliberately does not touch. SRTR publishes generic program CUSUMs for all transplants, not perfusion-device or registry-specific ones. Closest competitor software: XVIVO Insights (remote monitoring of live perfusion runs with user-set thresholds), XVIVO FlowHawk (organ-offer logistics), TransMedics OCS Connect (case logistics) and TransMedics' UNOS-hosted OCS registry. None of their public pages describe center-level, case-mix-adjusted outcome surveillance.

## UI

The shell borrows the VitaSmart External Console's visual language (blue-to-grey gradient header with the logo at right, Res/Flow-style labels, red traces on a light grid, red and blue rounded readout tiles) and bridgetolife.com's web tokens (Figtree, navy #0E4174, button blue #2D66A0, green announcement bar, #e8f2f6 table stripes). There is no public screenshot of a Bridge to Life web portal, so this is a best-faith match, not a copy of a real screen.
