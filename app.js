// ---- State ----------------------------------------------------------
let nextId = 1;
const genId = () => nextId++;

const state = {
  eventName: "",
  items: [],              // { id, name, price }
  people: [],              // { id, name }
  assignments: {},         // { [itemId]: Set<personId> }
  charges: { service: 0, tax: 0, discount: 0, receiptTotal: null },
  splitMode: "items",      // "items" | "weighted"
  weights: {},             // { [personId]: number }
  stores: [],              // saved store visits: { id, label, savedAt, total, people: [{personId, personName, amount}] }
};

// ---- Persistence (localStorage) --------------------------------------------------------
const STORAGE_KEY = "wakete-event-v1";

function persist() {
  try {
    const assignments = {};
    for (const [itemId, set] of Object.entries(state.assignments)) assignments[itemId] = Array.from(set);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        nextId,
        eventName: state.eventName,
        items: state.items,
        people: state.people,
        assignments,
        charges: state.charges,
        splitMode: state.splitMode,
        weights: state.weights,
        stores: state.stores,
      })
    );
  } catch (err) {
    console.error("保存に失敗しました", err);
  }
}

function hydrate() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  nextId = data.nextId || 1;
  state.eventName = data.eventName || "";
  state.items = data.items || [];
  state.people = data.people || [];
  state.assignments = {};
  for (const [itemId, arr] of Object.entries(data.assignments || {})) {
    state.assignments[itemId] = new Set(arr);
  }
  state.charges = Object.assign({ service: 0, tax: 0, discount: 0, receiptTotal: null }, data.charges || {});
  state.splitMode = data.splitMode || "items";
  state.weights = data.weights || {};
  state.stores = data.stores || [];
}

function clearCurrentStoreInputs() {
  state.items = [];
  state.assignments = {};
  state.charges = { service: 0, tax: 0, discount: 0, receiptTotal: null };
  state.splitMode = "items";
  state.weights = {};
  for (const p of state.people) state.weights[p.id] = 1;
}

// ---- OCR --------------------------------------------------------------
const receiptInput = document.getElementById("receipt-input");
const receiptPreview = document.getElementById("receipt-preview");
const ocrStatus = document.getElementById("ocr-status");
const progressWrap = document.getElementById("ocr-progress-wrap");
const progressBar = document.getElementById("ocr-progress-bar");
const rawTextDetails = document.getElementById("raw-text-details");
const rawTextEl = document.getElementById("raw-text");

const OCR_TIMEOUT_MS = 45000;

receiptInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  receiptPreview.src = url;
  receiptPreview.classList.remove("hidden");

  if (typeof Tesseract === "undefined") {
    ocrStatus.textContent =
      "⚠️ OCRライブラリを読み込めませんでした。file://形式やネット接続が原因の可能性があります。下の「＋品目を追加」から手動で入力してください";
    return;
  }

  ocrStatus.textContent = "読み取り準備中...";
  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";

  try {
    const result = await Promise.race([
      Tesseract.recognize(file, "jpn+eng", {
        logger: (m) => {
          if (m.status === "recognizing text") {
            const pct = Math.round(m.progress * 100);
            progressBar.style.width = pct + "%";
            ocrStatus.textContent = `文字を読み取り中... ${pct}%`;
          } else {
            ocrStatus.textContent = m.status;
          }
        },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("タイムアウトしました(OCR処理が開始できていない可能性があります)")), OCR_TIMEOUT_MS)
      ),
    ]);

    const text = result.data.text;
    rawTextEl.textContent = text;
    rawTextDetails.classList.remove("hidden");
    ocrStatus.textContent = "読み取り完了！内容を確認してください";
    progressWrap.classList.add("hidden");

    const parsed = parseReceiptText(text);
    if (parsed.items.length === 0) {
      ocrStatus.textContent = "品目が自動検出できませんでした。手動で追加してください";
    }
    for (const it of parsed.items) {
      state.items.push({ id: genId(), name: it.name, price: it.price });
    }
    if (parsed.tax != null) state.charges.tax = parsed.tax;
    if (parsed.service != null) state.charges.service = parsed.service;
    if (parsed.total != null) state.charges.receiptTotal = parsed.total;

    renderItems();
    renderCharges();
    renderAssignTable();
    renderResult();
  } catch (err) {
    console.error(err);
    ocrStatus.textContent = "⚠️ 読み取りに失敗しました(" + err.message + ")。下の「＋品目を追加」から手動で入力してください";
    progressWrap.classList.add("hidden");
  }
});

