# Writing sample catalog

`samples.json` is the canonical source for reference essays bundled with the APK.
`manifest.json` versions the catalog independently from the Android app.

- Add or edit an essay in `samples.json`, then run `corepack pnpm build:writing-samples`.
- To delete an essay, remove it from `samples.json` and add its identity fingerprints to
  `retiredSamples` before regenerating. This removes it from new training without touching
  frozen `SampleEssaySnapshot` data in existing sessions.
- Run `corepack pnpm check:writing-samples` before release. Runtime code must never fetch
  this catalog from GitHub.
