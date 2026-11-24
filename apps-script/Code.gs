/**
 * Weekly Thali – Google Apps Script backend
 * ------------------------------------------
 * Paste this into Extensions → Apps Script of the "Indian Vegetarian Dishes" Google Sheet.
 * It turns the sheet into a tiny API that the PWA reads:
 *   ?action=week    → this week's picks (generated on first request after Monday 18:00, Europe/Zurich)
 *   ?action=swap&index=N   → replace pick N with another dish
 *   ?action=cooked&dish=NAME → set "Last cooked" to today (and tick it in "This Week")
 *   ?action=regen   → throw away this week's picks and pick again
 * Every request needs &token=… (run setup() once to create it).
 *
 * Optional settings (Project Settings → Script properties):
 *   CATEGORIES      default "Curry,Dal,Dry sabzi"  – categories a weekly pick can come from
 *   COUNT           default 5                       – dishes per week
 *   MAX_BREAKFAST   default 1                       – breakfasts allowed among them (0 = none)
 *   NO_REPEAT_DAYS  default 28                      – skip dishes cooked within this many days
 *   ROLLOVER        default "1 18"                  – weekday (1=Mon) and hour new picks start
 */

const TZ = 'Europe/Zurich';
const DISH_SHEET = 'Dishes';
const WEEK_SHEET = 'This Week';

// ---------- one-time setup ----------
function setup() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    props.setProperty('TOKEN', token);
  }
  ensureWeekSheet_();
  Logger.log('Your app token is: ' + token);
  return token;
}

// ---------- web app entry points ----------
function doGet(e) {
  const p = (e && e.parameter) || {};
  const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || p.token !== token) return json_({ error: 'unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    switch (p.action) {
      case 'week':   return json_(getWeek_(false));
      case 'regen':  return json_(getWeek_(true));
      case 'swap':   return json_(swap_(Number(p.index)));
      case 'cooked': return json_(markCooked_(p.dish, p.undo === '1', p.prev));
      default:       return json_({ error: 'unknown action' });
    }
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- settings ----------
function settings_() {
  const p = PropertiesService.getScriptProperties();
  const roll = (p.getProperty('ROLLOVER') || '1 18').split(/\s+/).map(Number);
  return {
    categories: (p.getProperty('CATEGORIES') || 'Curry,Dal,Dry sabzi')
      .split(',').map(s => s.trim()).filter(String),
    count: Number(p.getProperty('COUNT') || 5),
    maxBreakfast: Number(p.getProperty('MAX_BREAKFAST') || 1),
    noRepeatDays: Number(p.getProperty('NO_REPEAT_DAYS') || 28),
    rollDay: roll[0] || 1,
    rollHour: isNaN(roll[1]) ? 18 : roll[1],
  };
}

// ---------- reading the dish table ----------
function readDishes_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(DISH_SHEET);
  if (!sh) throw new Error('No sheet named "' + DISH_SHEET + '"');
  const values = sh.getDataRange().getValues();
  return parseDishes(values);
}

/** Pure function (also used by the local tests): table values → dish objects. */
function parseDishes(values) {
  const head = values[0].map(h => String(h).trim());
  const col = name => head.indexOf(name);
  const iVegStart = col('# Veggies') + 1;
  const iOther = col('Other key ingredients');
  const vegNames = head.slice(iVegStart, iOther);
  const isTrue = v => v === true || String(v).toUpperCase() === 'TRUE';
  const dishes = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const name = String(row[col('Dish')] || '').trim();
    if (!name) continue;
    const last = row[col('Last cooked')];
    dishes.push({
      row: r + 1,
      name: name,
      category: String(row[col('Category')] || ''),
      region: String(row[col('Region')] || ''),
      base: String(row[col('Base / protein')] || ''),
      time: Number(row[col('Time (min)')]) || null,
      difficulty: String(row[col('Difficulty')] || ''),
      veggies: vegNames.filter((v, i) => isTrue(row[iVegStart + i])),
      other: String(row[iOther] || ''),
      spices: String(row[col('Spices')] || ''),
      lastCooked: toIsoDate(last),
    });
  }
  return dishes;
}