// Heuristic receipt text parser (Japanese izakaya-style receipts).
function parseReceiptText(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const priceRe = /([0-9][0-9,]{1,})\s*円?\s*$/;
  const subtotalKw = /小計|^subtotal/i;
  const taxKw = /消費税|内税|外税|^tax/i;
  const serviceKw = /サービス料|サ料|service/i;
  const totalKw = /^合計|お会計|ご請求|total$/i;
  const skipKw = /お預|お釣|point|ポイント|電話|tel|レシート|領収|^\d{1,2}[:：]\d{2}$|^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/i;

  const items = [];
  let tax = null;
  let service = null;
  let total = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ");
    // Tesseract often inserts spaces between every CJK character, so keyword
    // matching needs a whitespace-free view of the line.
    const compact = line.replace(/\s+/g, "");
    if (skipKw.test(compact)) continue;

    const m = line.match(priceRe);
    if (!m) continue;

    const price = parseInt(m[1].replace(/,/g, ""), 10);
    if (!Number.isFinite(price) || price <= 0) continue;

    const namePart = line
      .slice(0, m.index)
      .trim()
      .replace(/[\s.・*]+$/, "")
      .replace(/\s+/g, "");

    if (totalKw.test(compact)) {
      total = price;
      continue;
    }
    if (taxKw.test(compact)) {
      tax = price;
      continue;
    }
    if (serviceKw.test(compact)) {
      service = price;
      continue;
    }
    if (subtotalKw.test(compact)) {
      continue; // informational only, recomputed from items
    }
    if (!namePart || namePart.length < 1) continue;
    if (price > 100000) continue; // guard against misreads

    items.push({ name: namePart, price });
  }

  return { items, tax, service, total };
}

// ---- Items table --------------------------------------------------------
const itemsTbody = document.getElementById("items-tbody");
const addItemBtn = document.getElementById("add-item-btn");

function renderItems() {
  itemsTbody.innerHTML = "";
  for (const item of state.items) {
    const tr = document.createElement("tr");

    const nameTd = document.createElement("td");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = item.name;
    nameInput.placeholder = "品目名";
    nameInput.addEventListener("input", () => {
      item.name = nameInput.value;
      renderAssignTable();
      renderResult();
    });
    nameTd.appendChild(nameInput);

    const priceTd = document.createElement("td");
    const priceInput = document.createElement("input");
    priceInput.type = "number";
    priceInput.value = item.price;
    priceInput.addEventListener("input", () => {
      item.price = parseInt(priceInput.value, 10) || 0;
      renderCharges();
      renderAssignTable();
      renderResult();
    });
    priceTd.appendChild(priceInput);

    const delTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.className = "row-delete-btn";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => {
      state.items = state.items.filter((i) => i.id !== item.id);
      delete state.assignments[item.id];
      renderItems();
      renderCharges();
      renderAssignTable();
      renderResult();
    });
    delTd.appendChild(delBtn);

    tr.append(nameTd, priceTd, delTd);
    itemsTbody.appendChild(tr);
  }
}

addItemBtn.addEventListener("click", () => {
  state.items.push({ id: genId(), name: "", price: 0 });
  renderItems();
  renderAssignTable();
  renderResult();
});

// ---- Charges --------------------------------------------------------
const chargeSubtotalEl = document.getElementById("charge-subtotal");
const chargeServiceEl = document.getElementById("charge-service");
const chargeTaxEl = document.getElementById("charge-tax");
const chargeDiscountEl = document.getElementById("charge-discount");
const chargeReceiptTotalEl = document.getElementById("charge-receipt-total");

function itemsSubtotal() {
  return state.items.reduce((sum, i) => sum + (i.price || 0), 0);
}

function renderCharges() {
  chargeSubtotalEl.value = itemsSubtotal().toLocaleString();
  chargeServiceEl.value = state.charges.service || 0;
  chargeTaxEl.value = state.charges.tax || 0;
  chargeDiscountEl.value = state.charges.discount || 0;
  chargeReceiptTotalEl.value = state.charges.receiptTotal ?? "";
}

