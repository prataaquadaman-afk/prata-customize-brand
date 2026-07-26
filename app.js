// ============================================================
// PRATA AQUA — App logic
// Resort Customisation, Batch Stock Records, Company Inbox & Product Dashboard
// Uses Firebase v10 modular SDK
// ============================================================
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs,
  query, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;    // Firebase auth user
let currentProfile = null; // { name, role, email } from /users/{uid}
let resorts = [];          // registered resort companies
let bottles = [];          // registered products/bottles
let allEntries = [];       // raw sales entries
let allBatches = [];       // raw stock batch records
let allUsers = [];         // registered users

// ---------- DOM Helper ----------
const $ = (id) => document.getElementById(id);
const bootScreen = $("bootScreen");
const loginScreen = $("loginScreen");
const appScreen = $("appScreen");

// Helper: Check if a date string ("YYYY-MM-DD") falls in a range
function isDateInRange(dateStr, startDate, endDate) {
  if (!dateStr) return true;
  if (startDate && dateStr < startDate) return false;
  if (endDate && dateStr > endDate) return false;
  return true;
}

// ============================================================
// AUTHENTICATION
// ============================================================
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").hidden = true;
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  setLoginBusy(true);
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    $("loginError").textContent = friendlyAuthError(err);
    $("loginError").hidden = false;
  } finally {
    setLoginBusy(false);
  }
});

function setLoginBusy(busy) {
  $("loginBtn").disabled = busy;
  $("loginBtn").querySelector(".btn-label").hidden = busy;
  $("loginBtn").querySelector(".btn-spinner").hidden = !busy;
}

$("logoutBtn").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    currentProfile = null;
    bootScreen.hidden = true;
    loginScreen.hidden = false;
    appScreen.hidden = true;
    return;
  }
  try {
    currentProfile = await loadOrCreateProfile(user);
    applyProfileToUI();
    bootScreen.hidden = true;
    loginScreen.hidden = true;
    appScreen.hidden = false;
    startListeners();
  } catch (err) {
    console.error("Auth initialization error:", err);
    currentProfile = null;
    try { await signOut(auth); } catch (e) {}
    bootScreen.hidden = true;
    loginScreen.hidden = false;
    appScreen.hidden = true;
    $("loginError").textContent = "Profile loading error: " + err.message;
    $("loginError").hidden = false;
  }
});

function applyProfileToUI() {
  const label = currentProfile.name || currentUser.email;
  $("userNameLabel").textContent = label;
  $("userRoleLabel").textContent = currentProfile.role;
  
  const isAdmin = currentProfile.role === "admin";
  const noteEl = $("adminOnlyNote");
  const navLinkEl = $("navAdminLink");
  const tabLinkEl = $("tabAdminLink");
  if (noteEl) noteEl.hidden = isAdmin;
  if (navLinkEl) navLinkEl.hidden = !isAdmin;
  if (tabLinkEl) tabLinkEl.hidden = !isAdmin;

  if (!isAdmin) {
    const activePanel = document.querySelector(".panel:not([hidden])")?.id;
    if (activePanel === "panel-admin") {
      goToPanel("panel-dashboard");
    }
  }

  const initials = initialsOf(label);
  $("userAvatar").textContent = initials;
  $("userAvatarMobile").textContent = initials;
}

function initialsOf(name) {
  return name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

async function loadOrCreateProfile(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  
  const adminExistsRef = doc(db, "users", "admin_exists");
  const adminExistsSnap = await getDoc(adminExistsRef);

  if (!adminExistsSnap.exists()) {
    const name = snap.exists() ? (snap.data().name || user.email.split("@")[0]) : user.email.split("@")[0];
    const createdAt = snap.exists() ? (snap.data().createdAt || serverTimestamp()) : serverTimestamp();
    const profile = { name, email: user.email, role: "admin", createdAt };
    await setDoc(ref, profile);
    await setDoc(adminExistsRef, { exists: true, createdAt: serverTimestamp() });
    return profile;
  }

  if (snap.exists()) return snap.data();

  const profile = { name: user.email.split("@")[0], email: user.email, role: "staff", createdAt: serverTimestamp() };
  await setDoc(ref, profile);
  return profile;
}

function friendlyAuthError(err) {
  const code = err.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Email or password is incorrect.";
  }
  if (code.includes("too-many-requests")) return "Too many attempts. Try again shortly.";
  return "Couldn't log in. Please try again.";
}

// ============================================================
// NAVIGATION SYSTEM (Desktop Sidebar + Mobile Bottom Tabbar)
// ============================================================
function goToPanel(panelId) {
  if (panelId === "panel-admin" && currentProfile?.role !== "admin") {
    toast("Admin access required");
    return;
  }
  document.querySelectorAll(".tabbar__btn, .navlink").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.panel === panelId);
  });
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== panelId));
}

