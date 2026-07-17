// ============================================================
// PRATA AQUA — App logic
// Uses Firebase v10 modular SDK loaded straight from Google's CDN,
// plus your own config from firebase-config.js.
// ============================================================
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  createUserWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs,
  runTransaction, query, orderBy, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;    // Firebase auth user
let currentProfile = null; // { name, role, email } from /users/{uid}
let bottles = [];          // registered bottle list
let selectedBottleId = null;
let unsubMovements = null;

let allEntries = [];       // cached raw rows for client-side search
let allMovements = [];
let allUsers = [];
let allStocks = {};        // cached raw stock data keyed by bottleId

let stockChart = null;

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const bootScreen = $("bootScreen");
const loginScreen = $("loginScreen");
const appScreen = $("appScreen");

// ============================================================
// AUTH
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

let firstAuthCheck = true;

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    currentProfile = null;
    bootScreen.hidden = true;
    loginScreen.hidden = false;
    appScreen.hidden = true;
    firstAuthCheck = false;
    return;
  }
  try {
    currentProfile = await loadOrCreateProfile(user);
    applyProfileToUI();
    bootScreen.hidden = true;
    loginScreen.hidden = true;
    appScreen.hidden = false;
    firstAuthCheck = false;
    startListeners();
  } catch (err) {
    console.error("Auth initialization error:", err);
    currentProfile = null;
    try {
      await signOut(auth);
    } catch (signOutErr) {
      console.error("Failed to sign out after profile error:", signOutErr);
    }
    bootScreen.hidden = true;
    loginScreen.hidden = false;
    appScreen.hidden = true;
    firstAuthCheck = false;
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
      goToPanel("panel-entry");
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

  // If there's no admin_exists marker, the first logging user MUST be promoted to admin
  if (!adminExistsSnap.exists()) {
    const name = snap.exists() ? (snap.data().name || user.email.split("@")[0]) : user.email.split("@")[0];
    const createdAt = snap.exists() ? (snap.data().createdAt || serverTimestamp()) : serverTimestamp();
    const profile = { name, email: user.email, role: "admin", createdAt };
    await setDoc(ref, profile);
    await setDoc(adminExistsRef, { exists: true, createdAt: serverTimestamp() });
    return profile;
  }

  if (snap.exists()) return snap.data();

  // If snap doesn't exist but admin_exists does, create a regular staff profile
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
// NAVIGATION (sidebar on desktop + tabbar on mobile, kept in sync)
// ============================================================
function goToPanel(panelId) {
  if (panelId === "panel-admin" && currentProfile?.role !== "admin") {
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

// ============================================================
// SECTION 1 — DATA ENTRY
// ============================================================
$("entryDate").valueAsDate = new Date();

$("entryBrand").addEventListener("change", () => {
  const brandName = $("entryBrand").value;
  const sizeSelect = $("entrySize");
  if (!brandName) {
    sizeSelect.innerHTML = `<option value="">Select brand first</option>`;
    return;
  }
  const brandBottles = bottles.filter((b) => b.name === brandName);
  sizeSelect.innerHTML = `<option value="">Select size</option>` + 
    brandBottles.map((b) => `<option value="${escapeHtml(b.size)}">${escapeHtml(b.size)}</option>`).join("");
});

$("entryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const brandName = $("entryBrand").value.trim();
  const productSize = $("entrySize").value;
  const qty = Number($("entryQty").value);
  const caseRate = Number($("entryRate").value);
  const date = $("entryDate").value;

  if (!qty || qty <= 0) {
    toast("Enter a valid quantity");
    return;
  }

  // Find the registered bottle matching this brand and size
  const matchingBottle = bottles.find((b) => b.name === brandName && b.size === productSize);
  if (!matchingBottle) {
    toast("No registered bottle matches the selected Brand and Size");
    return;
  }

  try {
    const payload = {
      brandName,
      productSize,
      date,
      caseRate,
      quantity: qty,
      totalAmount: qty * caseRate,
      createdBy: currentProfile?.name || currentUser.email,
      createdAt: serverTimestamp(),
    };

    // Update stock atomically using a transaction
    const stockRef = doc(db, "stock", matchingBottle.id);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stockRef);
      let openingStock = 0;
      let openingSet = false;
      let totalProduction = 0;
      let totalSale = 0;
      if (snap.exists()) {
        const data = snap.data();
        openingStock = data.openingStock || 0;
        openingSet = data.openingSet || false;
        totalProduction = data.totalProduction || 0;
        totalSale = data.totalSale || 0;
      }
      totalSale += qty;
      const closingStock = openingStock - totalSale + totalProduction;
      tx.set(stockRef, {
        bottleId: matchingBottle.id,
        openingStock,
        openingSet,
        totalProduction,
        totalSale,
        closingStock,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });

    // Add transaction to stockTransactions
    await addDoc(collection(db, "stockTransactions"), {
      bottleId: matchingBottle.id,
      type: "sale",
      quantity: qty,
      date,
      note: `Customisation Sale: ${brandName} (${productSize})`,
      createdBy: currentProfile?.name || currentUser.email,
      createdAt: serverTimestamp(),
    });

    // Add to entries
    await addDoc(collection(db, "entries"), payload);

    e.target.reset();
    $("entryDate").valueAsDate = new Date();
    $("entrySize").innerHTML = `<option value="">Select brand first</option>`;
    toast("Entry saved & stock updated");
  } catch (err) {
    console.error("Save entry error:", err);
    toast("Error saving entry: " + err.message);
  }
});

$("entriesSearch").addEventListener("input", (e) => {
  renderEntries(filterRows(allEntries, e.target.value, ["brandName", "productSize"]));
});

function filterRows(rows, term, fields) {
  const q = term.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => fields.some((f) => String(r[f] ?? "").toLowerCase().includes(q)));
}

