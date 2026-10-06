"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const APP_PATH = new URL("./", location.href).pathname;
const DB_NAME = `dayflow:${APP_PATH}`;
const CHANNEL_NAME = `${DB_NAME}:updates`;

const MIN_TIME = new Date(2000, 0, 1).getTime();
const MAX_RANGE_DAYS = 366;
const MAX_RECORDS = 50000;
const MAX_CATEGORIES = 500;

let db;
let state;
let busy = false;
let toastTimeout;
let installPrompt;
let swRegistration;
let updateRequested = false;
let currentDay = dayKey(Date.now());

const channel = "BroadcastChannel" in window
  ? new BroadcastChannel(CHANNEL_NAME)
  : null;

function uid() {
  return crypto.randomUUID();
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character]));
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dayKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateInputToDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(year, month - 1, day);

  return dayKey(d.getTime()) === value ? d : null;
}

function localDateTime(timestamp) {
  const d = new Date(timestamp);
  return `${dayKey(timestamp)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (hours) return `${hours} ชม. ${minutes} นาที`;
  if (minutes) return `${minutes} นาที`;
  return `${seconds} วินาที`;
}

function clock(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [
    Math.floor(seconds / 3600),
    Math.floor((seconds % 3600) / 60),
    seconds % 60
  ].map(pad).join(":");
}

function toast(message) {
  const element = $("#toast");
  const dialog = document.querySelector("dialog[open]");

  // dialog อยู่ใน top layer จึงย้ายข้อความเข้าไปให้มองเห็นได้
  (dialog || document.body).append(element);

  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    element.hidden = true;
  }, 4500);
}

function showStatus(message, error = false) {
  const element = $("#app-status");
  element.hidden = !message;
  element.textContent = message;
  element.classList.toggle("error", error);
}

async function run(action) {
  try {
    if (!db || !state) {
      throw new Error("ฐานข้อมูลยังไม่พร้อมใช้งาน");
    }
    await action();
  } catch (error) {
    console.error(error);
    toast(error.message || "ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง");
  }
}

function defaultState() {
  const presets = [
    ["กินข้าว", "🍽️", "#f6be65"],
    ["ซักผ้า", "🧺", "#82acff"],
    ["กวาดบ้าน / ถูบ้าน", "🧹", "#ba9aff"],
    ["ล้างจาน", "🫧", "#71cce8"],
    ["อาบน้ำ", "🚿", "#7eacf2"],
    ["ออกกำลังกาย", "🏃", "#ff959d"],
    ["อ่านหนังสือ", "📚", "#43d9bd"],
    ["Trading", "📈", "#e7bb75"],
    ["ทำงาน", "💼", "#a5b8ed"],
    ["พักผ่อน", "☕", "#d7b6e8"]
  ];

  return {
    schema: 1,
    categories: presets.map(([name, icon, color]) => ({
      id: uid(),
      name,
      icon,
      color,
      score: 3,
      archived: false
    })),
    entries: [],
    timer: null
  };
}

/* ---------------- DATABASE ---------------- */

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("app")) {
        database.createObjectStore("app");
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        showStatus("ฐานข้อมูลเปลี่ยนเวอร์ชัน กรุณาโหลดแอปใหม่", true);
      };
      resolve(database);
    };

    request.onerror = () => reject(request.error);

    request.onblocked = () => {
      showStatus("กรุณาปิด DayFlow แท็บอื่น แล้วเปิดใหม่", true);
    };
  });
}

// อ่านข้อมูลล่าสุดและเขียนใน transaction เดียว
// ช่วยป้องกันหลายแท็บเขียนทับข้อมูลกันโดยไม่รู้ตัว
function transactionChange(transform) {
  return new Promise((resolve, reject) => {
    let nextState;
    let localError;

    const transaction = db.transaction("app", "readwrite");
    const store = transaction.objectStore("app");
    const request = store.get("state");

    request.onsuccess = () => {
      try {
        const current = request.result || defaultState();
        nextState = transform(current) || current;
        store.put(nextState, "state");
      } catch (error) {
        localError = error;
        transaction.abort();
      }
    };

    transaction.oncomplete = () => resolve(nextState);
    transaction.onabort = () => reject(
      localError ||
      transaction.error ||
      new Error("บันทึกไม่สำเร็จ ข้อมูลยังไม่ได้ถูกเปลี่ยน")
    );
    transaction.onerror = () => {
      // จัดการการปฏิเสธ Promise ที่ onabort
    };
  });
}

function readState() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("app", "readonly");
    const request = transaction.objectStore("app").get("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function commit(transform) {
  if (busy) throw new Error("กำลังบันทึก กรุณารอสักครู่");

  busy = true;

  try {
    state = await transactionChange(transform);
    render();
    channel?.postMessage("changed");
  } finally {
    busy = false;
  }
}

async function refreshState() {
  if (!db || busy) return;

  try {
    const latest = await readState();
    if (latest) {
      state = latest;
      render();
    }
  } catch (error) {
    console.error(error);
    showStatus("อ่านข้อมูลไม่สำเร็จ กรุณาโหลดใหม่", true);
  }
}

channel?.addEventListener("message", refreshState);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshState();
});

window.addEventListener("focus", refreshState);

/* ---------------- VALIDATION ---------------- */

function validScore(score) {
  return Number.isInteger(score) && score >= 1 && score <= 5;
}

function categoryById(id, source = state) {
  return source.categories.find((category) => category.id === id);
}

function assertNoOverlap(source, start, end, excludedId = null) {
  const overlap = source.entries.some((entry) =>
    entry.id !== excludedId &&
    start < entry.end &&
    end > entry.start
  );

  if (overlap) {
    throw new Error("ช่วงเวลานี้ทับซ้อนรายการเดิม กรุณาปรับเวลา");
  }

  // ขณะจับเวลาอยู่ ช่วงตั้งแต่เริ่มจับเวลาถือว่าถูกใช้อยู่
  if (source.timer && end > source.timer.start) {
    throw new Error("ช่วงเวลาทับกับกิจกรรมที่กำลังจับเวลา กรุณาหยุดก่อน");
  }
}

function validateEntry(entry, source) {
  if (!categoryById(entry.categoryId, source)) {
    throw new Error("ไม่พบกิจกรรมที่เลือก");
  }

  if (
    !Number.isFinite(entry.start) ||
    !Number.isFinite(entry.end) ||
    entry.start < MIN_TIME ||
    entry.end <= entry.start
  ) {
    throw new Error("วันเวลาต้องถูกต้อง และเวลาสิ้นสุดต้องหลังเวลาเริ่ม");
  }

  if (entry.end > Date.now()) {
    throw new Error("ไม่สามารถบันทึกเวลาในอนาคตได้");
  }

  if (!validScore(entry.score)) {
    throw new Error("คะแนนต้องอยู่ระหว่าง 1–5");
  }

  if (typeof entry.note !== "string" || entry.note.length > 1000) {
    throw new Error("หมายเหตุต้องยาวไม่เกิน 1,000 ตัวอักษร");
  }
}

/* ---------------- TIMER ---------------- */

async function startTimer(categoryId) {
  await commit((source) => {
    if (source.timer) {
      throw new Error("มีกิจกรรมกำลังทำอยู่ กรุณาหยุดและบันทึกก่อน");
    }

    const category = categoryById(categoryId, source);
    if (!category || category.archived) {
      throw new Error("กิจกรรมนี้ไม่พร้อมใช้งาน");
    }

    const now = Date.now();

    if (source.entries.some((entry) => entry.end > now)) {
      throw new Error("นาฬิกาเครื่องย้อนหลังจากข้อมูลเดิม กรุณาตรวจเวลาเครื่อง");
    }

    source.timer = {
      id: uid(),
      categoryId,
      start: now,
      score: category.score
    };
  });

  toast("เริ่มจับเวลาแล้ว");
}

async function stopTimer() {
  const timerId = state.timer?.id;
  if (!timerId) return;

  const elapsed = Date.now() - state.timer.start;

  if (
    elapsed > 24 * 60 * 60 * 1000 &&
    !confirm("จับเวลานานกว่า 24 ชั่วโมง ต้องการหยุดและบันทึกหรือไม่? แก้เวลาในรายงานได้")
  ) {
    return;
  }

  await commit((source) => {
    const timer = source.timer;

    if (!timer || timer.id !== timerId) {
      throw new Error("ตัวจับเวลาถูกเปลี่ยนจากอีกหน้าต่าง กรุณาตรวจสอบ");
    }

    const end = Date.now();

    if (end <= timer.start) {
      throw new Error("เวลาเครื่องอยู่ก่อนเวลาเริ่ม กรุณาปรับนาฬิกาให้ถูกต้อง");
    }

    if (source.entries.length >= MAX_RECORDS) {
      throw new Error("รายการเต็ม กรุณาสำรองข้อมูลและลบรายการเก่าก่อน");
    }

    const entry = {
      ...timer,
      end,
      note: ""
    };

    source.timer = null;
    validateEntry(entry, source);
    assertNoOverlap(source, entry.start, entry.end);
    source.entries.push(entry);
  });

  toast("บันทึกแล้ว — แก้คะแนนและเพิ่มหมายเหตุได้ในรายงาน");
}

function tick() {
  if (!state) return;

  const timer = state.timer;
  $("#timer-display").textContent = timer
    ? clock(Date.now() - timer.start)
    : "00:00:00";

  if (timer) {
    const elapsed = Date.now() - timer.start;

    $("#timer-hint").textContent = elapsed < 0
      ? "เวลาเครื่องอยู่ก่อนเวลาเริ่ม กรุณาตรวจนาฬิกา"
      : elapsed > 86400000
        ? "จับเวลานานกว่า 24 ชั่วโมงแล้ว ตรวจสอบว่าลืมหยุดหรือไม่"
        : `เริ่ม ${formatDateTime(timer.start)} · ปิดหน้าจอแล้วกลับมาได้`;
  }

  const today = dayKey(Date.now());
  if (today !== currentDay) {
    currentDay = today;
    render();
  }
}

/* ---------------- REPORT CALCULATION ---------------- */

function rangeFromInputs() {
  const from = dateInputToDate($("#report-from").value);
  const to = dateInputToDate($("#report-to").value);

  if (!from || !to) throw new Error("กรุณาเลือกวันเริ่มต้นและสิ้นสุด");
  if (to < from) throw new Error("วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่ม");

  const days = (
    Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) -
    Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  ) / 86400000 + 1;

  if (days > MAX_RANGE_DAYS) {
    throw new Error(`เลือกได้ไม่เกิน ${MAX_RANGE_DAYS} วันต่อรายงาน`);
  }

  const exclusiveEnd = new Date(to);
  exclusiveEnd.setDate(exclusiveEnd.getDate() + 1);

  return {
    start: from.getTime(),
    end: exclusiveEnd.getTime()
  };
}

function todayRange() {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { start: from.getTime(), end: to.getTime() };
}

function summarize(start, end) {
  const rows = state.entries
    .filter((entry) => entry.start < end && entry.end > start)
    .map((entry) => ({
      ...entry,
      clippedStart: Math.max(start, entry.start),
      clippedEnd: Math.min(end, entry.end),
      milliseconds: Math.min(end, entry.end) - Math.max(start, entry.start)
    }))
    .sort((a, b) => b.start - a.start);

  let total = 0;
  let weightedScore = 0;
  const groups = new Map();

  for (const row of rows) {
    total += row.milliseconds;
    weightedScore += row.milliseconds * row.score;

    groups.set(
      row.categoryId,
      (groups.get(row.categoryId) || 0) + row.milliseconds
    );
  }

  return {
    rows,
    total,
    average: total ? weightedScore / total : null,
    groups: [...groups.entries()].sort((a, b) => b[1] - a[1])
  };
}

function renderReports() {
  let summary;

  try {
    const range = rangeFromInputs();
    summary = summarize(range.start, range.end);
    $("#range-error").textContent = "";
    $("#export-csv").disabled = false;
  } catch (error) {
    $("#range-error").textContent = error.message;
    $("#export-csv").disabled = true;
    summary = { rows: [], groups: [], total: 0, average: null };
  }

  $("#report-total").textContent = duration(summary.total);
  $("#report-count").textContent = summary.rows.length;
  $("#report-score").textContent = summary.average === null
    ? "—"
    : `${summary.average.toFixed(1)} / 5`;

  $("#breakdown").innerHTML = summary.groups.length
    ? summary.groups.map(([categoryId, milliseconds]) => {
        const category = categoryById(categoryId);
        const percent = milliseconds / summary.total * 100;

        return `
          <div class="breakdown-row">
            <div class="breakdown-label">
              <span>${escapeHTML(category.icon)} ${escapeHTML(category.name)}</span>
              <span>${duration(milliseconds)} · ${percent.toFixed(1)}%</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill"
                   style="width:${percent}%;background:${category.color}"></div>
            </div>
          </div>
        `;
      }).join("")
    : `<div class="empty">ยังไม่มีรายการในช่วงวันที่เลือก</div>`;

  if (summary.groups.length) {
    const [topId, topTime] = summary.groups[0];
    $("#report-insight").textContent =
      `คุณใช้เวลากับ “${categoryById(topId).name}” มากที่สุด ` +
      `${duration(topTime)} คิดเป็น ` +
      `${(topTime / summary.total * 100).toFixed(1)}% ของเวลาที่บันทึก ` +
      "ลองทบทวนว่าเป็นสัดส่วนที่ตรงกับสิ่งสำคัญของคุณหรือไม่";
  } else {
    $("#report-insight").textContent =
      "เริ่มบันทึกกิจกรรมเพื่อมองเห็นรูปแบบการใช้เวลาของคุณ";
  }

  const visible = summary.rows.slice(0, 100);

  $("#history-caption").textContent =
    `แสดง ${visible.length} จาก ${summary.rows.length} รายการ · ` +
    "CSV ส่งออกครบทุกรายการในช่วงวันที่เลือก";

  $("#history-list").innerHTML = visible.length
    ? visible.map((entry) => {
        const category = categoryById(entry.categoryId);
        const clipped = entry.milliseconds !== entry.end - entry.start;

        return `
          <div class="history-row">
            <span class="row-icon">${escapeHTML(category.icon)}</span>
            <div class="row-main">
              <strong>${escapeHTML(category.name)}</strong>
              <small>
                ${escapeHTML(formatDateTime(entry.start))}
                → ${escapeHTML(formatDateTime(entry.end))}
              </small>
              ${entry.note
                ? `<small>${escapeHTML(entry.note)}</small>`
                : ""}
            </div>
            <div class="row-time">
              ${duration(entry.milliseconds)}
              <small>
                ${clipped ? "เฉพาะช่วงที่เลือก · " : ""}
                คุณค่า ${entry.score}/5
              </small>
            </div>
            <div class="row-actions">
              <button class="icon-button"
                      data-edit-entry="${entry.id}"
                      aria-label="แก้ไขรายการ">✎</button>
              <button class="icon-button"
                      data-delete-entry="${entry.id}"
                      aria-label="ลบรายการ">✕</button>
            </div>
          </div>
        `;
      }).join("")
    : `<div class="empty">ยังไม่มีประวัติ ลองเพิ่มรายการย้อนหลังได้เลย</div>`;
}

/* ---------------- RENDER ---------------- */

function render() {
  if (!state) return;

  $("#today-label").textContent = new Date().toLocaleDateString("th-TH", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const timer = state.timer;
  const activeCategory = timer ? categoryById(timer.categoryId) : null;

  $("#timer-state").textContent = timer
    ? "● กำลังจับเวลา"
    : "พร้อมเริ่มวันของคุณ";

  $("#timer-state").classList.toggle("running", Boolean(timer));
  $("#active-icon").textContent = activeCategory?.icon || "◷";
  $("#active-name").textContent =
    activeCategory?.name || "เลือกกิจกรรมด้านล่างเพื่อเริ่ม";

  $("#stop-button").hidden = !timer;

  if (!timer) {
    $("#timer-hint").textContent =
      "ทำทีละอย่าง แล้วค่อย ๆ เห็นภาพวันของคุณ";
  }

  const range = todayRange();
  const today = summarize(range.start, range.end);

  $("#today-total").textContent = duration(today.total);
  $("#today-count").textContent = today.rows.length;
  $("#today-score").textContent = today.average === null
    ? "—"
    : `${today.average.toFixed(1)} / 5`;

  const activeCategories = state.categories.filter((c) => !c.archived);

  $("#activity-grid").innerHTML = activeCategories.length
    ? activeCategories.map((category) => `
        <button class="activity-button"
                data-start="${category.id}"
                style="--activity-color:${category.color}"
                ${timer ? "disabled" : ""}>
          <span class="icon">${escapeHTML(category.icon)}</span>
          <strong>${escapeHTML(category.name)}</strong>
          <small>${timer ? "หยุดกิจกรรมปัจจุบันก่อน" : "เริ่มจับเวลา ↗"}</small>
        </button>
      `).join("")
    : `<div class="empty">ยังไม่มีกิจกรรม กด “เพิ่มกิจกรรม” เพื่อเริ่ม</div>`;

  $("#category-list").innerHTML = state.categories.map((category) => `
    <div class="category-row">
      <span class="row-icon">${escapeHTML(category.icon)}</span>
      <div class="row-main">
        <strong>${escapeHTML(category.name)}</strong>
        <small>
          คะแนนเริ่มต้น ${category.score}/5
          ${category.archived ? " · ซ่อนอยู่" : ""}
        </small>
      </div>
      <div class="row-actions">
        <button class="button small ghost"
                data-edit-category="${category.id}">แก้ไข</button>
        <button class="button small ghost"
                data-toggle-category="${category.id}">
          ${category.archived ? "แสดง" : "ซ่อน"}
        </button>
      </div>
    </div>
  `).join("");

  renderReports();
  tick();
}

function changeView(view) {
  const titles = {
    timer: "วันนี้ใช้เวลาไปกับอะไร?",
    reports: "มองเห็นเวลาของคุณ",
    settings: "จัดการในแบบของคุณ"
  };

  if (!titles[view]) return;

  $$(".view").forEach((element) => {
    element.hidden = element.id !== `view-${view}`;
  });

  $$(".nav-button").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);

    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  $("#page-title").textContent = titles[view];
  window.scrollTo({ top: 0, behavior: "auto" });
}

/* ---------------- ENTRY FORM ---------------- */

function openEntry(entryId = null) {
  const entry = entryId
    ? state.entries.find((item) => item.id === entryId)
    : null;

  if (entryId && !entry) throw new Error("ไม่พบรายการนี้");

  const categories = state.categories.filter((category) =>
    !category.archived || category.id === entry?.categoryId
  );

  if (!categories.length) {
    throw new Error("กรุณาเพิ่มหรือแสดงกิจกรรมอย่างน้อยหนึ่งรายการ");
  }

  $("#entry-form").reset();
  $("#entry-id").value = entry?.id || "";
  $("#entry-title").textContent = entry
    ? "แก้ไขรายการ"
    : "บันทึกย้อนหลัง";

  $("#entry-category").innerHTML = categories.map((category) => `
    <option value="${category.id}">
      ${escapeHTML(category.icon)} ${escapeHTML(category.name)}
    </option>
  `).join("");

  if (entry) $("#entry-category").value = entry.categoryId;

  // ค่าเริ่มต้นวางก่อนตัวจับเวลาที่กำลังทำอยู่ เพื่อไม่ทับกัน
  const end = entry?.end || Math.min(
    Date.now(),
    state.timer?.start ?? Date.now()
  );
  const start = entry?.start || end - 30 * 60 * 1000;

  $("#entry-start").value = localDateTime(start);
  $("#entry-end").value = localDateTime(end);
  $("#entry-score").value = entry?.score ??
    categoryById($("#entry-category").value).score;
  $("#entry-note").value = entry?.note || "";

  $("#entry-dialog").showModal();
}

async function saveEntry(event) {
  event.preventDefault();

  const existingId = $("#entry-id").value;
  const entry = {
    id: existingId || uid(),
    categoryId: $("#entry-category").value,
    start: new Date($("#entry-start").value).getTime(),
    end: new Date($("#entry-end").value).getTime(),
    score: Number($("#entry-score").value),
    note: $("#entry-note").value.trim()
  };

  await commit((source) => {
    validateEntry(entry, source);
    assertNoOverlap(source, entry.start, entry.end, existingId);

    const index = source.entries.findIndex((item) => item.id === existingId);

    if (existingId) {
      if (index < 0) throw new Error("รายการนี้ถูกลบจากอีกหน้าต่างแล้ว");
      source.entries[index] = entry;
    } else {
      if (source.entries.length >= MAX_RECORDS) {
        throw new Error("รายการเต็ม กรุณาสำรองและลบรายการเก่าก่อน");
      }
      source.entries.push(entry);
    }
  });

  $("#entry-dialog").close();
  toast("บันทึกรายการแล้ว");
}

async function deleteEntry(id) {
  if (!confirm("ลบรายการนี้หรือไม่? ไม่สามารถย้อนกลับได้")) return;

  await commit((source) => {
    source.entries = source.entries.filter((entry) => entry.id !== id);
  });

  toast("ลบรายการแล้ว");
}

/* ---------------- CATEGORY FORM ---------------- */

function openCategory(id = null) {
  const category = id ? categoryById(id) : null;
  if (id && !category) throw new Error("ไม่พบกิจกรรม");

  $("#category-form").reset();
  $("#category-id").value = category?.id || "";
  $("#category-title").textContent = category
    ? "แก้ไขกิจกรรม"
    : "เพิ่มกิจกรรม";
  $("#category-name").value = category?.name || "";
  $("#category-icon").value = category?.icon || "🎯";
  $("#category-color").value = category?.color || "#43d9bd";
  $("#category-score").value = category?.score || 3;
  $("#category-dialog").showModal();
}

async function saveCategory(event) {
  event.preventDefault();

  const id = $("#category-id").value;
  const name = $("#category-name").value.trim();
  const icon = $("#category-icon").value;
  const color = $("#category-color").value;
  const score = Number($("#category-score").value);

  if (!name || name.length > 40) {
    throw new Error("กรุณาใส่ชื่อกิจกรรม 1–40 ตัวอักษร");
  }

  await commit((source) => {
    const duplicate = source.categories.some((category) =>
      category.id !== id &&
      category.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );

    if (duplicate) throw new Error("มีชื่อกิจกรรมนี้อยู่แล้ว");

    if (id) {
      const category = categoryById(id, source);
      if (!category) throw new Error("ไม่พบกิจกรรมนี้");

      Object.assign(category, { name, icon, color, score });
    } else {
      if (source.categories.length >= MAX_CATEGORIES) {
        throw new Error(`เพิ่มกิจกรรมได้ไม่เกิน ${MAX_CATEGORIES} รายการ`);
      }

      source.categories.push({
        id: uid(),
        name,
        icon,
        color,
        score,
        archived: false
      });
    }
  });

  $("#category-dialog").close();
  toast("บันทึกกิจกรรมแล้ว");
}

async function toggleCategory(id) {
  await commit((source) => {
    const category = categoryById(id, source);
    if (!category) throw new Error("ไม่พบกิจกรรม");

    if (source.timer?.categoryId === id && !category.archived) {
      throw new Error("กรุณาหยุดกิจกรรมนี้ก่อนซ่อน");
    }

    category.archived = !category.archived;
  });
}

/* ---------------- EXPORT ---------------- */

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function csvCell(value) {
  let text = String(value ?? "");

  // ป้องกันข้อความผู้ใช้ถูก Excel ตีความเป็นสูตร
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) {
    text = "'" + text;
  }

  return `"${text.replace(/"/g, '""')}"`;
}

