// ==UserScript==
// @name         2.8 GT7 Leaderboard Saver DB Version
// @namespace    gt7-local
// @version      2.8
// @description  GT7 scraper with full UI, event metadata export, burst pacing, retries, resume, timer, payload sync, PSN enrichment, safe page routing, and IndexedDB page-by-page persistence
// @match        https://www.gran-turismo.com/*/gt7/sportmode/event/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "gt7_rows_by_page"; // legacy localStorage key, retained for cleanup/migration safety
  const AUTO_KEY = "gt7_auto_state";
  const PAYLOAD_KEY = "gt7_payload_by_page"; // legacy localStorage key, retained for cleanup/migration safety
  const LATEST_PAYLOAD_KEY = "gt7_latest_payload";
  const EVENT_META_KEY = "gt7_event_meta"; // legacy localStorage key, retained for cleanup/migration safety

  const DB_NAME = "gt7_leaderboard_saver";
  const DB_VERSION = 1;

  let db = null;
  let rowsByPageCache = {};
  let payloadByPageCache = {};
  let eventMetaCache = null;

  const CONFIG = {
    pagesPerBurst: 4,
    minNext: 3000,
    maxNext: 6000,
    minBurst: 20000,
    maxBurst: 50000,
    minRetry: 30000,
    maxRetry: 60000,
    maxRetries: 24,
    maxTableWaitMs: 30000,
    tablePollMs: 500,
    payloadWaitMs: 12000,
    minEnrichmentRatio: 0.8
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    return [
      String(Math.floor(s / 3600)).padStart(2, "0"),
      String(Math.floor((s % 3600) / 60)).padStart(2, "0"),
      String(s % 60).padStart(2, "0")
    ].join(":");
  }

  function getPage() {
    return Number(location.pathname.match(/\/page\/(\d+)/)?.[1] || 1);
  }

  function getPageUrl(page) {
    const base = location.pathname.split("/page/")[0].replace(/\/$/, "");
    return location.origin + base + "/page/" + page;
  }

  function ensurePageRoute() {
    if (/\/page\/\d+/.test(location.pathname)) return true;
    location.replace(getPageUrl(1));
    return false;
  }

  function getNextUrl() {
    return getPageUrl(getPage() + 1);
  }

  function normaliseSpace(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getEventId() {
    return location.pathname.match(/\/event\/(\d+)/)?.[1] || "unknown-event";
  }

  function getEventKey() {
    return getEventId() || "unknown-event";
  }

  function getEventTitle() {
    const h = document.querySelector("h1");
    return normaliseSpace(h?.innerText || "GT7 Event");
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("pages")) d.createObjectStore("pages", { keyPath: "key" });
        if (!d.objectStoreNames.contains("payloads")) d.createObjectStore("payloads", { keyPath: "key" });
        if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta", { keyPath: "key" });
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txStore(store, mode = "readonly") {
    return db.transaction(store, mode).objectStore(store);
  }

  function idbPut(store, value) {
    return new Promise((resolve, reject) => {
      const req = txStore(store, "readwrite").put(value);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  function idbGetAll(store) {
    return new Promise((resolve, reject) => {
      const req = txStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  function idbDelete(store, key) {
    return new Promise((resolve, reject) => {
      const req = txStore(store, "readwrite").delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function initIndexedDb() {
    db = await openDb();
    const eventId = getEventKey();

    const pages = await idbGetAll("pages");
    rowsByPageCache = {};
    for (const item of pages) {
      if (item.eventId === eventId) {
        rowsByPageCache[String(item.page)] = item.rows || [];
      }
    }

    const payloads = await idbGetAll("payloads");
    payloadByPageCache = {};
    for (const item of payloads) {
      if (item.eventId === eventId) {
        payloadByPageCache[String(item.page)] = item.payload;
      }
    }

    const metas = await idbGetAll("meta");
    eventMetaCache = metas.find(x => x.key === `${eventId}:eventMeta`)?.value || null;
  }

  function getEventMeta() {
    const pageText = normaliseSpace(document.body?.innerText || "");

    function pick(label, stops) {
      const start = pageText.indexOf(label);
      if (start === -1) return "";

      const from = start + label.length;
      let end = pageText.length;

      for (const stop of stops) {
        const idx = pageText.indexOf(stop, from);
        if (idx !== -1 && idx < end) end = idx;
      }

      return normaliseSpace(pageText.slice(from, end).replace(/^:/, ""));
    }

    function cleanTyreText(text) {
      return normaliseSpace(
        String(text || "")
          .replace(/Racing/g, "")
          .replace(/\s+/g, " ")
      );
    }

    const track = pick("Track", ["Entry Period", "Available Tyres", "Wide Body", "Global Ranking"]);
    const entryPeriod = pick("Entry Period", ["Available Tyres", "Wide Body", "Global Ranking"]);
    const availableTyres = pick("Available Tyres", ["Wide Body", "Nitrous/Overtake", "BoP/Tuning Prohibited", "Car Settings", "Global Ranking"]);
    const wideBody = pick("Wide Body", ["Nitrous/Overtake", "BoP/Tuning Prohibited", "Car Settings", "Global Ranking"]);
    const nitrousOvertake = pick("Nitrous/Overtake", ["BoP/Tuning Prohibited", "Car Settings", "Global Ranking"]);
    const bopTuningProhibited = pick("BoP/Tuning Prohibited", ["Car Settings", "Track Limit", "Shortcut Penalty", "Global Ranking"]);
    const carSettings = pick("Car Settings", ["Track Limit", "Shortcut Penalty", "Global Ranking"]);
    const trackLimit = pick("Track Limit", ["Shortcut Penalty", "Global Ranking"]);
    const shortcutPenalty = pick("Shortcut Penalty", ["Global Ranking"]);

    return {
      capturedAt: new Date().toISOString(),
      sourceUrl: location.href,
      eventId: getEventId(),
      title: getEventTitle(),
      track,
      entryPeriod,
      availableTyres,
      tyreCode: cleanTyreText(availableTyres),
      wideBody,
      nitrousOvertake,
      bopTuningProhibited,
      carSettings,
      trackLimit,
      shortcutPenalty
    };
  }

  async function saveEventMeta() {
    const meta = getEventMeta();
    eventMetaCache = meta;

    if (db) {
      await idbPut("meta", {
        key: `${getEventKey()}:eventMeta`,
        eventId: getEventKey(),
        value: meta,
        savedAt: new Date().toISOString()
      });
    }

    return meta;
  }

  function getSavedEventMeta() {
    if (eventMetaCache && typeof eventMetaCache === "object") return eventMetaCache;
    return getEventMeta();
  }

  function buildExportPayload(rows) {
    return {
      format: "gt7-leaderboard-export-v2",
      exportedAt: new Date().toISOString(),
      eventMeta: getSavedEventMeta(),
      rows
    };
  }

  function getTable() {
    let table = document.querySelector("table._2M8jtV");
    if (table) return table;

    const tables = Array.from(document.querySelectorAll("table"));
    for (const candidate of tables) {
      const text = (candidate.innerText || "").trim();
      if (text.includes("Driver") && text.includes("Time") && text.includes("SR")) {
        const rows = candidate.querySelectorAll("tr");
        if (rows.length >= 2) return candidate;
      }
    }

    return null;
  }

  function hasErrorModal() {
    return Array.from(document.querySelectorAll("div, section, article"))
      .some(el => (el.innerText || "").includes("An error has occurred"));
  }

  function loadJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function loadSavedPages() {
    return rowsByPageCache || {};
  }

  async function saveSavedPages(data, pageToSave = getPage()) {
    rowsByPageCache = data || {};
    const page = Number(pageToSave);
    const rows = rowsByPageCache[String(page)];
    if (!db || !rows) return;

    await idbPut("pages", {
      key: `${getEventKey()}:page:${page}`,
      eventId: getEventKey(),
      page,
      savedAt: new Date().toISOString(),
      rows
    });
  }

  function loadPayloadPages() {
    return payloadByPageCache || {};
  }

  async function savePayloadPages(data, pageToSave = getPage()) {
    payloadByPageCache = data || {};
    const page = Number(pageToSave);
    const payload = payloadByPageCache[String(page)];
    if (!db || !payload) return;

    await idbPut("payloads", {
      key: `${getEventKey()}:payload:${page}`,
      eventId: getEventKey(),
      page,
      savedAt: new Date().toISOString(),
      payload
    });
  }

  function getHighestSavedPage() {
    const pages = Object.keys(loadSavedPages()).map(Number).filter(Boolean);
    return pages.length ? Math.max(...pages) : 0;
  }

  function getAllRowsSorted() {
    const map = loadSavedPages();
    return Object.keys(map)
      .map(Number)
      .sort((a, b) => a - b)
      .flatMap(page => map[String(page)]);
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function autoState() {
    return loadJson(AUTO_KEY, null);
  }

  function setAuto(state) {
    localStorage.setItem(AUTO_KEY, JSON.stringify(state));
  }

  function clearAuto() {
    localStorage.removeItem(AUTO_KEY);
  }

  function getPageIndicatorText() {
    const candidates = Array.from(document.querySelectorAll("button, div, span"));
    for (const el of candidates) {
      const text = (el.innerText || "").trim();
      if (/^\d+\s*\/\s*\d+$/.test(text)) return text;
    }
    return "";
  }

  function getTotalPages() {
    const m = getPageIndicatorText().match(/^(\d+)\s*\/\s*(\d+)$/);
    return m ? Number(m[2]) : null;
  }

  function waitForTable() {
    return new Promise(resolve => {
      const start = Date.now();

      function check() {
        if (getTable()) return resolve(true);
        if (Date.now() - start > CONFIG.maxTableWaitMs) return resolve(false);
        setTimeout(check, CONFIG.tablePollMs);
      }

      check();
    });
  }

  function waitForPayload(page, timeout = CONFIG.payloadWaitMs) {
    return new Promise(resolve => {
      const existing = loadPayloadPages()[String(page)];
      if (existing && Array.isArray(existing.list) && existing.list.length) {
        return resolve(true);
      }

      const timer = setTimeout(() => {
        window.removeEventListener("gt7-payload-captured", handler);
        resolve(false);
      }, timeout);

      function handler(event) {
        const detail = event.detail || {};
        const capturedPage = detail.page || getPage();

        if (Number(capturedPage) === Number(page)) {
          clearTimeout(timer);
          window.removeEventListener("gt7-payload-captured", handler);
          resolve(true);
        }
      }

      window.addEventListener("gt7-payload-captured", handler);
    });
  }

  function parseDomRows() {
    const table = getTable();
    if (!table) return null;

    const page = getPage();
    const rows = [];

    table.querySelectorAll("tr").forEach(r => {
      const c = r.querySelectorAll("td");
      if (c.length < 5) return;

      const a = c[1].querySelector("a");

      rows.push({
        rank: c[0].innerText.trim(),
        driver: a ? a.innerText.trim() : c[1].innerText.trim(),
        profileUrl: a?.href || "",
        dr: c[2].innerText.trim(),
        sr: c[3].innerText.trim(),
        time: c[4].innerText.trim(),
        page: page,
        pageUrl: location.href
      });
    });

    return rows;
  }

  function scoreToDisplay(score) {
    if (score == null) return "";
    const n = Number(score);
    if (Number.isNaN(n)) return "";
    const minutes = Math.floor(n / 60000);
    const seconds = Math.floor((n % 60000) / 1000);
    const millis = n % 1000;
    return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  function buildPayloadIndexForPage(page) {
    const payloadStore = loadPayloadPages();
    let pagePayload = payloadStore[String(page)];

    if (!pagePayload) {
      const latest = loadJson(LATEST_PAYLOAD_KEY, null);
      if (latest && Array.isArray(latest.list)) {
        pagePayload = latest;
      }
    }

    if (!pagePayload || !Array.isArray(pagePayload.list)) return null;

    const byRank = new Map();
    const byComposite = new Map();

    for (const item of pagePayload.list) {
      const rank = String(item.display_rank ?? "");
      const nick = item.user?.nick_name || item.user?.np_online_id || "";
      const time = scoreToDisplay(item.score);
      const key = `${rank}|${nick}|${time}`;

      byRank.set(rank, item);
      byComposite.set(key, item);
    }

    return { byRank, byComposite };
  }

  function enrichRows(domRows) {
    const page = getPage();
    const idx = buildPayloadIndexForPage(page);
    if (!idx) return domRows;

    return domRows.map(row => {
      const rank = String(row.rank || "");
      const compositeKey = `${rank}|${row.driver || ""}|${row.time || ""}`;

      const payload = idx.byComposite.get(compositeKey) || idx.byRank.get(rank);
      if (!payload) return row;

      return {
        ...row,
        countryCode: payload.user?.country_code || "",
        userId: payload.user?.user_id || "",
        psnId: payload.user?.np_online_id || "",
        replayId: payload.replay_id ?? "",
        lineReplayId: payload.line_replay_id || "",
        updateTime: payload.update_time || "",
        manufacturerId: payload.user?.manufacturer_id ?? "",
        carCode: payload.ranking_stats?.car_code ?? ""
      };
    });
  }

  function isRowEnriched(row) {
    return Boolean(
      row.psnId ||
      row.userId ||
      row.countryCode ||
      row.replayId ||
      row.lineReplayId ||
      row.carCode
    );
  }

  async function savePage() {
    const domRows = parseDomRows();
    if (!domRows || !domRows.length) {
      return { ok: false, reason: "no_dom_rows", ratio: 0 };
    }

    const enrichedRows = enrichRows(domRows);
    const enrichedCount = enrichedRows.filter(isRowEnriched).length;
    const ratio = enrichedCount / enrichedRows.length;

    if (ratio < CONFIG.minEnrichmentRatio) {
      return { ok: false, reason: "not_enriched", ratio };
    }

    await saveEventMeta();

    const page = getPage();
    const all = loadSavedPages();
    all[String(page)] = enrichedRows;
    await saveSavedPages(all, page);
    return { ok: true, ratio };
  }

  function injectNetworkCapture() {
    if (window.__gt7PayloadHookInstalled) return;
    window.__gt7PayloadHookInstalled = true;

    function installInPage() {
      if (window.__gt7PayloadHookInstalledPage) return;
      window.__gt7PayloadHookInstalledPage = true;

      function emitPayload(detail) {
        window.dispatchEvent(new CustomEvent("gt7-payload-captured", { detail }));
      }

      function parseBodyPage(body) {
        try {
          if (!body) return null;
          if (typeof body === "string") {
            const parsed = JSON.parse(body);
            return typeof parsed.page === "number" ? parsed.page + 1 : null;
          }
          return null;
        } catch (e) {
          return null;
        }
      }

      const origFetch = window.fetch;
      window.fetch = async function (...args) {
        const response = await origFetch.apply(this, args);

        try {
          const url = String(args[0]?.url || args[0] || "");
          const body = args[1]?.body;
          const guessedPage = parseBodyPage(body);

          if (url.includes("/ranking/get_list_by_page")) {
            const cloned = response.clone();
            const json = await cloned.json();

            if (json?.result?.list && Array.isArray(json.result.list)) {
              emitPayload({
                page: guessedPage,
                list: json.result.list
              });
            }
          }
        } catch (e) {}

        return response;
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url) {
        this.__gt7_url = url;
        return origOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function (body) {
        this.__gt7_body = body;

        this.addEventListener("load", function () {
          try {
            const url = String(this.__gt7_url || "");
            const guessedPage = parseBodyPage(this.__gt7_body);

            if (url.includes("/ranking/get_list_by_page")) {
              const json = JSON.parse(this.responseText);
              if (json?.result?.list && Array.isArray(json.result.list)) {
                emitPayload({
                  page: guessedPage,
                  list: json.result.list
                });
              }
            }
          } catch (e) {}
        });

        return origSend.apply(this, arguments);
      };
    }

    const script = document.createElement("script");
    script.textContent = `(${installInPage.toString()})();`;
    document.documentElement.appendChild(script);
    script.remove();

    window.addEventListener("gt7-payload-captured", async function (event) {
      const detail = event.detail || {};
      const page = detail.page || getPage();

      if (!page || !Array.isArray(detail.list)) return;

      const pagePayload = {
        page: page,
        capturedAt: new Date().toISOString(),
        list: detail.list
      };

      const payloadStore = loadPayloadPages();
      payloadStore[String(page)] = pagePayload;
      await savePayloadPages(payloadStore, page);
      saveJson(LATEST_PAYLOAD_KEY, pagePayload);
      await saveEventMeta();

      updateUI("Payload captured for page " + page);
    });
  }

  function stopAuto(showAlert) {
    clearAuto();
    updateUI();
    if (showAlert) alert("Auto stopped.");
  }

  async function clearSaved() {
    const eventId = getEventKey();
    const pages = await idbGetAll("pages");
    const payloads = await idbGetAll("payloads");

    await Promise.all([
      ...pages.filter(x => x.eventId === eventId).map(x => idbDelete("pages", x.key)),
      ...payloads.filter(x => x.eventId === eventId).map(x => idbDelete("payloads", x.key)),
      idbDelete("meta", `${eventId}:eventMeta`)
    ]);

    rowsByPageCache = {};
    payloadByPageCache = {};
    eventMetaCache = null;

    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(PAYLOAD_KEY);
    localStorage.removeItem(LATEST_PAYLOAD_KEY);
    localStorage.removeItem(EVENT_META_KEY);

    updateUI();
    alert("Saved rows, event metadata and payload cache cleared for this event.");
  }

  async function resetToPage1() {
    if (!confirm("Clear saved data for this event and go to page 1?")) return;
    await clearSaved();
    clearAuto();
    location.href = getPageUrl(1);
  }

  async function downloadSaved() {
    const rows = getAllRowsSorted();
    if (!rows.length) {
      alert("No saved rows.");
      return;
    }
    await saveEventMeta();
    downloadJson("gt7_rows_" + Date.now() + ".json", buildExportPayload(rows));
  }

  async function start(endPage) {
    await saveEventMeta();
    setAuto({
      running: true,
      endPage,
      startPage: getPage(),
      startTime: Date.now(),
      retry: {}
    });
    run();
  }

  async function resume() {
    const highest = getHighestSavedPage();
    if (!highest) {
      alert("No saved pages to resume from.");
      return;
    }

    const next = highest + 1;
    const input = prompt("Resume to which end page?");
    if (!input) return;

    await saveEventMeta();
    setAuto({
      running: true,
      endPage: Number(input),
      startPage: next,
      startTime: Date.now(),
      retry: {}
    });

    location.href = getPageUrl(next);
  }

  function runToEnd() {
    const end = getTotalPages();
    if (!end) {
      alert("Could not detect total pages.");
      return;
    }
    start(end);
  }

  function updateUI(extra = "") {
    const status = document.getElementById("gt7-status");
    if (!status) return;

    const saved = loadSavedPages();
    const savedPages = Object.keys(saved).map(Number).sort((a, b) => a - b);
    const rows = getAllRowsSorted().length;
    const a = autoState();
    const meta = getSavedEventMeta();
    const eventBits = [meta.track, meta.tyreCode || meta.availableTyres].filter(Boolean).join(" | ");

    let elapsed = "";
    if (a?.startTime) {
      elapsed = " | " + formatDuration(Date.now() - a.startTime);
    }

    const retryPage = getPage();
    const retryCount = a?.retry?.[retryPage] || 0;
    const modal = hasErrorModal() ? " | Modal detected" : "";

    status.textContent =
      (eventBits ? `Event:${eventBits} | ` : "") +
      `Saved pages:${savedPages.join(",") || "none"} ` +
      `| Rows:${rows} ` +
      `| Current page:${getPage()} ` +
      `| Storage:IndexedDB ` +
      `| ${a ? "Auto: running to page " + a.endPage : "Auto: off"}` +
      `${elapsed}` +
      (retryCount ? ` | Retries:${retryCount}` : "") +
      (extra ? ` | ${extra}` : "") +
      modal;
  }

  async function run() {
    const a = autoState();
    if (!a?.running) return;

    const page = getPage();

    updateUI("Waiting for table...");
    const ok = await waitForTable();

    if (!ok) {
      const retryCount = (a.retry[page] || 0) + 1;

      if (retryCount > CONFIG.maxRetries) {
        stopAuto(false);
        alert("Stopped - retries exceeded on page " + page);
        return;
      }

      a.retry[page] = retryCount;
      setAuto(a);

      const wait = rand(CONFIG.minRetry, CONFIG.maxRetry);
      updateUI(`Retrying page ${page} in ${Math.round(wait / 1000)}s (${retryCount}/${CONFIG.maxRetries})`);

      setTimeout(() => location.reload(), wait);
      return;
    }

    await saveEventMeta();

    updateUI("Waiting for payload...");
    const payloadReady = await waitForPayload(page, CONFIG.payloadWaitMs);

    if (!payloadReady) {
      const retryCount = (a.retry[page] || 0) + 1;

      if (retryCount > CONFIG.maxRetries) {
        stopAuto(false);
        alert("Stopped - payload not captured on page " + page);
        return;
      }

      a.retry[page] = retryCount;
      setAuto(a);

      const wait = rand(CONFIG.minRetry, CONFIG.maxRetry);
      updateUI(`Payload missing; refreshing page ${page} in ${Math.round(wait / 1000)}s (${retryCount}/${CONFIG.maxRetries})`);

      setTimeout(() => location.reload(), wait);
      return;
    }

    await sleep(rand(1000, 2000));

    const result = await savePage();

    if (!result.ok) {
      const retryCount = (a.retry[page] || 0) + 1;

      if (retryCount > CONFIG.maxRetries) {
        stopAuto(false);
        alert("Stopped - enrichment failed on page " + page);
        return;
      }

      a.retry[page] = retryCount;
      setAuto(a);

      const wait = rand(CONFIG.minRetry, CONFIG.maxRetry);
      const pct = Math.round((result.ratio || 0) * 100);
      updateUI(`Enrichment incomplete (${pct}%); refreshing page ${page} in ${Math.round(wait / 1000)}s (${retryCount}/${CONFIG.maxRetries})`);

      setTimeout(() => location.reload(), wait);
      return;
    }

    if (page >= a.endPage) {
      const rows = getAllRowsSorted();
      const filename =
        `gt7_pages_${a.startPage}_to_${a.endPage}_` +
        `${formatDuration(Date.now() - a.startTime).replace(/:/g, "-")}_` +
        `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;

      downloadJson(filename, buildExportPayload(rows));
      clearAuto();
      updateUI("Finished");
      alert("Auto run finished. Download started.");
      return;
    }

    const inBurst = ((page - a.startPage + 1) % CONFIG.pagesPerBurst) !== 0;
    const wait = inBurst ? rand(CONFIG.minNext, CONFIG.maxNext) : rand(CONFIG.minBurst, CONFIG.maxBurst);

    updateUI((inBurst ? "Next in " : "Burst cooldown ") + (wait / 1000).toFixed(3) + "s");
    setTimeout(() => location.href = getNextUrl(), wait);
  }

  function injectUI() {
    if (document.getElementById("gt7-ui")) return;

    const d = document.createElement("div");
    d.id = "gt7-ui";
    d.style = [
      "position:fixed",
      "bottom:10px",
      "left:10px",
      "background:#000",
      "color:#fff",
      "padding:12px",
      "z-index:999999",
      "font-size:12px",
      "font-family:Arial,sans-serif",
      "border-radius:8px",
      "min-width:520px",
      "box-shadow:0 4px 16px rgba(0,0,0,0.4)"
    ].join(";");

    d.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px;">GT7 Leaderboard Saver v2.8 IndexedDB</div>
      <div id="gt7-status" style="margin-bottom:10px;line-height:1.5;"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="gt7-save">Save this page</button>
        <button id="gt7-auto">Auto Save + Next</button>
        <button id="gt7-resume">Resume</button>
        <button id="gt7-runend">Run End</button>
        <button id="gt7-download">Download JSON</button>
        <button id="gt7-clear">Clear</button>
        <button id="gt7-reset">Reset</button>
        <button id="gt7-stop">Stop</button>
      </div>
    `;

    document.body.appendChild(d);

    d.querySelectorAll("button").forEach(btn => {
      btn.style.padding = "8px 12px";
      btn.style.border = "1px solid #666";
      btn.style.background = "#111";
      btn.style.color = "#fff";
      btn.style.cursor = "pointer";
      btn.style.borderRadius = "6px";
      btn.style.fontSize = "12px";
    });

    document.getElementById("gt7-save").onclick = async () => {
      const result = await savePage();
      updateUI(result.ok ? "Saved page " + getPage() : "Not saved: " + result.reason);
    };

    document.getElementById("gt7-auto").onclick = () => {
      const end = Number(prompt("Run to which end page?"));
      if (end) start(end);
    };

    document.getElementById("gt7-resume").onclick = resume;
    document.getElementById("gt7-runend").onclick = runToEnd;
    document.getElementById("gt7-download").onclick = downloadSaved;
    document.getElementById("gt7-clear").onclick = clearSaved;
    document.getElementById("gt7-reset").onclick = resetToPage1;
    document.getElementById("gt7-stop").onclick = () => stopAuto(true);

    saveEventMeta().then(() => updateUI()).catch(() => updateUI());
  }

  if (!ensurePageRoute()) return;

  injectNetworkCapture();

  window.addEventListener("DOMContentLoaded", async function () {
    try {
      await initIndexedDb();
    } catch (e) {
      console.error("IndexedDB init failed", e);
      alert("IndexedDB failed to initialise. Scraper not started.");
      return;
    }

    injectUI();
    setTimeout(run, 1000);
  });
})();