function renderEntries(rows) {
  const body = $("entriesTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">No entries yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((r) => {
    const qty = Number(r.quantity || 0);
    const rate = Number(r.caseRate || 0);
    const amount = r.totalAmount ?? (qty * rate);
    return `
      <tr>
        <td>${escapeHtml(r.date)}</td>
        <td>${escapeHtml(r.brandName)}</td>
        <td>${escapeHtml(r.productSize)}</td>
        <td>${qty.toLocaleString()}</td>
        <td>₹${rate.toFixed(2)}</td>
        <td>₹${amount.toFixed(2)}</td>
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
  
  const totalCases = rows.reduce((s, r) => s + Number(r.quantity || 0), 0);
  const totalRevenue = rows.reduce((s, r) => s + Number(r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0))), 0);
  
  $("kpiEntryTotal").textContent = rows.length;
  $("kpiEntryMonth").textContent = thisMonth;
  $("kpiEntryBrands").textContent = totalCases.toLocaleString();
  $("kpiEntryAvgRate").textContent = `₹${totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

$("exportEntriesBtn").addEventListener("click", async () => {
  const snap = await getDocs(query(collection(db, "entries"), orderBy("date", "desc")));
  const rows = snap.docs.map((d) => d.data());
  exportToExcel(
    rows.map((r) => ({
      Date: r.date, "Brand Name": r.brandName, "Product Size": r.productSize,
      "Quantity (cases)": r.quantity ?? 0,
      "Case Rate (₹)": r.caseRate ?? 0,
      "Total Amount (₹)": r.totalAmount ?? ((r.quantity || 0) * (r.caseRate || 0)),
      "Entered By": r.createdBy,
    })),
    "Customisation_Entries"
  );
});

// ============================================================
// SECTION 2 — STOCK RECORD
// ============================================================
function renderBottleOptions() {
  const select = $("stockBottleSelect");
  select.innerHTML = bottles.length
    ? bottles.map((b) => `<option value="${b.id}">${escapeHtml(b.name)} (${escapeHtml(b.size)})</option>`).join("")
    : `<option value="">Register a bottle in Admin first</option>`;
  if (bottles.length && !selectedBottleId) {
    selectedBottleId = bottles[0].id;
    select.value = selectedBottleId;
    loadStockForBottle(selectedBottleId);
  } else if (selectedBottleId) {
    select.value = selectedBottleId;
  }
}

function renderBrandOptions() {
  const select = $("entryBrand");
  if (!select) return;
  const uniqueNames = [...new Set(bottles.map((b) => b.name))].sort();
  select.innerHTML = uniqueNames.length
    ? `<option value="">Select brand</option>` + uniqueNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
    : `<option value="">Register a bottle in Admin first</option>`;
}

$("stockBottleSelect").addEventListener("change", (e) => {
  selectedBottleId = e.target.value;
  if (selectedBottleId) loadStockForBottle(selectedBottleId);
});

async function loadStockForBottle(bottleId) {
  if (unsubMovements) unsubMovements();
  $("stockMeter").hidden = false;

  const data = allStocks[bottleId];
  if (!data || !data.openingSet) {
    $("openingStockCard").hidden = false;
    $("movementForm").hidden = true;
    $("stockChartCard").hidden = true;
    $("meterOpening").textContent = "—";
    $("meterProduction").textContent = "—";
    $("meterSale").textContent = "—";
    $("meterClosing").textContent = "—";
  } else {
    $("openingStockCard").hidden = true;
    $("movementForm").hidden = false;
    $("stockChartCard").hidden = false;
    updateMeters(data);
  }

  const txQuery = query(collection(db, "stockTransactions"), orderBy("createdAt", "desc"));
  unsubMovements = onSnapshot(txQuery, (qs) => {
    allMovements = qs.docs.map((d) => d.data()).filter((r) => r.bottleId === bottleId);
    renderMovements(filterRows(allMovements, $("movementsSearch").value, ["note", "type"]));
    renderStockChart(allMovements);
  });
}

function updateMeters(data) {
  animateNumber($("meterOpening"), data.openingStock ?? 0);
  animateNumber($("meterProduction"), data.totalProduction ?? 0);
  animateNumber($("meterSale"), data.totalSale ?? 0);
  animateNumber($("meterClosing"), data.closingStock ?? 0);
}

function animateNumber(el, target) {
  const start = Number(el.dataset.val || 0);
  const dur = 500;
  const t0 = performance.now();
  function step(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = Math.round(start + (target - start) * eased);
    el.textContent = val.toLocaleString();
    if (p < 1) requestAnimationFrame(step);
    else el.dataset.val = target;
  }
  requestAnimationFrame(step);
}

$("setOpeningBtn").addEventListener("click", async () => {
  const val = Number($("openingStockInput").value);
  if (!selectedBottleId || Number.isNaN(val) || val < 0) {
    toast("Enter a valid opening stock");
    return;
  }
  try {
    const stockRef = doc(db, "stock", selectedBottleId);
    
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stockRef);
      let totalProduction = 0;
      let totalSale = 0;
      
      if (snap.exists()) {
        const data = snap.data();
        if (data.openingSet) {
          throw new Error("Opening stock is already locked for this bottle");
        }
        totalProduction = data.totalProduction || 0;
        totalSale = data.totalSale || 0;
      }
      
      const closingStock = val - totalSale + totalProduction;
      
      tx.set(stockRef, {
        bottleId: selectedBottleId,
        openingStock: val,
        openingSet: true,
        totalProduction,
        totalSale,
        closingStock,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });
    
    toast("Opening stock locked");
    loadStockForBottle(selectedBottleId);
  } catch (err) {
    console.error("Lock opening stock error:", err);
    toast("Error locking stock: " + err.message);
  }
});

// Automatic rule: closingStock = openingStock - totalSale + totalProduction
// Applied atomically via a Firestore transaction so concurrent entries
// from different devices never race each other.
$("movementForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedBottleId) return;
  const type = $("movementType").value; // 'production' | 'sale'
  const qty = Number($("movementQty").value);
  const date = $("movementDate").value || new Date().toISOString().slice(0, 10);
  const note = $("movementNote").value.trim();

  if (!qty || qty <= 0) { toast("Enter a valid quantity"); return; }

  try {
    const stockRef = doc(db, "stock", selectedBottleId);

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(stockRef);
      if (!snap.exists() || !snap.data().openingSet) {
        throw new Error("Set opening stock first");
      }
      const data = snap.data();
      const totalProduction = (data.totalProduction || 0) + (type === "production" ? qty : 0);
      const totalSale = (data.totalSale || 0) + (type === "sale" ? qty : 0);
      const closingStock = data.openingStock - totalSale + totalProduction;
      tx.update(stockRef, { totalProduction, totalSale, closingStock, updatedAt: serverTimestamp() });
    });

    await addDoc(collection(db, "stockTransactions"), {
      bottleId: selectedBottleId,
      type, quantity: qty, date, note,
      createdBy: currentProfile?.name || currentUser.email,
      createdAt: serverTimestamp(),
    });

    e.target.reset();
    $("movementDate").valueAsDate = new Date();
    toast("Movement recorded");
    loadStockForBottle(selectedBottleId);
  } catch (err) {
    console.error("Record movement error:", err);
    toast("Error recording movement: " + err.message);
  }
});
$("movementDate").valueAsDate = new Date();

$("movementsSearch").addEventListener("input", (e) => {
  renderMovements(filterRows(allMovements, e.target.value, ["note", "type"]));
});

function renderMovements(rows) {
  const body = $("movementsTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="5">No movements yet.</td></tr>`;
    return;
  }
  const sorted = [...rows].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  body.innerHTML = sorted.map((r) => `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td><span class="tag tag--${r.type}">${r.type === "production" ? "Production" : "Sale"}</span></td>
      <td>${r.quantity}</td>
      <td>${escapeHtml(r.note || "—")}</td>
      <td>${escapeHtml(r.createdBy || "—")}</td>
    </tr>`).join("");
}

function renderStockChart(movements) {
  const canvas = $("stockChart");
  if (!canvas || typeof Chart === "undefined") return;
  const byDate = {};
  [...movements].sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach((m) => {
    byDate[m.date] = byDate[m.date] || { production: 0, sale: 0 };
    byDate[m.date][m.type] += m.quantity;
  });
  const labels = Object.keys(byDate);
  const production = labels.map((d) => byDate[d].production);
  const sale = labels.map((d) => byDate[d].sale);

  if (stockChart) stockChart.destroy();
  stockChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Production", data: production, borderColor: "#1E8E5A", backgroundColor: "rgba(30,142,90,0.12)", tension: 0.35, fill: true },
        { label: "Sale", data: sale, borderColor: "#FF6B4A", backgroundColor: "rgba(255,107,74,0.12)", tension: 0.35, fill: true },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { font: { family: "Inter" }, boxWidth: 10 } } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: "#EAF6F6" } },
      },
    },
  });
}