document.querySelectorAll(".tabbar__btn, .navlink").forEach((btn) => {
  btn.addEventListener("click", () => goToPanel(btn.dataset.panel));
});

// Helper to calculate total amount live
function updateEntryTotalCalc() {
  const qty = Number($("entryQty").value || 0);
  const rate = Number($("entryRate").value || 0);
  const total = qty * rate;
  $("entryTotalAmountCalc").textContent = `₹${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
$("entryQty").addEventListener("input", updateEntryTotalCalc);
$("entryRate").addEventListener("input", updateEntryTotalCalc);

// Auto rate fill when product selected
$("entryBrand").addEventListener("change", (e) => {
  const productName = e.target.value;
  if (!productName) return;
  const match = bottles.find((b) => b.name === productName);
  if (match) {
    if (match.rate) $("entryRate").value = match.rate;
    if (match.size) $("entrySize").value = match.size;
    updateEntryTotalCalc();
  }
});

// Set default dates
$("entryDate").valueAsDate = new Date();
$("batchDate").valueAsDate = new Date();

// ============================================================
// SECTION 0 — DASHBOARD (PRODUCT ANALYTICS & RECORDS)
// ============================================================
function renderDashboard() {
  const selectedProduct = $("dashProductSelect")?.value || "";
  const startDate = $("dashStartDate")?.value || "";
  const endDate = $("dashEndDate")?.value || "";

  // Filter entries & batches by selected product & date range
  const filteredEntries = allEntries.filter((e) => {
    if (selectedProduct && e.brandName !== selectedProduct) return false;
    return isDateInRange(e.date, startDate, endDate);
  });

  const filteredBatches = allBatches.filter((b) => {
    if (selectedProduct && b.productName !== selectedProduct) return false;
    return isDateInRange(b.date, startDate, endDate);
  });

  // Global KPIs
  const grossRev = filteredEntries.reduce((s, r) => s + Number(r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0))), 0);
  const totalCases = filteredEntries.reduce((s, r) => s + Number(r.quantity || 0), 0);
  const stockAdded = filteredBatches.reduce((s, r) => s + Number(r.quantity || 0), 0);
  const stockBalance = stockAdded - totalCases;

  // Find top product in date range
  const prodRevenueMap = {};
  filteredEntries.forEach((r) => {
    prodRevenueMap[r.brandName] = (prodRevenueMap[r.brandName] || 0) + Number(r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0)));
  });
  let topProd = "—";
  let maxRev = 0;
  Object.entries(prodRevenueMap).forEach(([pName, rev]) => {
    if (rev > maxRev) { maxRev = rev; topProd = pName; }
  });

  $("dashKpiTotalRevenue").textContent = `₹${grossRev.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  $("dashKpiTotalCases").textContent = totalCases.toLocaleString();
  $("dashKpiStockBalance").textContent = stockBalance.toLocaleString();
  $("dashKpiTopProduct").textContent = selectedProduct ? selectedProduct : topProd;

  // Render Product Cards Grid
  renderProductCardsGrid(startDate, endDate);

  // Render Product Sales Activity Table
  renderDashTable(filterRows(filteredEntries, $("dashSearch")?.value, ["brandName", "resortName", "productSize", "date"]));

  // Render Product Registered Stock Batches Table
  renderDashStockBatchTable(filteredBatches);
}

function renderProductCardsGrid(startDate, endDate) {
  const container = $("dashProductCardsGrid");
  if (!container) return;

  const productNames = [...new Set([...bottles.map((b) => b.name), ...allEntries.map((e) => e.brandName), ...allBatches.map((b) => b.productName)])].filter(Boolean).sort();

  if (!productNames.length) {
    container.innerHTML = `<div class="card" style="grid-column:1/-1; text-align:center; color:var(--text-muted);">No product records found. Register products in Admin.</div>`;
    return;
  }

  container.innerHTML = productNames.map((pName) => {
    const prodEntries = allEntries.filter((e) => e.brandName === pName && isDateInRange(e.date, startDate, endDate));
    const prodBatches = allBatches.filter((b) => b.productName === pName && isDateInRange(b.date, startDate, endDate));

    const casesSold = prodEntries.reduce((s, r) => s + Number(r.quantity || 0), 0);
    const totalRev = prodEntries.reduce((s, r) => s + Number(r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0))), 0);
    const totalStock = prodBatches.reduce((s, r) => s + Number(r.quantity || 0), 0);
    const availStock = totalStock - casesSold;
    const resortsServed = new Set(prodEntries.map((e) => e.resortName).filter(Boolean)).size;

    const sizeMap = {};
    prodEntries.forEach((e) => {
      sizeMap[e.productSize] = (sizeMap[e.productSize] || 0) + Number(e.quantity || 0);
    });

    const isSelected = $("dashProductSelect")?.value === pName;

    return `
      <div class="card dash-product-card ${isSelected ? 'dash-product-card--active' : ''}" onclick="selectDashboardProduct('${escapeHtml(pName)}')">
        <div class="dash-card-header">
          <div>
            <h4 class="dash-prod-title">${escapeHtml(pName)}</h4>
            <span class="dash-resort-tag">${resortsServed} resorts • ${prodBatches.length} stock batches</span>
          </div>
          <span class="dash-rev-pill">₹${totalRev.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
        </div>

        <div class="dash-stat-row">
          <div class="dash-stat">
            <span class="dash-stat-label">Cases Sold</span>
            <span class="dash-stat-val">${casesSold.toLocaleString()}</span>
          </div>
          <div class="dash-stat">
            <span class="dash-stat-label">Stock Balance</span>
            <span class="dash-stat-val ${availStock < 50 ? 'color-warn' : ''}">${availStock.toLocaleString()}</span>
          </div>
        </div>

        <div class="dash-size-pills">
          ${Object.entries(sizeMap).length ? Object.entries(sizeMap).map(([sz, qty]) => `
            <span class="badge-size">${escapeHtml(sz)}: ${qty} cases</span>
          `).join("") : '<span class="badge-size">No sales in range</span>'}
        </div>
      </div>
    `;
  }).join("");
}