// แยกรายการข้ามเที่ยงคืนเป็นส่วนของแต่ละวัน
function splitByDay(start, end) {
  const pieces = [];
  let cursor = start;

  while (cursor < end) {
    const midnight = new Date(cursor);
    midnight.setHours(0, 0, 0, 0);
    midnight.setDate(midnight.getDate() + 1);

    const next = Math.min(end, midnight.getTime());
    if (next <= cursor) throw new Error("ไม่สามารถแบ่งช่วงวันได้");

    pieces.push({
      date: dayKey(cursor),
      start: cursor,
      end: next
    });

    cursor = next;
  }

  return pieces;
}

async function exportCSV() {
  state = await readState();
  const range = rangeFromInputs();
  const summary = summarize(range.start, range.end);

  if (!summary.rows.length) {
    throw new Error("ยังไม่มีข้อมูลในช่วงวันที่เลือก");
  }

  const rows = [[
    "รหัสรายการ",
    "วันที่ตามเครื่อง",
    "กิจกรรม",
    "เริ่มตามเวลาเครื่อง",
    "สิ้นสุดตามเวลาเครื่อง",
    "เริ่ม ISO UTC",
    "สิ้นสุด ISO UTC",
    "ระยะเวลา (วินาที)",
    "ระยะเวลา (นาที)",
    "คะแนนคุณค่า",
    "หมายเหตุ"
  ]];

  for (const entry of [...summary.rows].reverse()) {
    const category = categoryById(entry.categoryId);

    for (const piece of splitByDay(entry.clippedStart, entry.clippedEnd)) {
      const seconds = (piece.end - piece.start) / 1000;

      rows.push([
        entry.id,
        piece.date,
        category.name,
        localDateTime(piece.start).replace("T", " "),
        localDateTime(piece.end).replace("T", " "),
        new Date(piece.start).toISOString(),
        new Date(piece.end).toISOString(),
        seconds.toFixed(3),
        (seconds / 60).toFixed(4),
        entry.score,
        entry.note
      ]);
    }
  }

  const csv = "\uFEFF" +
    rows.map((row) => row.map(csvCell).join(",")).join("\r\n");

  downloadFile(
    `dayflow-${$("#report-from").value}-to-${$("#report-to").value}.csv`,
    csv,
    "text/csv;charset=utf-8"
  );

  toast("ส่งออก CSV แล้ว");
}