chargeServiceEl.addEventListener("input", () => {
  state.charges.service = parseInt(chargeServiceEl.value, 10) || 0;
  renderResult();
});
chargeTaxEl.addEventListener("input", () => {
  state.charges.tax = parseInt(chargeTaxEl.value, 10) || 0;
  renderResult();
});
chargeDiscountEl.addEventListener("input", () => {
  state.charges.discount = parseInt(chargeDiscountEl.value, 10) || 0;
  renderResult();
});
chargeReceiptTotalEl.addEventListener("input", () => {
  const v = parseInt(chargeReceiptTotalEl.value, 10);
  state.charges.receiptTotal = Number.isFinite(v) ? v : null;
  renderResult();
});

// ---- People --------------------------------------------------------
const personNameInput = document.getElementById("person-name-input");
const addPersonBtn = document.getElementById("add-person-btn");
const peopleChips = document.getElementById("people-chips");

function addPerson() {
  const name = personNameInput.value.trim();
  if (!name) return;
  const person = { id: genId(), name };
  state.people.push(person);
  state.weights[person.id] = 1;
  personNameInput.value = "";
  renderPeople();
  renderAssignTable();
  renderWeightedList();
  renderResult();
}

addPersonBtn.addEventListener("click", addPerson);
personNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addPerson();
  }
});