function toIsoDate(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return typeof Utilities !== 'undefined'
      ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd')
      : v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// ---------- the picker (pure, testable) ----------
function daysBetween(isoA, isoB) {
  return Math.round((Date.parse(isoB) - Date.parse(isoA)) / 86400000);
}

/**
 * Pick `count` dishes. Rules, in order of strictness:
 *  - only the chosen categories, plus at most `maxBreakfast` breakfasts
 *  - nothing in `exclude`, nothing cooked in the last `noRepeatDays`
 *  - at most ceil(count / #categories) from one category
 *  - no two dishes with the same base (paneer, toor dal …), except plain "Vegetables"
 * Dishes not cooked for a long time (or never) are more likely to come up.
 * If the rules leave too few dishes, they are relaxed one by one.
 */
function pickDishes(dishes, opts, exclude, todayIso, rand) {
  rand = rand || Math.random;
  exclude = exclude || {};
  const cats = opts.categories;
  const want = opts.count;
  const allowed = d => cats.indexOf(d.category) >= 0 ||
    (opts.maxBreakfast > 0 && d.category === 'Breakfast');
  const age = d => d.lastCooked ? daysBetween(d.lastCooked, todayIso) : 365;

  const scored = dishes
    .filter(d => allowed(d) && !exclude[d.name])
    .map(d => {
      const weight = 1 + Math.min(age(d), 180) / 60;
      return { d: d, key: Math.pow(rand(), 1 / weight) };
    })
    .sort((a, b) => b.key - a.key)
    .map(x => x.d);

  const perCat = Math.max(1, Math.ceil(want / Math.max(1, cats.length)));
  const passes = [
    { recent: true, cat: true, base: true },
    { recent: true, cat: true, base: false },
    { recent: true, cat: false, base: false },
    { recent: false, cat: false, base: false },
  ];
  const chosen = (opts.already || []).slice();
  for (const rule of passes) {
    for (const d of scored) {
      if (chosen.length >= want) break;
      if (chosen.some(c => c.name === d.name)) continue;
      if (rule.recent && d.lastCooked && age(d) < opts.noRepeatDays) continue;
      if (d.category === 'Breakfast' &&
          chosen.filter(c => c.category === 'Breakfast').length >= opts.maxBreakfast) continue;
      if (rule.cat && chosen.filter(c => c.category === d.category).length >= perCat) continue;
      if (rule.base && d.base !== 'Vegetables' && chosen.some(c => c.base === d.base)) continue;
      chosen.push(d);
    }
    if (chosen.length >= want) break;
  }
  return chosen.slice((opts.already || []).length);
}

/** Start of the current planning week, as yyyy-MM-dd of that Monday (pure). */
function weekKeyFor(dowMon1, hour, isoToday, rollDay, rollHour) {
  let back = (dowMon1 - rollDay + 7) % 7;
  if (back === 0 && hour < rollHour) back = 7;
  const d = new Date(Date.parse(isoToday + 'T12:00:00Z') - back * 86400000);
  return d.toISOString().slice(0, 10);
}

// ---------- the "This Week" tab ----------
function ensureWeekSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(WEEK_SHEET);
  if (!sh) {
    sh = ss.insertSheet(WEEK_SHEET);
    sh.getRange(1, 1, 1, 4).setValues([['Week of', 'Dish', 'Category', 'Cooked']])
      .setFontWeight('bold').setBackground('#f3f3f3');
    sh.setFrozenRows(1);
  }
  return sh;
}

function nowParts_() {
  const now = new Date();
  return {
    today: Utilities.formatDate(now, TZ, 'yyyy-MM-dd'),
    dow: Number(Utilities.formatDate(now, TZ, 'u')),
    hour: Number(Utilities.formatDate(now, TZ, 'H')),
  };
}

function currentWeekKey_() {
  const s = settings_();
  const n = nowParts_();
  return weekKeyFor(n.dow, n.hour, n.today, s.rollDay, s.rollHour);
}

function readWeekRows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 4).getValues()
    .map(r => ({ week: toIsoDate(r[0]) || String(r[0]), name: String(r[1]), category: String(r[2]), cooked: r[3] === true }))
    .filter(r => r.name);
}