async function backupJSON() {
  const latest = await readState();

  const backup = {
    app: "DayFlow",
    exportedAt: new Date().toISOString(),
    data: latest
  };

  downloadFile(
    `dayflow-backup-${dayKey(Date.now())}-${Date.now()}.json`,
    JSON.stringify(backup, null, 2),
    "application/json"
  );

  toast("ส่งออกไฟล์สำรองแล้ว");
}

/* ---------------- RESTORE VALIDATION ---------------- */

function validateBackup(input) {
  if (!input || input.app !== "DayFlow" || input.data?.schema !== 1) {
    throw new Error("รูปแบบไฟล์สำรองไม่ถูกต้องหรือเป็นคนละเวอร์ชัน");
  }

  const source = input.data;

  if (
    !Array.isArray(source.categories) ||
    !Array.isArray(source.entries) ||
    source.categories.length > MAX_CATEGORIES ||
    source.entries.length > MAX_RECORDS
  ) {
    throw new Error("โครงสร้างข้อมูลไม่ถูกต้องหรือข้อมูลมีจำนวนมากเกินไป");
  }

  const validId = (value) =>
    typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);

  const allowedIcons = new Set(
    [...$("#category-icon").options].map((option) => option.value)
  );

  const categoryIds = new Set();
  const categoryNames = new Set();

  const categories = source.categories.map((category) => {
    if (
      !category ||
      !validId(category.id) ||
      categoryIds.has(category.id) ||
      typeof category.name !== "string" ||
      !category.name.trim() ||
      category.name.length > 40 ||
      categoryNames.has(category.name.trim().toLocaleLowerCase()) ||
      !allowedIcons.has(category.icon) ||
      !/^#[0-9a-fA-F]{6}$/.test(category.color) ||
      !validScore(category.score) ||
      typeof category.archived !== "boolean"
    ) {
      throw new Error("ข้อมูลกิจกรรมในไฟล์สำรองไม่ถูกต้อง");
    }

    categoryIds.add(category.id);
    categoryNames.add(category.name.trim().toLocaleLowerCase());

    return {
      id: category.id,
      name: category.name.trim(),
      icon: category.icon,
      color: category.color,
      score: category.score,
      archived: category.archived
    };
  });

  const cleaned = {
    schema: 1,
    categories,
    entries: [],
    timer: null
  };

  const entryIds = new Set();

  cleaned.entries = source.entries.map((entry) => {
    if (!entry || !validId(entry.id) || entryIds.has(entry.id)) {
      throw new Error("รหัสรายการไม่ถูกต้องหรือซ้ำกัน");
    }

    entryIds.add(entry.id);

    const result = {
      id: entry.id,
      categoryId: entry.categoryId,
      start: entry.start,
      end: entry.end,
      score: entry.score,
      note: entry.note
    };

    validateEntry(result, cleaned);
    return result;
  });

  const sorted = [...cleaned.entries].sort((a, b) => a.start - b.start);

  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index].start < sorted[index - 1].end) {
      throw new Error("ไฟล์สำรองมีรายการเวลาทับซ้อน");
    }
  }

  if (source.timer !== null) {
    const timer = source.timer;

    if (
      !timer ||
      !validId(timer.id) ||
      entryIds.has(timer.id) ||
      !categoryIds.has(timer.categoryId) ||
      !Number.isFinite(timer.start) ||
      timer.start < MIN_TIME ||
      timer.start > Date.now() ||
      !validScore(timer.score) ||
      cleaned.entries.some((entry) => entry.end > timer.start)
    ) {
      throw new Error("ข้อมูลตัวจับเวลาในไฟล์สำรองไม่ถูกต้อง");
    }

    cleaned.timer = {
      id: timer.id,
      categoryId: timer.categoryId,
      start: timer.start,
      score: timer.score
    };
  }

  return cleaned;
}