window.selectDashboardProduct = (pName) => {
  const sel = $("dashProductSelect");
  if (sel) {
    sel.value = (sel.value === pName) ? "" : pName;
    renderDashboard();
  }
};

$("dashProductSelect")?.addEventListener("change", () => renderDashboard());
$("dashStartDate")?.addEventListener("change", () => renderDashboard());
$("dashEndDate")?.addEventListener("change", () => renderDashboard());
$("dashClearDateBtn")?.addEventListener("click", () => {
  if ($("dashStartDate")) $("dashStartDate").value = "";
  if ($("dashEndDate")) $("dashEndDate").value = "";
  renderDashboard();
});
$("dashSearch")?.addEventListener("input", () => renderDashboard());

function renderDashTable(rows) {
  const body = $("dashTableBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No matching product sales records found in date range.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const qty = Number(r.quantity || 0);
    const rate = Number(r.caseRate || 0);
    const amount = r.totalAmount ?? (qty * rate);
    return `
      <tr>
        <td>${escapeHtml(r.date)}</td>
        <td><strong>${escapeHtml(r.brandName)}</strong></td>
        <td>${escapeHtml(r.resortName || "—")}</td>
        <td><span class="badge-size">${escapeHtml(r.productSize)}</span></td>
        <td>${qty.toLocaleString()}</td>
        <td>₹${rate.toFixed(2)}</td>
        <td><strong>₹${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
        <td>${escapeHtml(r.createdBy || "—")}</td>
      </tr>
    `;
  }).join("");
}

