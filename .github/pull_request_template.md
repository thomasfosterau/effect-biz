## Summary

Describe what changed and why. If this closes an issue, add `Closes #N` so it auto-closes on merge to `main`.

## Verification

Run the gates in [AGENTS.md → Verification](https://github.com/thomasfosterau/effect-biz/blob/main/AGENTS.md#verification) and list each command with its final pass/fail. Name any gate that could not run, and why.

## Changeset

- [ ] A changeset under `.changeset/` for every change to a published package's behaviour, or "none needed" with the reason (docs, CI or tooling only).

## Notes

Anything reviewers should pay special attention to: exported signatures, peer ranges, SQL migrations, `sideEffects: false` (no top-level statements in `dist/`), the boundary with effect-finance.