async function restoreJSON(file) {
  if (!file) return;

  if (file.size > 20 * 1024 * 1024) {
    throw new Error("ไฟล์ใหญ่เกิน 20 MB");
  }

  let parsed;

  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("อ่านไฟล์ JSON ไม่สำเร็จ");
  }

  const restored = validateBackup(parsed);

  if (!confirm(
    "การกู้คืนจะแทนที่ข้อมูลทั้งหมดในแอปนี้ " +
    "ควรสำรองข้อมูลปัจจุบันและปิดแอปหน้าต่างอื่นก่อน ดำเนินการต่อหรือไม่?"
  )) return;

  await commit((source) => {
    if (source.timer) {
      throw new Error("กรุณาหยุดและบันทึกกิจกรรมปัจจุบันก่อนกู้คืน");
    }
    return restored;
  });

  toast("กู้คืนข้อมูลเรียบร้อย");
}

/* ---------------- STORAGE / PWA ---------------- */

async function updateStorageStatus() {
  if (!navigator.storage?.persisted) {
    $("#storage-status").textContent =
      "เบราว์เซอร์นี้ไม่รองรับการตรวจสิทธิ์เก็บข้อมูลถาวร ควรสำรอง JSON เป็นประจำ";
    return;
  }

  try {
    const persisted = await navigator.storage.persisted();
    $("#storage-status").textContent = persisted
      ? "ได้รับสิทธิ์เก็บข้อมูลถาวรแล้ว แต่ยังควรสำรอง JSON"
      : "ยังไม่ได้รับสิทธิ์เก็บข้อมูลถาวร ควรสำรอง JSON เป็นประจำ";
  } catch {
    $("#storage-status").textContent =
      "ตรวจสถานะพื้นที่เก็บข้อมูลไม่ได้ ควรสำรอง JSON เป็นประจำ";
  }
}