function writeWeekRows_(sh, key, rows) {
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, 4).clearContent();
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, 4).setValues(
    rows.map(r => [key, r.name, r.category, !!r.cooked]));
  sh.getRange(2, 4, rows.length, 1).insertCheckboxes();
}

function getWeek_(force) {
  const sh = ensureWeekSheet_();
  const key = currentWeekKey_();
  const s = settings_();
  const dishes = readDishes_();
  let rows = readWeekRows_(sh);
  const byName = {};
  dishes.forEach(d => byName[d.name] = d);

  const stale = !rows.length || rows[0].week !== key ||
    rows.some(r => !byName[r.name]);
  if (force || stale) {
    const picks = pickDishes(dishes, s, {}, nowParts_().today);
    rows = picks.map(d => ({ name: d.name, category: d.category, cooked: false }));
    writeWeekRows_(sh, key, rows);
  }
  return payload_(key, rows, byName, s);
}

function payload_(key, rows, byName, s) {
  return {
    week: key,
    settings: { categories: s.categories, count: s.count, maxBreakfast: s.maxBreakfast,
                rollDay: s.rollDay, rollHour: s.rollHour },
    picks: rows.map(r => Object.assign({}, byName[r.name], { cooked: r.cooked })),
  };
}

function swap_(index) {
  const sh = ensureWeekSheet_();
  const key = currentWeekKey_();
  const s = settings_();
  const dishes = readDishes_();
  const byName = {};
  dishes.forEach(d => byName[d.name] = d);
  let rows = readWeekRows_(sh);
  if (!rows.length || rows[0].week !== key) return getWeek_(true);
  if (!(index >= 0 && index < rows.length)) throw new Error('Bad index');

  const exclude = {};
  rows.forEach(r => exclude[r.name] = true);
  const keep = rows.filter((r, i) => i !== index).map(r => byName[r.name]).filter(Boolean);
  // Prefer a dish from the same category as the one being swapped out.
  const old = byName[rows[index].name] || rows[index];
  const sameCat = Object.assign({}, s, { categories: [old.category], count: 1,
    maxBreakfast: old.category === 'Breakfast' ? 1 : 0, already: [] });
  let pick = pickDishes(dishes, sameCat, exclude, nowParts_().today)[0];
  if (!pick) pick = pickDishes(dishes, Object.assign({}, s, { already: keep }), exclude, nowParts_().today)[0];
  if (!pick) throw new Error('No other dish available');
  rows[index] = { name: pick.name, category: pick.category, cooked: false };
  writeWeekRows_(sh, key, rows);
  return payload_(key, rows, byName, s);
}

function markCooked_(name, undo, prev) {
  const sh = SpreadsheetApp.getActive().getSheetByName(DISH_SHEET);
  const values = sh.getDataRange().getValues();
  const head = values[0].map(h => String(h).trim());
  const iName = head.indexOf('Dish');
  const iLast = head.indexOf('Last cooked');
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][iName]).trim() === name) {
      const cell = sh.getRange(r + 1, iLast + 1);
      if (undo) {
        // Put back the date it had before (the app sends it along), or clear it.
        if (prev && /^\d{4}-\d{2}-\d{2}$/.test(prev)) {
          cell.setValue(Utilities.parseDate(prev, TZ, 'yyyy-MM-dd')).setNumberFormat('yyyy-mm-dd');
        } else cell.clearContent();
      } else cell.setValue(Utilities.parseDate(nowParts_().today, TZ, 'yyyy-MM-dd')).setNumberFormat('yyyy-mm-dd');
      break;
    }
  }
  const wk = ensureWeekSheet_();
  const rows = readWeekRows_(wk);
  rows.forEach(r => { if (r.name === name) r.cooked = !undo; });
  if (rows.length) writeWeekRows_(wk, rows[0].week, rows);
  SpreadsheetApp.flush();
  return getWeek_(false);
}

if (typeof module !== 'undefined') {
  module.exports = { parseDishes, pickDishes, weekKeyFor, daysBetween };
}
