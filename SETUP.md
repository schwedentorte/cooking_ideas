# Weekly Thali – setup (about 10 minutes)

Two parts: a script inside your Google Sheet (the "backend"), and the app itself on GitHub Pages.

## 1. Add the script to your Google Sheet

1. Open **Indian Vegetarian Dishes** in Google Sheets → **Extensions → Apps Script**.
2. Delete what's in `Code.gs`, paste in the contents of `apps-script/Code.gs`, and click **Save**.
3. In the function dropdown at the top, choose **setup** and click **Run**. Google asks for permission the first time (it's your own script): choose your account → *Advanced* → *Go to … (unsafe)* → **Allow**.
4. Open **Execution log** — it shows `Your app token is: …`. Copy that token.
   (A new **This Week** tab also appears in your sheet.)
5. Click **Deploy → New deployment** → gear icon → **Web app**.
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
   - Click **Deploy** and copy the **Web app URL** (ends in `/exec`).

"Anyone" only means the URL is reachable; every request still needs your token, so keep the URL and token to yourself.

## 2. Put the app on GitHub Pages

1. On github.com, create a new **public** repository, e.g. `weekly-thali`.
2. Upload everything inside the `pwa/` folder (index.html, app.js, styles.css, sw.js, manifest.webmanifest and the `icons` folder) to the root of the repo.
3. Repo **Settings → Pages** → *Source:* **Deploy from a branch**, *Branch:* `main` / `(root)` → **Save**.
4. After a minute your app is at `https://<your-username>.github.io/weekly-thali/`.

## 3. Install it on your phone

1. Open that address on your phone.
2. Paste the **Web app URL** and **token** from step 1 and tap **Save** – this week's five dishes appear.
3. Add it to your home screen:
   - **iPhone (Safari):** Share → *Add to Home Screen*
   - **Android (Chrome):** ⋮ menu → *Install app*

## Using it

- New picks appear the first time you open the app after **Monday 18:00**. They're also written to the **This Week** tab of your sheet, so every device sees the same five.
- **Cooked** fills in *Last cooked* in your sheet; tap again to undo. Dishes cooked in the last 4 weeks aren't picked again.
- **Swap** replaces one dish with another from the same category.
- **Shopping list** combines the vegetables and other ingredients for the week; ticks are saved on the phone. *Share list* sends it to WhatsApp, Notes, etc.
- Settings (gear) → *Pick a new set for this week* re-rolls all five.

## Changing the rules

In Apps Script → **Project Settings → Script properties**, add any of:

| Property | Default | Meaning |
|---|---|---|
| `CATEGORIES` | `Curry,Dal,Dry sabzi` | Categories the weekly picks come from |
| `COUNT` | `5` | Dishes per week |
| `MAX_BREAKFAST` | `1` | Breakfasts allowed among them (`0` = none) |
| `NO_REPEAT_DAYS` | `28` | Skip dishes cooked within this many days |
| `ROLLOVER` | `1 18` | Weekday (1 = Monday) and hour new picks start |

Adding dishes: just add rows to the **Dishes** tab (keep the column headers as they are). If you later change `Code.gs`, use **Deploy → Manage deployments → Edit → New version** so the same URL picks up the change.