async function requestPersistence() {
  if (!navigator.storage?.persist) {
    throw new Error("เบราว์เซอร์นี้ไม่รองรับการขอเก็บข้อมูลถาวร");
  }

  const granted = await navigator.storage.persist();
  await updateStorageStatus();

  toast(granted
    ? "ได้รับสิทธิ์แล้ว — ยังควรสำรองข้อมูลเป็นประจำ"
    : "เบราว์เซอร์ยังไม่อนุมัติ แต่แอปยังใช้งานได้");
}

function updateNetworkStatus() {
  $("#network-status").textContent = navigator.onLine
    ? "● ออนไลน์"
    : "● ออฟไลน์";
}

window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  $("#install-button").hidden = false;
});

window.addEventListener("appinstalled", () => {
  installPrompt = null;
  $("#install-button").hidden = true;
});

async function installApp() {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $("#install-button").hidden = true;
}

async function setupPWA() {
  if (!("serviceWorker" in navigator)) {
    showStatus(
      "เบราว์เซอร์นี้ไม่รองรับ Offline แนะนำ Chrome หรือ Safari รุ่นปัจจุบัน",
      true
    );
    return;
  }

  try {
    showStatus("กำลังเตรียมไฟล์สำหรับใช้งาน Offline…");

    swRegistration = await navigator.serviceWorker.register("./sw.js");

    const showUpdate = () => {
      $("#update-banner").hidden = false;
    };

    if (swRegistration.waiting) showUpdate();

    swRegistration.addEventListener("updatefound", () => {
      const worker = swRegistration.installing;
      if (!worker) return;

      worker.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdate();
        }
      });
    });

    let timeoutId;

    try {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error("เตรียม Offline ไม่สำเร็จภายในเวลาที่กำหนด"));
          }, 30000);
        })
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    showStatus("พร้อมใช้ Offline แล้ว · แนะนำสำรองข้อมูล JSON เป็นประจำ");
  } catch (error) {
    console.error(error);
    showStatus(
      "Offline ยังไม่พร้อม ตรวจว่าอัปโหลดทุกไฟล์รวมไอคอน PNG แล้ว " +
      "เปิดผ่าน HTTPS และลองโหลดใหม่ขณะมีอินเทอร์เน็ต",
      true
    );
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateRequested) location.reload();
  });
}