function renderDashStockBatchTable(rows) {
  const body = $("dashStockBatchTableBody");
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">No registered stock batches found in date range.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td><span class="badge-batch">${escapeHtml(r.batchNumber)}</span></td>
      <td><strong>${escapeHtml(r.productName)}</strong></td>
      <td><span class="badge-size">${escapeHtml(r.productSize)}</span></td>
      <td><strong>${Number(r.quantity || 0).toLocaleString()} cases</strong></td>
      <td>${escapeHtml(r.note || "—")}</td>
      <td>${escapeHtml(r.createdBy || "—")}</td>
    </tr>
  `).join("");
}

$("exportDashBtn")?.addEventListener("click", () => {
  const selectedProduct = $("dashProductSelect")?.value;
  const startDate = $("dashStartDate")?.value;
  const endDate = $("dashEndDate")?.value;

  const rows = allEntries.filter((e) => {
    if (selectedProduct && e.brandName !== selectedProduct) return false;
    return isDateInRange(e.date, startDate, endDate);
  });

  if (!rows.length) { toast("No records match the selected dates"); return; }
  exportToExcel(
    rows.map((r) => ({
      Date: r.date,
      "Product Brand": r.brandName,
      "Resort / Company": r.resortName || "N/A",
      "Product Size": r.productSize,
      "Quantity (cases)": r.quantity,
      "Case Rate (₹)": r.caseRate,
      "Total Amount (₹)": r.totalAmount ?? (r.quantity * r.caseRate),
      "Recorded By": r.createdBy,
    })),
    `Dashboard_Report_${startDate || "Start"}_to_${endDate || "End"}`
  );
});

// ============================================================
// SECTION 1 — CUSTOMISATION SALES ENTRY
// ============================================================
$("entryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const resortName = $("entryResort").value.trim();
  const brandName = $("entryBrand").value.trim();
  const productSize = $("entrySize").value;
  const qty = Number($("entryQty").value);
  const caseRate = Number($("entryRate").value);
  const date = $("entryDate").value;

  if (!resortName) { toast("Please select a Resort / Company"); return; }
  if (!brandName) { toast("Please select a Product / Brand"); return; }
  if (!qty || qty <= 0) { toast("Enter a valid quantity"); return; }
  if (caseRate < 0) { toast("Enter a valid case rate"); return; }

  try {
    const payload = {
      resortName,
      brandName,
      productSize,
      date,
      caseRate,
      quantity: qty,
      totalAmount: qty * caseRate,
      createdBy: currentProfile?.name || currentUser.email,
      createdAt: serverTimestamp(),
    };

    await addDoc(collection(db, "entries"), payload);

    e.target.reset();
    $("entryDate").valueAsDate = new Date();
    updateEntryTotalCalc();
    toast("Customisation entry saved");
  } catch (err) {
    console.error("Save entry error:", err);
    toast("Error saving entry: " + err.message);
  }
});

function getFilteredEntries() {
  const startDate = $("entryStartDate")?.value;
  const endDate = $("entryEndDate")?.value;
  const searchTerm = $("entriesSearch")?.value;

  let rows = allEntries.filter((e) => isDateInRange(e.date, startDate, endDate));
  return filterRows(rows, searchTerm, ["resortName", "brandName", "productSize"]);
}

$("entryStartDate")?.addEventListener("change", refreshEntriesView);
$("entryEndDate")?.addEventListener("change", refreshEntriesView);
$("entryClearDateBtn")?.addEventListener("click", () => {
  if ($("entryStartDate")) $("entryStartDate").value = "";
  if ($("entryEndDate")) $("entryEndDate").value = "";
  refreshEntriesView();
});
$("entriesSearch")?.addEventListener("input", refreshEntriesView);

function refreshEntriesView() {
  const rows = getFilteredEntries();
  renderEntries(rows);
  const startDate = $("entryStartDate")?.value;
  const endDate = $("entryEndDate")?.value;
  const dateFilteredRaw = allEntries.filter((e) => isDateInRange(e.date, startDate, endDate));
  updateEntryKpis(dateFilteredRaw);
}

function renderEntries(rows) {
  const body = $("entriesTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="8">No sales entries found in date range.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const qty = Number(r.quantity || 0);
    const rate = Number(r.caseRate || 0);
    const amount = r.totalAmount ?? (qty * rate);
    return `
      <tr>
        <td>${escapeHtml(r.date)}</td>
        <td><strong>${escapeHtml(r.resortName || "—")}</strong></td>
        <td>${escapeHtml(r.brandName)}</td>
        <td><span class="badge-size">${escapeHtml(r.productSize)}</span></td>
        <td>${qty.toLocaleString()}</td>
        <td>₹${rate.toFixed(2)}</td>
        <td><strong>₹${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
        <td>${escapeHtml(r.createdBy || "—")}</td>
      </tr>`;
  }).join("");
}

function updateEntryKpis(rows) {
  const now = new Date();
  const thisMonth = rows.filter((r) => {
    const d = new Date(r.date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const uniqueResorts = new Set(rows.map((r) => r.resortName).filter(Boolean)).size;
  const totalRevenue = rows.reduce((s, r) => s + Number(r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0))), 0);

  $("kpiEntryTotal").textContent = rows.length;
  $("kpiEntryMonth").textContent = thisMonth;
  $("kpiEntryResorts").textContent = uniqueResorts;
  $("kpiEntryRevenue").textContent = `₹${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

$("exportEntriesBtn").addEventListener("click", () => {
  const startDate = $("entryStartDate")?.value;
  const endDate = $("entryEndDate")?.value;
  const rows = allEntries.filter((e) => isDateInRange(e.date, startDate, endDate));

  if (!rows.length) { toast("No sales entries match the selected dates"); return; }
  exportToExcel(
    rows.map((r) => ({
      Date: r.date,
      "Resort / Company": r.resortName || "N/A",
      "Product / Brand": r.brandName,
      "Product Size": r.productSize,
      "Quantity (cases)": r.quantity ?? 0,
      "Case Rate (₹)": r.caseRate ?? 0,
      "Total Amount (₹)": r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0)),
      "Entered By": r.createdBy,
    })),
    `Customisation_Sales_${startDate || "Start"}_to_${endDate || "End"}`
  );
});

// ============================================================
// SECTION 2 — NORMAL STOCK RECORD (BATCH ENTRY & LOG)
// ============================================================
$("stockBatchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const productName = $("batchProduct").value.trim();
  const productSize = $("batchSize").value;
  const batchNumber = $("batchNumber").value.trim();
  const date = $("batchDate").value;
  const qty = Number($("batchQty").value);
  const note = $("batchNote").value.trim();

  if (!productName) { toast("Select a product"); return; }
  if (!productSize) { toast("Select a size"); return; }
  if (!batchNumber) { toast("Enter batch number"); return; }
  if (!qty || qty <= 0) { toast("Enter valid quantity"); return; }

  try {
    await addDoc(collection(db, "stockBatches"), {
      productName,
      productSize,
      batchNumber,
      date,
      quantity: qty,
      note,
      createdBy: currentProfile?.name || currentUser.email,
      createdAt: serverTimestamp(),
    });

    e.target.reset();
    $("batchDate").valueAsDate = new Date();
    toast("Batch stock registered");
  } catch (err) {
    console.error("Register batch stock error:", err);
    toast("Error registering batch: " + err.message);
  }
});

