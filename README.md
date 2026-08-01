# Record Routes

An offline-friendly delivery checklist for the Waterloo Region Record paper route. Pick tonight's route(s), get an ordered list of stops, tap an address to open Google Maps for turn-by-turn, check off houses as you go. State survives app kills and phone reboots.

Full scope + roadmap: `~/Documents/obsidian-vault/projects/record-routes/scope.md` and `PLAN.md`.

## What's built (MVP, 2026-07-29)

- Home screen: pick 1, 2, or all 3 routes (H21, J3, J13 — 158 stops total, hardcoded from the Jul 29 2026 delivery list).
- Shift screen: ordered checklist (alphabetical by street, matches the printed list order), big "next stop" card, checkbox per stop, tap any stop to open Google Maps nav, long-press to skip.
- Progress bar, elapsed time, delivered/skipped counts.
- Persists to `AsyncStorage`, keyed by date — kill the app, reopen, you're where you left off.
- Screen stays awake while the shift screen is open (`expo-keep-awake`).
- Dark theme by default (11pm delivery, no reason to blind yourself).

## What's NOT built yet (see PLAN.md)

- Real geographic route optimization (currently alphabetical by street, same as the printed PDF order — good enough to start, not optimal).
- Offline maps / in-app map view (relies entirely on Google Maps app for navigation, which needs signal for live routing — cached recent routes may work offline, untested).
- Monthly PDF re-import (currently: edit `src/data/subscribers.ts` by hand when the list changes).
- History / analytics across shifts.

## Prerequisites

- Node (you have v24.16.0, fine).
- **Expo Go app** on your OnePlus 13 — easiest way to run this without building an APK. Install from the Play Store.
- Same wifi network on your laptop and phone (Expo Go connects over your LAN by default).

## Running it

```bash
cd ~/Documents/workspace/paulo-aunor/record-routes
npm install
npm start
```

This starts the Metro bundler and shows a QR code in your terminal. Open **Expo Go** on the OnePlus, scan the QR code, the app loads.

If QR scanning fails (different networks, VPN, firewall), press `s` in the terminal to switch Metro to "tunnel" mode, or plug the phone in via USB and run `npm run android` (needs `adb` + USB debugging enabled in Developer Options).

### Common breakage and what it means

| Symptom | Likely cause | Fix |
|---|---|---|
| QR code scans but app never loads | Phone and laptop on different networks | Press `s` in the Metro terminal for tunnel mode, or same wifi |
| "Unable to resolve module @/..." | Path aliases not picked up | Restart Metro with `npm start -- --clear` to clear the cache |
| Red screen mentioning `expo-router` | Entry point misconfigured | Confirm `package.json` has `"main": "expo-router/entry"` |
| Tap on stop does nothing on Android | Google Maps app not installed | `openInGoogleMaps` in `src/lib/navigation.ts` falls back to a web URL if the `google.navigation:` intent isn't handled — check `Linking.canOpenURL` isn't being blocked by Android's package visibility rules (shouldn't happen with a stock Maps install) |
| Checkboxes reset after closing the app | `AsyncStorage` write failed silently | Check Metro logs for errors from `saveShift`; each shift is stored under key `shift:YYYY-MM-DD` |
| Old shift showing after midnight | Expected — a new day means a fresh empty shift (`todayKey()` uses local device date) |

## How it's organized (and why) — a React Native primer

If this is new territory, here's the shape of the app and the concepts behind each piece.

```
app/                  # expo-router: file path = screen route
  _layout.tsx         # shared navigation shell (the Stack), rendered around every screen
  index.tsx           # "/" — home screen, route picker
  shift.tsx           # "/shift" — the checklist screen

src/
  types.ts            # shared TypeScript types (Subscriber, ShiftState, RouteId)
  data/
    routes.ts          # the 3 routes + library drop location
    subscribers.ts      # all 158 stops, hand-encoded from the PDF
  lib/
    storage.ts          # thin wrapper around AsyncStorage (the on-device key-value store)
    shift.ts             # useShift() — a custom React hook, the app's one piece of shared state
    navigation.ts         # openInGoogleMaps() — builds the intent URL and opens it
```

**expo-router**: instead of manually wiring up a navigation library, the *file path* under `app/` becomes the *route*. `app/index.tsx` is `/`, `app/shift.tsx` is `/shift`. `_layout.tsx` wraps every screen with a shared `Stack` (the back-button/header chrome). This is the same pattern the fitness-app project uses.

**Why a custom hook (`useShift`) instead of Redux/Zustand/Context**: the app has exactly one piece of meaningfully shared state — the in-progress shift. A hook that owns `useState` + reads/writes `AsyncStorage` is the whole state management story. Don't reach for a state library until you have state that's shared across more than two unrelated screens.

**AsyncStorage vs SQLite**: `AsyncStorage` is a flat key-value store — fine for "one JSON blob per day." The moment you want history (`SELECT avg(time) FROM shifts WHERE route = 'H21'`), you want `expo-sqlite` instead, because that's a query, not a key lookup. PLAN.md schedules that migration for the v1 milestone once there's more than one day of history to query.

**The `google.navigation:` intent**: Android apps can open other apps via a URL-like scheme. `google.navigation:q=<address>&mode=d` specifically opens Google Maps *already in driving turn-by-turn mode* pointed at that address — one tap, no address re-typing, no picking "start navigation" manually. `Linking.canOpenURL` checks if anything on the phone can handle that scheme before firing it; the code falls back to a plain `https://maps.google.com/...` URL (which opens in a browser or in Maps depending on what's installed) if the intent isn't handled — this matters on iOS, which doesn't understand `google.navigation:` at all.

**Why the list order is "alphabetical by street" for now**: it's literally just `Array.sort` on a computed street name + house number (see `orderedForShift` in `app/shift.tsx`). It's not smart, but it's honest — it matches how the paper list itself is already sorted, so it's not a regression from what you do today. True optimization (shortest total drive distance) is a separate, harder problem — see "Route optimization" in PLAN.md. Don't let this be the thing that stalls the MVP.

## Updating the delivery list (monthly)

For now this is manual, matching your "changes once a month" answer:

1. Open the new PDF from the Record.
2. Edit `src/data/subscribers.ts` — update, add, or remove entries. Each entry needs a stable `id` (format `ROUTEID-NNN`), `name`, `address`, `postal`, `city`, `routeId`.
3. Run `npm run typecheck` to make sure nothing's malformed.
4. Restart Metro (`npm start`), reload the app on the phone (shake the phone → Reload, or `r` in the terminal).

A script that parses the PDF automatically is on the roadmap (PLAN.md, week of Aug 17) — not built yet because it's a bigger, separate problem (PDF text extraction is finicky) and the manual edit takes 10 minutes once a month.

## Building a real APK (skip Expo Go, install permanently)

Not needed yet — Expo Go is enough for daily use as long as your laptop is reachable when you want to open the app. When you want it to run standalone (no laptop, no Expo Go):

```bash
npx eas build --platform android --profile preview
```

This requires an Expo account (free tier is fine) and produces a downloadable `.apk`. Not set up yet — flagging so you know the option exists when Expo Go friction gets annoying.

## Known limitations to plan around

- **No offline map tiles yet.** If you lose signal, Google Maps nav may not have a route cached for a stop you haven't been near recently. The checklist itself (list, checkboxes, addresses) works fully offline — it's all local data.
- **No real route optimization.** Order is alphabetical-by-street, not shortest-path. You are, for now, as efficient as the printed list.
- **Single-device only.** No sync, no backend, no login. This is intentional — you're the only user.