/* ---------------- EVENTS ---------------- */

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;

  if (button.dataset.view) {
    changeView(button.dataset.view);
    return;
  }

  if (button.dataset.close) {
    const dialog = document.getElementById(button.dataset.close);
    document.body.append($("#toast"));
    dialog.close();
    return;
  }

  if (button.hasAttribute("data-manual")) {
    run(() => openEntry());
  } else if (button.dataset.start) {
    run(() => startTimer(button.dataset.start));
  } else if (button.dataset.editEntry) {
    run(() => openEntry(button.dataset.editEntry));
  } else if (button.dataset.deleteEntry) {
    run(() => deleteEntry(button.dataset.deleteEntry));
  } else if (button.dataset.editCategory) {
    run(() => openCategory(button.dataset.editCategory));
  } else if (button.dataset.toggleCategory) {
    run(() => toggleCategory(button.dataset.toggleCategory));
  }
});

$$("dialog").forEach((dialog) => {
  dialog.addEventListener("close", () => {
    if (dialog.contains($("#toast"))) {
      document.body.append($("#toast"));
    }
  });
});

$("#stop-button").addEventListener("click", () => run(stopTimer));
$("#add-category-button").addEventListener("click", () => run(() => openCategory()));
$("#settings-add-category").addEventListener("click", () => run(() => openCategory()));