function renderAllStockTable() {
  const body = $("allStockTableBody");
  if (!body) return;
  if (!bottles.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7">No registered bottles. Register in Admin first.</td></tr>`;
    return;
  }
  
  body.innerHTML = bottles.map((b) => {
    const stock = allStocks[b.id];
    const hasOpening = stock && stock.openingSet;
    const opening = hasOpening ? stock.openingStock : "—";
    const prod = hasOpening ? stock.totalProduction : (stock?.totalProduction ?? 0);
    const sale = hasOpening ? stock.totalSale : (stock?.totalSale ?? 0);
    const closing = hasOpening ? stock.closingStock : "—";
    
    let statusHtml = "";
    if (!hasOpening) {
      statusHtml = `<span class="tag tag--warn" style="background-color: #FEF3C7; color: #D97706; padding: 4px 10px;">Pending Opening Stock</span>`;
    } else if (stock.closingStock < 100) {
      statusHtml = `<span class="tag tag--danger" style="background-color: #FEE2E2; color: #DC2626; padding: 4px 10px;">Low Stock</span>`;
    } else {
      statusHtml = `<span class="tag tag--success" style="background-color: #D1FAE5; color: #059669; padding: 4px 10px;">Good</span>`;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(b.name)}</strong></td>
        <td>${escapeHtml(b.size)}</td>
        <td>${hasOpening ? Number(opening).toLocaleString() : opening}</td>
        <td>${Number(prod).toLocaleString()}</td>
        <td>${Number(sale).toLocaleString()}</td>
        <td>${hasOpening ? Number(closing).toLocaleString() : closing}</td>
        <td>${statusHtml}</td>
      </tr>
    `;
  }).join("");
}

function updateStockKpis() {
  const stockRows = Object.values(allStocks);
  const totalClosing = stockRows.reduce((s, r) => s + (r.closingStock || 0), 0);
  const lowStock = stockRows.filter((r) => r.openingSet && (r.closingStock ?? 0) < 100).length;
  
  $("kpiStockBottles").textContent = bottles.length;
  $("kpiStockClosing").textContent = totalClosing.toLocaleString();
  $("kpiStockLow").textContent = lowStock;
}

$("exportStockBtn").addEventListener("click", async () => {
  const stockSnap = await getDocs(collection(db, "stock"));
  const rows = stockSnap.docs.map((d) => {
    const data = d.data();
    const bottle = bottles.find((b) => b.id === d.id);
    return {
      Bottle: bottle ? bottle.name : d.id,
      "Opening Stock": data.openingStock ?? "",
      "Total Production": data.totalProduction ?? 0,
      "Total Sale": data.totalSale ?? 0,
      "Closing Stock": data.closingStock ?? "",
    };
  });
  exportToExcel(rows, "Stock_Record");
});

// ============================================================
// SECTION 3 — ADMIN
// ============================================================
$("bottleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (currentProfile?.role !== "admin") { toast("Admins only"); return; }
  try {
    await addDoc(collection(db, "bottles"), {
      name: $("bottleName").value.trim(),
      size: $("bottleSize").value,
      createdAt: serverTimestamp(),
    });
    e.target.reset();
    toast("Bottle registered");
  } catch (err) {
    console.error("Register bottle error:", err);
    toast("Error registering bottle: " + err.message);
  }
});

function renderBottlesTable(rows) {
  const body = $("bottlesTableBody");
  if (!rows.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="3">None yet.</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((b) => `
    <tr><td>${escapeHtml(b.name)}</td><td>${escapeHtml(b.size)}</td><td>${fmtDate(b.createdAt)}</td></tr>
  `).join("");
  $("kpiAdminBottles").textContent = rows.length;
}

// Registering a user creates a real Firebase Auth account without
// signing the admin out: we spin up a throwaway secondary app instance,
// create the account there, then tear that instance down.
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
    toast("User registered");
    e.target.reset();
  } catch (err) {
    toast(err.code === "auth/email-already-in-use" ? "That email is already registered" : "Couldn't register user");
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
    <tr><td>${escapeHtml(u.name)}</td><td>${escapeHtml(u.email)}</td><td>${escapeHtml(u.role)}</td></tr>
  `).join("");
  $("kpiAdminUsers").textContent = rows.length;
  $("kpiAdminAdmins").textContent = rows.filter((u) => u.role === "admin").length;
}

// ============================================================
// LIVE LISTENERS (start once logged in)
// ============================================================
function startListeners() {
  onSnapshot(query(collection(db, "entries"), orderBy("createdAt", "desc")), (qs) => {
    allEntries = qs.docs.map((d) => d.data());
    renderEntries(filterRows(allEntries, $("entriesSearch").value, ["brandName", "productSize"]));
    updateEntryKpis(allEntries);
  });

  onSnapshot(query(collection(db, "bottles"), orderBy("createdAt", "desc")), (qs) => {
    bottles = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderBottleOptions();
    renderBrandOptions();
    if (currentProfile?.role === "admin") {
      renderBottlesTable(bottles);
    }
    renderAllStockTable();
    updateStockKpis();
  });

  onSnapshot(collection(db, "stock"), (qs) => {
    allStocks = {};
    qs.docs.forEach((d) => {
      allStocks[d.id] = d.data();
    });
    renderAllStockTable();
    updateStockKpis();
    if (selectedBottleId) {
      const data = allStocks[selectedBottleId];
      if (data && data.openingSet) {
        $("openingStockCard").hidden = true;
        $("movementForm").hidden = false;
        $("stockChartCard").hidden = false;
        updateMeters(data);
      } else {
        $("openingStockCard").hidden = false;
        $("movementForm").hidden = true;
        $("stockChartCard").hidden = true;
        $("meterOpening").textContent = "—";
        $("meterProduction").textContent = "—";
        $("meterSale").textContent = "—";
        $("meterClosing").textContent = "—";
      }
    }
  });

  if (currentProfile?.role === "admin") {
    onSnapshot(collection(db, "users"), (qs) => {
      allUsers = qs.docs.map((d) => d.data());
      renderUsersTable(allUsers);
    });
  }
}

// ============================================================
// HELPERS
// ============================================================
function exportToExcel(rows, filenameBase) {
  if (!rows.length) { toast("Nothing to export yet"); return; }
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
