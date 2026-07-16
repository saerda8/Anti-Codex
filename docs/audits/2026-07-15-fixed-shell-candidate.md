# Fixed Shell Candidate Audit

- Date: 2026-07-15
- Status: accepted background candidate; not activated and not visibly launched
- Official source: `OpenAI.Codex` `26.707.9981.0`
- Candidate root: `%LOCALAPPDATA%\Anti-Codex\update-candidate`
- Patch profile: `fixed-shell-v1`

## Result

The candidate is a current official Codex shell with only the approved Anti-Codex branding, isolation-login and external-model compatibility changes. It does not carry the old plugin catalog, retry visibility or computer-use behavior patches.

- Candidate validation passed with bundled `codex-cli 0.144.2`.
- Manifest schema is `anticodex-host-manifest-v2` and records exactly 11 fixed-shell critical patches.
- Official and candidate ASARs each contain 6,537 files.
- ASAR entry comparison: 8 changed, 6,529 unchanged, 0 added, 0 removed.
- Candidate process count after build and validation: 0.
- The existing active Anti-Codex main process remained PID 40148 and was not restarted.

## Approved ASAR Delta

Only these entries differ from the current official package:

1. `.vite/build/bootstrap-DJ-x3mYs.js` - application name and AppUserModelID.
2. `.vite/build/main-Red_j8Wz.js` - Anti-Codex titles, window icon and Windows tray icon selection.
3. `package.json` - product name.
4. `webview/index.html` - document title.
5. `webview/assets/use-auth-DFY9lfrR.js` - isolated external-provider login bypass.
6. `webview/assets/app-main-CAsXyywb.js` - login route gate only; the byte-level snippet changes `if(t||!n){` to the padded `if(!0){` form.
7. `webview/assets/profile-dropdown-Mpa3NKTp.js` - retains the native Settings entry and adds one exact escaped Chinese `\u7ba1\u7406` entry through `__ANTICODEX_OPEN_MANAGER__`.
8. `webview/assets/model-list-filter-C2SM1X_9.js` - local external model visibility.

The candidate validator rejects the exact signatures produced by the retired patches for:

- computer-use legacy notify rewriting;
- local/electron/webview plugin catalog replacement;
- retry stream-error suppression.

## Fingerprints

- Official `app.asar`: 199,368,680 bytes, SHA-256 `E286D538971D7B4648692B244D80B0B1E9D227D29564275AD46F6653280D4094`.
- Candidate `app.asar`: 199,368,680 bytes, SHA-256 `A3D775F31DD1AE60627B954BE12FA9004B6BB55EF52A65A490638D86BB025E71`.
- Active old `app.asar`: 199,363,505 bytes, SHA-256 `9ED8CB465C851D1AD2D6422BCF6B873724CC3091D1C549C6B55686BD1F4EFE9F`.
- Candidate and active `Anti-Codex.exe`: SHA-256 `3056D3DEC31A0CCFAD4A002ED38CA71C58AF0EE21FFBB559204ABF58E35B47B4`.
- Candidate and active `resources\codex.exe`: SHA-256 `2CAACAD1F7B8B3E9B2527B9BFF9630CFBB30EC25D8D8C018C9D55A2BEC348032`.
- Candidate and active app/taskbar/tray icon assets: SHA-256 `55772B9E42B82480396A937BF409B6FF3A63DF601444BDC7895B1F291CF06696`.

## Remaining Acceptance

This closes the static current-shell synchronization defect. It does not close visible Gate 5: the active instance must be closed with user approval, the candidate must be activated through the guarded sync path, and the visible UI must still pass exact Chinese `管理`, full close-button hit area, responsive history, one bounded text/tool smoke and cleanup checks.