function renderPeople() {
  peopleChips.innerHTML = "";
  for (const person of state.people) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<span>${escapeHtml(person.name)}</span>`;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
      state.people = state.people.filter((p) => p.id !== person.id);
      for (const set of Object.values(state.assignments)) set.delete(person.id);
      delete state.weights[person.id];
      renderPeople();
      renderAssignTable();
      renderWeightedList();
      renderResult();
    });
    chip.appendChild(removeBtn);
    peopleChips.appendChild(chip);
  }
}

// ---- Assign table --------------------------------------------------------
const assignTableWrap = document.getElementById("assign-table-wrap");

function getAssignedSet(itemId) {
  if (!state.assignments[itemId]) state.assignments[itemId] = new Set();
  return state.assignments[itemId];
}

function renderAssignTable() {
  assignTableWrap.innerHTML = "";

  if (state.items.length === 0 || state.people.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "品目とメンバーを両方登録すると、ここに割り当て表が出ます";
    assignTableWrap.appendChild(note);
    return;
  }

  const table = document.createElement("table");
  table.className = "assign-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.innerHTML = "<th>品目</th>" + state.people.map((p) => `<th>${escapeHtml(p.name)}</th>`).join("") + "<th>全員</th>";
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const item of state.items) {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.innerHTML = `${escapeHtml(item.name || "(無題)")}<div class="price-cell">¥${(item.price || 0).toLocaleString()}</div>`;
    tr.appendChild(nameTd);

    const assigned = getAssignedSet(item.id);
    for (const person of state.people) {
      const td = document.createElement("td");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = assigned.has(person.id);
      cb.addEventListener("change", () => {
        if (cb.checked) assigned.add(person.id);
        else assigned.delete(person.id);
        renderResult();
      });
      td.appendChild(cb);
      tr.appendChild(td);
    }

    const allTd = document.createElement("td");
    const allBtn = document.createElement("button");
    allBtn.className = "assign-all-btn";
    allBtn.textContent = "全員";
    allBtn.addEventListener("click", () => {
      for (const p of state.people) assigned.add(p.id);
      renderAssignTable();
      renderResult();
    });
    allTd.appendChild(allBtn);
    tr.appendChild(allTd);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  assignTableWrap.appendChild(table);
}

// ---- Split mode toggle --------------------------------------------------------
const modeItemsBtn = document.getElementById("mode-items-btn");
const modeWeightedBtn = document.getElementById("mode-weighted-btn");
const modeItemsPanel = document.getElementById("mode-items-panel");
const modeWeightedPanel = document.getElementById("mode-weighted-panel");
const resetWeightsBtn = document.getElementById("reset-weights-btn");
const weightedList = document.getElementById("weighted-list");

function syncModeUI() {
  const mode = state.splitMode;
  modeItemsBtn.classList.toggle("is-active", mode === "items");
  modeWeightedBtn.classList.toggle("is-active", mode === "weighted");
  modeItemsPanel.classList.toggle("hidden", mode !== "items");
  modeWeightedPanel.classList.toggle("hidden", mode !== "weighted");
}

function setSplitMode(mode) {
  state.splitMode = mode;
  syncModeUI();
  renderResult();
}

modeItemsBtn.addEventListener("click", () => setSplitMode("items"));
modeWeightedBtn.addEventListener("click", () => setSplitMode("weighted"));

resetWeightsBtn.addEventListener("click", () => {
  for (const p of state.people) state.weights[p.id] = 1;
  renderWeightedList();
  renderResult();
});

const WEIGHT_PRESETS = [0.5, 0.8, 1, 1.2, 1.5, 2];

function renderWeightedList() {
  weightedList.innerHTML = "";

  if (state.people.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "メンバーを追加すると、ここで比率を設定できます";
    weightedList.appendChild(note);
    return;
  }

  for (const person of state.people) {
    if (state.weights[person.id] == null) state.weights[person.id] = 1;

    const row = document.createElement("div");
    row.className = "weight-row";

    const top = document.createElement("div");
    top.className = "weight-top";

    const name = document.createElement("span");
    name.className = "weight-name";
    name.textContent = person.name;

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.1";
    input.value = state.weights[person.id];
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      state.weights[person.id] = Number.isFinite(v) && v >= 0 ? v : 0;
      renderPresetHighlight();
      renderResult();
    });

    top.append(name, input);
    row.appendChild(top);

    const presets = document.createElement("div");
    presets.className = "weight-presets";
    for (const preset of WEIGHT_PRESETS) {
      const btn = document.createElement("button");
      btn.className = "preset-btn";
      btn.dataset.preset = preset;
      btn.textContent = `${preset}x`;
      btn.addEventListener("click", () => {
        state.weights[person.id] = preset;
        input.value = preset;
        renderPresetHighlight();
        renderResult();
      });
      presets.appendChild(btn);
    }
    row.appendChild(presets);

    function renderPresetHighlight() {
      presets.querySelectorAll(".preset-btn").forEach((btn) => {
        btn.classList.toggle("is-active", parseFloat(btn.dataset.preset) === state.weights[person.id]);
      });
    }
    renderPresetHighlight();

    weightedList.appendChild(row);
  }
}

// ---- Result / calculation --------------------------------------------------------
const verifyBanner = document.getElementById("verify-banner");
const resultList = document.getElementById("result-list");
const copyResultBtn = document.getElementById("copy-result-btn");
const copyFeedback = document.getElementById("copy-feedback");

// Rounds each exact amount to whole yen, then fixes the rounding remainder
// onto the largest payer so displayed amounts sum to exactly trueTotal.
function roundWithRemainder(raw) {
  const rounded = raw.map((r) => ({ ...r, amount: Math.round(r.exact) }));
  const trueTotal = Math.round(raw.reduce((s, r) => s + r.exact, 0));
  const roundedTotal = rounded.reduce((s, r) => s + r.amount, 0);
  const diff = trueTotal - roundedTotal;
  if (diff !== 0 && rounded.length > 0) {
    const biggest = rounded.reduce((a, b) => (b.amount > a.amount ? b : a));
    biggest.amount += diff;
  }
  return rounded;
}

function computeItemsResult() {
  const perPersonItemSubtotal = {};
  for (const p of state.people) perPersonItemSubtotal[p.id] = 0;

  let unassignedTotal = 0;
  for (const item of state.items) {
    const assigned = getAssignedSet(item.id);
    if (assigned.size === 0) {
      unassignedTotal += item.price || 0;
      continue;
    }
    const share = (item.price || 0) / assigned.size;
    for (const personId of assigned) {
      perPersonItemSubtotal[personId] += share;
    }
  }

  const subtotal = itemsSubtotal();
  const extra = (state.charges.service || 0) + (state.charges.tax || 0) - (state.charges.discount || 0);

  const raw = state.people.map((p) => {
    const base = perPersonItemSubtotal[p.id] || 0;
    const extraShare = subtotal > 0 ? (base / subtotal) * extra : 0;
    return { person: p, base, extraShare, exact: base + extraShare };
  });

  const rounded = roundWithRemainder(raw);
  return { rounded, subtotal, extra, unassignedTotal, mode: "items" };
}

function computeWeightedResult() {
  const subtotal = itemsSubtotal();
  const extra = (state.charges.service || 0) + (state.charges.tax || 0) - (state.charges.discount || 0);
  const total = subtotal + extra;

  const totalWeight = state.people.reduce((s, p) => s + (state.weights[p.id] || 0), 0);

  const raw = state.people.map((p) => {
    const weight = state.weights[p.id] || 0;
    const exact = totalWeight > 0 ? (weight / totalWeight) * total : 0;
    return { person: p, weight, totalWeight, exact };
  });

  const rounded = roundWithRemainder(raw);
  return { rounded, subtotal, extra, unassignedTotal: 0, mode: "weighted", totalWeight };
}

function computeResult() {
  return state.splitMode === "weighted" ? computeWeightedResult() : computeItemsResult();
}

function renderResult() {
  if (state.people.length === 0) {
    resultList.innerHTML = '<div class="empty-note">メンバーを追加すると結果が表示されます</div>';
    verifyBanner.classList.add("hidden");
    persist();
    return;
  }

  const { rounded, subtotal, extra, unassignedTotal, mode, totalWeight } = computeResult();
  const grandTotal = subtotal + extra;

  resultList.innerHTML = "";
  for (const r of rounded) {
    const breakdown =
      mode === "weighted"
        ? `比率 ${r.weight} / 合計${totalWeight}`
        : `品目 ¥${Math.round(r.base).toLocaleString()} + 税/サ等 ¥${Math.round(r.extraShare).toLocaleString()}`;
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `
      <div>
        <div class="name">${escapeHtml(r.person.name)}</div>
        <div class="breakdown">${breakdown}</div>
      </div>
      <div class="amount">¥${r.amount.toLocaleString()}</div>
    `;
    resultList.appendChild(row);
  }

  verifyBanner.classList.remove("hidden");
  let messages = [];
  let warn = false;

  if (mode === "weighted" && totalWeight === 0 && state.people.length > 0) {
    messages.push("⚠️ 比率の合計が0です。少なくとも1人は比率を設定してください");
    warn = true;
  }

  if (unassignedTotal > 0) {
    messages.push(`⚠️ 未割り当ての品目が ¥${unassignedTotal.toLocaleString()} 分あります`);
    warn = true;
  }

  if (state.charges.receiptTotal != null) {
    const diff = state.charges.receiptTotal - grandTotal;
    if (Math.abs(diff) > 1) {
      messages.push(`⚠️ レシート記載合計(¥${state.charges.receiptTotal.toLocaleString()})と計算合計(¥${grandTotal.toLocaleString()})が ¥${diff.toLocaleString()} 一致しません`);
      warn = true;
    } else {
      messages.push(`✅ レシート記載合計と一致しています(¥${grandTotal.toLocaleString()})`);
    }
  } else if (!warn) {
    messages.push(`計算合計: ¥${grandTotal.toLocaleString()}`);
  }

  verifyBanner.className = warn ? "warn" : "ok";
  verifyBanner.textContent = messages.join(" / ");

  persist();
}

copyResultBtn.addEventListener("click", async () => {
  const { rounded } = computeResult();
  if (rounded.length === 0) return;
  const lines = ["🍻 WAKETE! 結果", ...rounded.map((r) => `${r.person.name}: ¥${r.amount.toLocaleString()}`)];
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    copyFeedback.textContent = "コピーしました！";
  } catch {
    copyFeedback.textContent = text;
  }
  setTimeout(() => (copyFeedback.textContent = ""), 3000);
});

// ---- Event bar (event name + reset) --------------------------------------------------------
const eventNameInput = document.getElementById("event-name-input");
const newEventBtn = document.getElementById("new-event-btn");

eventNameInput.addEventListener("input", () => {
  state.eventName = eventNameInput.value;
  persist();
});

newEventBtn.addEventListener("click", () => {
  const ok = confirm("現在のイベントの内容(参加メンバー・保存済みのお店を含む)をすべて消去して、新しいイベントを始めますか？この操作は取り消せません。");
  if (!ok) return;
  state.eventName = "";
  state.people = [];
  state.stores = [];
  clearCurrentStoreInputs();
  eventNameInput.value = "";
  renderItems();
  renderCharges();
  renderPeople();
  renderAssignTable();
  renderWeightedList();
  syncModeUI();
  renderStoresList();
  renderResult();
});

// ---- Save store / event total --------------------------------------------------------
const storeLabelInput = document.getElementById("store-label-input");
const saveStoreBtn = document.getElementById("save-store-btn");
const storesListEl = document.getElementById("stores-list");
const eventTotalWrap = document.getElementById("event-total-wrap");
const eventTotalList = document.getElementById("event-total-list");
const copyEventTotalBtn = document.getElementById("copy-event-total-btn");
const copyEventFeedback = document.getElementById("copy-event-feedback");

saveStoreBtn.addEventListener("click", () => {
  if (state.people.length === 0) {
    alert("先に参加メンバーを登録してください");
    return;
  }
  if (state.items.length === 0) {
    alert("品目が1件もありません。品目を登録してから保存してください");
    return;
  }

  const { rounded } = computeResult();
  const label = storeLabelInput.value.trim() || `${state.stores.length + 1}軒目`;

  state.stores.push({
    id: genId(),
    label,
    savedAt: Date.now(),
    people: rounded.map((r) => ({ personId: r.person.id, personName: r.person.name, amount: r.amount })),
    total: rounded.reduce((s, r) => s + r.amount, 0),
  });

  clearCurrentStoreInputs();
  storeLabelInput.value = "";

  renderItems();
  renderCharges();
  renderAssignTable();
  renderWeightedList();
  syncModeUI();
  renderStoresList();
  renderResult();
});

function renderStoresList() {
  storesListEl.innerHTML = "";

  if (state.stores.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = "まだ保存されたお店はありません。上の「結果」から保存すると、ここに並びます";
    storesListEl.appendChild(note);
    eventTotalWrap.classList.add("hidden");
    return;
  }

  for (const store of state.stores) {
    const row = document.createElement("div");
    row.className = "store-row";

    const top = document.createElement("div");
    top.className = "store-row-top";
    top.innerHTML = `
      <span class="store-label">${escapeHtml(store.label)}</span>
      <span class="store-total">¥${store.total.toLocaleString()}</span>
    `;
    row.appendChild(top);

    const peopleLine = document.createElement("div");
    peopleLine.className = "store-row-people";
    peopleLine.textContent = store.people.map((p) => `${p.personName} ¥${p.amount.toLocaleString()}`).join(" / ");
    row.appendChild(peopleLine);

    const actions = document.createElement("div");
    actions.className = "store-row-actions";

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "削除";
    delBtn.addEventListener("click", () => {
      const ok = confirm(`「${store.label}」の保存データを削除しますか？この操作は取り消せません。`);
      if (!ok) return;
      state.stores = state.stores.filter((s) => s.id !== store.id);
      renderStoresList();
      renderResult();
    });
    actions.appendChild(delBtn);

    row.appendChild(actions);
    storesListEl.appendChild(row);
  }

  eventTotalWrap.classList.remove("hidden");
  const totals = {};
  for (const store of state.stores) {
    for (const p of store.people) {
      if (!totals[p.personId]) totals[p.personId] = { name: p.personName, amount: 0 };
      totals[p.personId].amount += p.amount;
    }
  }

  eventTotalList.innerHTML = "";
  for (const t of Object.values(totals)) {
    const row = document.createElement("div");
    row.className = "result-row";
    row.innerHTML = `
      <div class="name">${escapeHtml(t.name)}</div>
      <div class="amount">¥${t.amount.toLocaleString()}</div>
    `;
    eventTotalList.appendChild(row);
  }
}

copyEventTotalBtn.addEventListener("click", async () => {
  if (state.stores.length === 0) return;
  const totals = {};
  for (const store of state.stores) {
    for (const p of store.people) {
      if (!totals[p.personId]) totals[p.personId] = { name: p.personName, amount: 0 };
      totals[p.personId].amount += p.amount;
    }
  }
  const title = state.eventName ? `🍻 ${state.eventName} 合計` : "🍻 WAKETE! この日の合計";
  const lines = [title, ...Object.values(totals).map((t) => `${t.name}: ¥${t.amount.toLocaleString()}`)];
  const text = lines.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    copyEventFeedback.textContent = "コピーしました！";
  } catch {
    copyEventFeedback.textContent = text;
  }
  setTimeout(() => (copyEventFeedback.textContent = ""), 3000);
});

// ---- Utils --------------------------------------------------------
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- Init --------------------------------------------------------
hydrate();
eventNameInput.value = state.eventName;
syncModeUI();
renderItems();
renderCharges();
renderPeople();
renderAssignTable();
renderWeightedList();
renderStoresList();
renderResult();