$("stockBrandFilter")?.addEventListener("change", refreshStockView);
$("stockStartDate")?.addEventListener("change", refreshStockView);
$("stockEndDate")?.addEventListener("change", refreshStockView);
$("stockClearDateBtn")?.addEventListener("click", () => {
  if ($("stockStartDate")) $("stockStartDate").value = "";
  if ($("stockEndDate")) $("stockEndDate").value = "";
  refreshStockView();
});
$("batchSearch")?.addEventListener("input", refreshStockView);

function refreshStockView() {
  renderStockSummary();
  const searchTerm = $("batchSearch")?.value;
  const filtered = filterRows(allBatches, searchTerm, ["batchNumber", "productName", "productSize", "note"]);
  renderBatchLog(filtered);
}

function renderBatchLog(rows) {
  const body = $("batchTableBody");
  if (!body) return;

  const brandFilter = $("stockBrandFilter")?.value;
  const startDate = $("stockStartDate")?.value;
  const endDate = $("stockEndDate")?.value;

  let filtered = rows.filter((r) => {
    if (brandFilter && r.productName !== brandFilter) return false;
    return isDateInRange(r.date, startDate, endDate);
  });

  if (!filtered.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">No batch stock registered in selected range.</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map((r) => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td><span class="badge-batch">${escapeHtml(r.batchNumber)}</span></td>
      <td><strong>${escapeHtml(r.productName)}</strong></td>
      <td><span class="badge-size">${escapeHtml(r.productSize)}</span></td>
      <td>${Number(r.quantity || 0).toLocaleString()} cases</td>
      <td>${escapeHtml(r.note || "—")}</td>
      <td>${escapeHtml(r.createdBy || "—")}</td>
    </tr>
  `).join("");
}

function renderStockSummary() {
  const body = $("stockSummaryTableBody");
  if (!body) return;

  const brandFilter = $("stockBrandFilter")?.value;
  const startDate = $("stockStartDate")?.value;
  const endDate = $("stockEndDate")?.value;

  const summaryMap = {};

  allBatches.forEach((b) => {
    if (brandFilter && b.productName !== brandFilter) return;
    if (!isDateInRange(b.date, startDate, endDate)) return;
    const key = `${b.productName}__${b.productSize}`;
    if (!summaryMap[key]) {
      summaryMap[key] = { productName: b.productName, productSize: b.productSize, stockAdded: 0, sales: 0 };
    }
    summaryMap[key].stockAdded += Number(b.quantity || 0);
  });

  allEntries.forEach((e) => {
    if (brandFilter && e.brandName !== brandFilter) return;
    if (!isDateInRange(e.date, startDate, endDate)) return;
    const key = `${e.brandName}__${e.productSize}`;
    if (!summaryMap[key]) {
      summaryMap[key] = { productName: e.brandName, productSize: e.productSize, stockAdded: 0, sales: 0 };
    }
    summaryMap[key].sales += Number(e.quantity || 0);
  });

  const summaryList = Object.values(summaryMap);

  if (!summaryList.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No stock records found in date range.</td></tr>`;
    return;
  }

  body.innerHTML = summaryList.map((item) => {
    const balance = item.stockAdded - item.sales;
    let statusTag = "";
    if (balance <= 0) {
      statusTag = `<span class="tag tag--danger">No Stock</span>`;
    } else if (balance < 50) {
      statusTag = `<span class="tag tag--warn">Low Stock (${balance})</span>`;
    } else {
      statusTag = `<span class="tag tag--success">In Stock</span>`;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(item.productName)}</strong></td>
        <td><span class="badge-size">${escapeHtml(item.productSize)}</span></td>
        <td>${item.stockAdded.toLocaleString()}</td>
        <td>${item.sales.toLocaleString()}</td>
        <td><strong>${balance.toLocaleString()}</strong></td>
        <td>${statusTag}</td>
      </tr>
    `;
  }).join("");

  const totalProducts = new Set(summaryList.map((s) => s.productName)).size;
  const totalAdded = summaryList.reduce((s, item) => s + item.stockAdded, 0);
  const totalSales = summaryList.reduce((s, item) => s + item.sales, 0);
  const balanceStock = totalAdded - totalSales;

  $("kpiStockProducts").textContent = totalProducts;
  $("kpiStockTotalAdded").textContent = totalAdded.toLocaleString();
  $("kpiStockTotalSales").textContent = totalSales.toLocaleString();
  $("kpiStockBalance").textContent = balanceStock.toLocaleString();
}

$("exportStockBtn").addEventListener("click", () => {
  const brandFilter = $("stockBrandFilter")?.value;
  const startDate = $("stockStartDate")?.value;
  const endDate = $("stockEndDate")?.value;

  const summaryRows = [];
  const map = {};

  allBatches.forEach((b) => {
    if (brandFilter && b.productName !== brandFilter) return;
    if (!isDateInRange(b.date, startDate, endDate)) return;
    const k = `${b.productName}__${b.productSize}`;
    map[k] = map[k] || { Product: b.productName, Size: b.productSize, "Stock Added": 0, "Sales (Cases)": 0 };
    map[k]["Stock Added"] += Number(b.quantity || 0);
  });

  allEntries.forEach((e) => {
    if (brandFilter && e.brandName !== brandFilter) return;
    if (!isDateInRange(e.date, startDate, endDate)) return;
    const k = `${e.brandName}__${e.productSize}`;
    map[k] = map[k] || { Product: e.brandName, Size: e.productSize, "Stock Added": 0, "Sales (Cases)": 0 };
    map[k]["Sales (Cases)"] += Number(e.quantity || 0);
  });

  Object.values(map).forEach((v) => {
    v["Available Balance"] = v["Stock Added"] - v["Sales (Cases)"];
    summaryRows.push(v);
  });

  if (!summaryRows.length) { toast("No stock records match the selected dates"); return; }

  exportToExcel(summaryRows, `Stock_Record_${startDate || "Start"}_to_${endDate || "End"}`);
});

// ============================================================
// SECTION 3 — COMPANY SALES INBOX
// ============================================================
function renderResortOptionsInInbox() {
  const select = $("inboxResortSelect");
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = `<option value="">-- Choose Resort / Company --</option>` +
    resorts.map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)} (${escapeHtml(r.city || "Client")})</option>`).join("");
  if (currentVal) select.value = currentVal;
}

$("inboxResortSelect")?.addEventListener("change", (e) => loadCompanyInbox(e.target.value));
$("inboxStartDate")?.addEventListener("change", () => loadCompanyInbox($("inboxResortSelect")?.value));
$("inboxEndDate")?.addEventListener("change", () => loadCompanyInbox($("inboxResortSelect")?.value));
$("inboxClearDateBtn")?.addEventListener("click", () => {
  if ($("inboxStartDate")) $("inboxStartDate").value = "";
  if ($("inboxEndDate")) $("inboxEndDate").value = "";
  loadCompanyInbox($("inboxResortSelect")?.value);
});
$("inboxSearch")?.addEventListener("input", () => loadCompanyInbox($("inboxResortSelect")?.value));

function loadCompanyInbox(resortName) {
  if (!resortName) {
    $("inboxKpiTotalRevenue").textContent = "₹0";
    $("inboxKpiTotalCases").textContent = "0";
    $("inboxKpiTopSize").textContent = "—";
    $("inboxKpiLastOrder").textContent = "—";
    $("inboxTableBody").innerHTML = `<tr class="empty-row"><td colspan="7">Select a Resort / Company above to view its sales inbox.</td></tr>`;
    return;
  }

  const startDate = $("inboxStartDate")?.value;
  const endDate = $("inboxEndDate")?.value;

  const companyEntries = allEntries.filter((r) => {
    if (r.resortName !== resortName) return false;
    return isDateInRange(r.date, startDate, endDate);
  });

  renderCompanyInboxTable(filterRows(companyEntries, $("inboxSearch")?.value, ["brandName", "productSize", "date"]));

  const totalRev = companyEntries.reduce((s, r) => s + Number(r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0))), 0);
  const totalCases = companyEntries.reduce((s, r) => s + Number(r.quantity || 0), 0);

  const sizeCounts = {};
  companyEntries.forEach((r) => {
    sizeCounts[r.productSize] = (sizeCounts[r.productSize] || 0) + Number(r.quantity || 0);
  });
  let topSize = "—";
  let maxCnt = 0;
  Object.entries(sizeCounts).forEach(([sz, cnt]) => {
    if (cnt > maxCnt) { maxCnt = cnt; topSize = sz; }
  });

  const lastOrder = companyEntries.length ? companyEntries.map((r) => r.date).sort().reverse()[0] : "—";

  $("inboxKpiTotalRevenue").textContent = `₹${totalRev.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  $("inboxKpiTotalCases").textContent = totalCases.toLocaleString();
  $("inboxKpiTopSize").textContent = topSize;
  $("inboxKpiLastOrder").textContent = lastOrder;
}

function renderCompanyInboxTable(rows) {
  const body = $("inboxTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">No sales records found for this resort in selected date range.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const qty = Number(r.quantity || 0);
    const rate = Number(r.caseRate || 0);
    const amount = r.totalAmount ?? (qty * rate);
    return `
      <tr>
        <td>${escapeHtml(r.date)}</td>
        <td><strong>${escapeHtml(r.brandName)}</strong></td>
        <td><span class="badge-size">${escapeHtml(r.productSize)}</span></td>
        <td>${qty.toLocaleString()} cases</td>
        <td>₹${rate.toFixed(2)}</td>
        <td><strong>₹${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
        <td>${escapeHtml(r.createdBy || "—")}</td>
      </tr>
    `;
  }).join("");
}

$("exportInboxBtn").addEventListener("click", () => {
  const resortName = $("inboxResortSelect").value;
  if (!resortName) { toast("Select a resort company first"); return; }
  const startDate = $("inboxStartDate")?.value;
  const endDate = $("inboxEndDate")?.value;

  const companyEntries = allEntries.filter((r) => {
    if (r.resortName !== resortName) return false;
    return isDateInRange(r.date, startDate, endDate);
  });

  if (!companyEntries.length) { toast("No records match the selected date range"); return; }

  exportToExcel(
    companyEntries.map((r) => ({
      Date: r.date,
      Resort: r.resortName,
      Product: r.brandName,
      Size: r.productSize,
      "Cases Purchased": r.quantity,
      "Case Rate (₹)": r.caseRate,
      "Total Amount (₹)": r.totalAmount ?? (r.quantity * r.caseRate),
      "Recorded By": r.createdBy,
    })),
    `Inbox_${resortName.replace(/[^a-zA-Z0-9]/g, "_")}_${startDate || "Start"}_to_${endDate || "End"}`
  );
});

// ============================================================
// SECTION 4 — ADMIN PANEL
// ============================================================

// 1. Register Resort / Company
$("resortForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentProfile?.role !== "admin") { toast("Admins only"); return; }
  const name = $("resortName").value.trim();
  const contact = $("resortContact").value.trim();
  const phone = $("resortPhone").value.trim();
  const city = $("resortCity").value.trim();

  if (!name) { toast("Enter resort company name"); return; }

  try {
    await addDoc(collection(db, "resorts"), {
      name, contact, phone, city,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    toast("Resort company registered");
  } catch (err) {
    console.error("Register resort error:", err);
    toast("Error registering resort: " + err.message);
  }
});

function renderResortsTable(rows) {
  const body = $("resortsTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="6">No resorts registered yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td>${escapeHtml(r.contact || "—")}</td>
      <td>${escapeHtml(r.phone || "—")}</td>
      <td>${escapeHtml(r.city || "—")}</td>
      <td>${fmtDate(r.createdAt)}</td>
      <td>
        <button class="btn btn--ghost btn--sm btn-view-inbox" data-resort="${escapeHtml(r.name)}">
          View Inbox
        </button>
      </td>
    </tr>
  `).join("");

  document.querySelectorAll(".btn-view-inbox").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.resort;
      goToPanel("panel-inbox");
      $("inboxResortSelect").value = name;
      loadCompanyInbox(name);
    });
  });

  $("kpiAdminResorts").textContent = rows.length;
}