$("#entry-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => saveEntry(event));
});

$("#category-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => saveCategory(event));
});

$("#entry-category").addEventListener("change", () => {
  const category = categoryById($("#entry-category").value);
  if (category) $("#entry-score").value = category.score;
});

$("#report-from").addEventListener("change", () => {
  if (state) renderReports();
});

$("#report-to").addEventListener("change", () => {
  if (state) renderReports();
});

function setRange(days) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);

  $("#report-from").value = dayKey(start.getTime());
  $("#report-to").value = dayKey(end.getTime());

  if (state) renderReports();
}

$("#range-today").addEventListener("click", () => setRange(1));
$("#range-week").addEventListener("click", () => setRange(7));

$("#export-csv").addEventListener("click", () => run(exportCSV));
$("#backup-button").addEventListener("click", () => run(backupJSON));
$("#persist-button").addEventListener("click", () => run(requestPersistence));

$("#restore-button").addEventListener("click", () => {
  $("#restore-file").click();
});

$("#restore-file").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  run(() => restoreJSON(file));
});

$("#install-button").addEventListener("click", () => {
  installApp().catch((error) => toast(error.message));
});

$("#update-button").addEventListener("click", () => {
  if (!swRegistration?.waiting) {
    toast("ยังไม่พบเวอร์ชันใหม่ ลองเปิดแอปอีกครั้ง");
    return;
  }

  if (document.querySelector("dialog[open]")) {
    toast("กรุณาบันทึกหรือปิดแบบฟอร์มก่อนอัปเดต");
    return;
  }

  if (busy) {
    toast("กรุณารอให้บันทึกข้อมูลเสร็จก่อน");
    return;
  }

  updateRequested = true;
  swRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
});

/* ---------------- BOOT ---------------- */

async function boot() {
  updateNetworkStatus();
  setRange(1);

  try {
    if (!window.isSecureContext || !crypto.randomUUID) {
      throw new Error("กรุณาเปิดผ่าน HTTPS เช่น GitHub Pages หรือ localhost");
    }

    db = await openDatabase();
    state = await transactionChange((source) => source);
    render();

    await updateStorageStatus();
    setupPWA();

    setInterval(tick, 1000);
  } catch (error) {
    console.error(error);
    showStatus(
      `เริ่มแอปไม่สำเร็จ: ${error.message} ` +
      "ตรวจว่าไม่ได้ปิดกั้นพื้นที่เก็บข้อมูลเว็บไซต์",
      true
    );
  }
}

boot();