// 2. Register Product / Customisation
$("bottleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentProfile?.role !== "admin") { toast("Admins only"); return; }
  const name = $("bottleName").value.trim();
  const size = $("bottleSize").value;
  const rate = Number($("bottleRate").value || 0);

  if (!name) { toast("Enter product name"); return; }

  try {
    await addDoc(collection(db, "bottles"), {
      name, size, rate,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    toast("Product registered");
  } catch (err) {
    console.error("Register product error:", err);
    toast("Error registering product: " + err.message);
  }
});

function renderBottlesTable(rows) {
  const body = $("bottlesTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="4">No products registered yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((b) => `
    <tr>
      <td><strong>${escapeHtml(b.name)}</strong></td>
      <td><span class="badge-size">${escapeHtml(b.size)}</span></td>
      <td>₹${Number(b.rate || 0).toFixed(2)}</td>
      <td>${fmtDate(b.createdAt)}</td>
    </tr>
  `).join("");
  $("kpiAdminProducts").textContent = rows.length;
}

// 3. Register User Account
$("userForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentProfile?.role !== "admin") { toast("Admins only"); return; }

  const name = $("userFullName").value.trim();
  const email = $("userEmail").value.trim();
  const password = $("userPassword").value;
  const role = $("userRole").value;

  const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      name, email, role, createdAt: serverTimestamp(),
    });
    await signOut(secondaryAuth);
    toast("User registered successfully");
    e.target.reset();
  } catch (err) {
    toast(err.code === "auth/email-already-in-use" ? "That email is already registered" : "Couldn't register user: " + err.message);
  } finally {
    await deleteApp(secondaryApp);
  }
});

function renderUsersTable(rows) {
  const body = $("usersTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="3">None yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((u) => `
    <tr>
      <td><strong>${escapeHtml(u.name)}</strong></td>
      <td>${escapeHtml(u.email)}</td>
      <td><span class="role-pill">${escapeHtml(u.role)}</span></td>
    </tr>
  `).join("");
  $("kpiAdminUsers").textContent = rows.length;
  $("kpiAdminAdmins").textContent = rows.filter((u) => u.role === "admin").length;
}

// Dropdown synchronization
function populateDropdownOptions() {
  const entryResortSel = $("entryResort");
  if (entryResortSel) {
    const curVal = entryResortSel.value;
    entryResortSel.innerHTML = `<option value="">Select Resort / Company</option>` +
      resorts.map((r) => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)} (${escapeHtml(r.city || "Client")})</option>`).join("");
    if (curVal) entryResortSel.value = curVal;
  }
  renderResortOptionsInInbox();

  const uniqueBrands = [...new Set([...bottles.map((b) => b.name), ...allEntries.map((e) => e.brandName), ...allBatches.map((b) => b.productName)])].filter(Boolean).sort();
  
  const entryBrandSel = $("entryBrand");
  if (entryBrandSel) {
    const curVal = entryBrandSel.value;
    entryBrandSel.innerHTML = `<option value="">Select Product / Brand</option>` +
      uniqueBrands.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (curVal) entryBrandSel.value = curVal;
  }

  const batchProdSel = $("batchProduct");
  if (batchProdSel) {
    const curVal = batchProdSel.value;
    batchProdSel.innerHTML = `<option value="">Select Product / Brand</option>` +
      uniqueBrands.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (curVal) batchProdSel.value = curVal;
  }

  const dashProdSel = $("dashProductSelect");
  if (dashProdSel) {
    const curVal = dashProdSel.value;
    dashProdSel.innerHTML = `<option value="">-- All Products (Overview) --</option>` +
      uniqueBrands.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (curVal) dashProdSel.value = curVal;
  }

  const stockFilterSel = $("stockBrandFilter");
  if (stockFilterSel) {
    const curVal = stockFilterSel.value;
    stockFilterSel.innerHTML = `<option value="">-- All Product Brands (Show All Stock) --</option>` +
      uniqueBrands.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
    if (curVal) stockFilterSel.value = curVal;
  }
}

// ============================================================
// FIRESTORE REALTIME LISTENERS
// ============================================================
function startListeners() {
  onSnapshot(query(collection(db, "resorts"), orderBy("createdAt", "desc")), (qs) => {
    resorts = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    populateDropdownOptions();
    if (currentProfile?.role === "admin") {
      renderResortsTable(resorts);
    }
  });

  onSnapshot(query(collection(db, "bottles"), orderBy("createdAt", "desc")), (qs) => {
    bottles = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    populateDropdownOptions();
    if (currentProfile?.role === "admin") {
      renderBottlesTable(bottles);
    }
    renderDashboard();
  });

  onSnapshot(query(collection(db, "entries"), orderBy("createdAt", "desc")), (qs) => {
    allEntries = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    refreshEntriesView();
    renderStockSummary();
    renderDashboard();
    const selInboxResort = $("inboxResortSelect")?.value;
    if (selInboxResort) loadCompanyInbox(selInboxResort);
  });

  onSnapshot(query(collection(db, "stockBatches"), orderBy("createdAt", "desc")), (qs) => {
    allBatches = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    refreshStockView();
    renderDashboard();
  });

  if (currentProfile?.role === "admin") {
    onSnapshot(collection(db, "users"), (qs) => {
      allUsers = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderUsersTable(allUsers);
    });
  }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function filterRows(rows, term, fields) {
  const q = (term || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => fields.some((f) => String(r[f] ?? "").toLowerCase().includes(q)));
}

function exportToExcel(rows, filenameBase) {
  if (!rows.length) { toast("Nothing to export"); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, filenameBase.slice(0, 30));
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `PrataAqua_${filenameBase}_${stamp}.xlsx`);
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), 2400);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDate(ts) {
  if (!ts?.toDate) return "—";
  return ts.toDate().toLocaleDateString();
}
