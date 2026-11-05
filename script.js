// GPK Badminton Live Scoreboard (singles + doubles)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBSEgM3lh0bPyJdcBin1trKnmC0ntWOf4Q",
  authDomain: "gpk-cricket.firebaseapp.com",
  databaseURL: "https://gpk-cricket-default-rtdb.firebaseio.com",
  projectId: "gpk-cricket",
  storageBucket: "gpk-cricket.firebasestorage.app",
  messagingSenderId: "1095579929817",
  appId: "1:1095579929817:web:b957ac1eba24a5331f42c8",
  measurementId: "G-57YZ1SX6QL"
};

const $ = (id) => document.getElementById(id);
const authBtn = $("authBtn");
const statusEl = $("connectionStatus");
const scorePath = "matches/gpk-badminton-score";
// points per game -> hard cap (game ends at the cap even without a 2-point lead)
const CAPS = { 11: 15, 15: 21, 21: 30 };

let app, db, auth, isScorer = false, isApplyingRemote = false;
let toastTimer, saveTimer;
let snapshots = [];

function freshState(old) {
  return {
    type: old?.type || "singles",
    points: old?.points || 21,
    bestOf: old?.bestOf || 3,
    players: old?.players || { a: ["PLAYER A", "PARTNER A"], b: ["PLAYER B", "PARTNER B"] },
    score: { a: 0, b: 0 },
    games: [],
    gamesWon: { a: 0, b: 0 },
    server: "a",
    right: { a: 0, b: 0 },   // index of the player standing in the RIGHT court (doubles)
    intervalDone: false,
    matchOver: null,
    notice: "",
    history: []
  };
}
let state = freshState();

function normalize(d) {
  const base = freshState();
  const names = (arr, defs) => [0, 1].map(i => (arr && arr[i] != null) ? String(arr[i]) : defs[i]);
  const pts = Number(d.points);
  const bo = Number(d.bestOf);
  return {
    type: d.type === "doubles" ? "doubles" : "singles",
    points: [11, 15, 21].includes(pts) ? pts : 21,
    bestOf: [1, 3, 5].includes(bo) ? bo : 3,
    players: { a: names(d.players?.a, base.players.a), b: names(d.players?.b, base.players.b) },
    score: { a: Number(d.score?.a || 0), b: Number(d.score?.b || 0) },
    games: Array.isArray(d.games) ? d.games.map(g => ({ a: Number(g.a || 0), b: Number(g.b || 0) })) : [],
    gamesWon: { a: Number(d.gamesWon?.a || 0), b: Number(d.gamesWon?.b || 0) },
    server: d.server === "b" ? "b" : "a",
    right: { a: Number(d.right?.a || 0) === 1 ? 1 : 0, b: Number(d.right?.b || 0) === 1 ? 1 : 0 },
    intervalDone: !!d.intervalDone,
    matchOver: d.matchOver === "a" || d.matchOver === "b" ? d.matchOver : null,
    notice: d.notice || "",
    history: Array.isArray(d.history) ? d.history : []
  };
}

/* ---------- helpers ---------- */
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}
function setConnection(text, online = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("online", online);
}
function esc(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const otherSide = (s) => (s === "a" ? "b" : "a");
function sideName(s) {
  const p = state.players[s];
  const fallback = s === "a" ? "SIDE A" : "SIDE B";
  if (state.type === "doubles") return `${p[0] || "—"} / ${p[1] || "—"}`;
  return p[0] || fallback;
}
function started() {
  return state.games.length > 0 || state.score.a > 0 || state.score.b > 0;
}
function wonGame(s, o) {
  const t = state.points;
  return (s >= t && s - o >= 2) || s === CAPS[t];
}
function wouldWin(s, o) { return wonGame(s + 1, o); }
function serverInfo() {
  const sv = state.server;
  const even = state.score[sv] % 2 === 0;
  let idx = 0;
  if (state.type === "doubles") idx = even ? state.right[sv] : 1 - state.right[sv];
  return { side: sv, name: state.players[sv][idx] || "—", court: even ? "RIGHT" : "LEFT" };
}

/* ---------- access / cloud ---------- */
function updateAccess() {
  document.querySelectorAll("#matchType, #pointsSel, #bestOfSel, #serveBtn, #courtBtn, #newMatchBtn, .player-input")
    .forEach(el => {
      el.disabled = !isScorer;
      el.style.opacity = isScorer ? "1" : ".62";
      el.style.cursor = isScorer ? "" : "not-allowed";
    });
  authBtn.textContent = isScorer ? "SCORER LOGOUT" : "SCORER LOGIN";
}
function saveCloud() {
  if (!isScorer || !db) return;
  set(ref(db, scorePath), { ...state, updatedAt: Date.now() }).catch(err => {
    console.error(err);
    showToast("Could not save to cloud. Check Firebase rules and connection.");
  });
}
function queueSave() {
  if (!isScorer || isApplyingRemote) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCloud, 350);
}
function startFirebase() {
  try {
    app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    auth = getAuth(app);
    onValue(ref(db, scorePath), snapshot => {
      const data = snapshot.val();
      if (data) {
        isApplyingRemote = true;
        state = normalize(data);
        snapshots = [];
        render();
        isApplyingRemote = false;
        setConnection("LIVE · SYNCED", true);
      } else {
        setConnection("CONNECTED · NO SCORE", true);
        if (isScorer) saveCloud();
      }
    }, error => {
      console.error(error);
      setConnection("DATABASE ERROR");
      showToast("Database access error. Check your Realtime Database rules.");
    });
    onAuthStateChanged(auth, user => {
      isScorer = !!user;
      updateAccess();
      render();
      if (user) {
        setConnection("SCORER CONNECTED", true);
        showToast("Scorer mode enabled. Your updates are shared live.");
        if (!started() && !state.history.length) saveCloud();
      } else {
        setConnection("LIVE VIEWER", true);
      }
    });
  } catch (err) {
    console.error(err);
    setConnection("CONFIG ERROR");
  }
}
async function toggleLogin() {
  if (!auth) return showToast("Firebase is not ready yet.");
  if (auth.currentUser) {
    await signOut(auth);
    showToast("Logged out. This device is now in viewer mode.");
    return;
  }
  const email = prompt("Enter scorer email:");
  if (!email) return;
  const password = prompt("Enter scorer password:");
  if (!password) return;
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  } catch (err) {
    console.error(err);
    showToast("Login failed. Check your scorer email and password.");
  }
}
authBtn.addEventListener("click", toggleLogin);

/* ---------- scoring ---------- */
function snapshot() {
  snapshots.push(JSON.parse(JSON.stringify(state)));
  if (snapshots.length > 60) snapshots.shift();
}
function addPoint(side) {
  if (!isScorer) return showToast("Only the scorer can update the match.");
  if (state.matchOver) return showToast("Match is over. Tap NEW MATCH to play again.");
  snapshot();
  const other = otherSide(side);
  const gameNo = state.games.length + 1;
  const wasServing = state.server === side;
  state.notice = "";
  state.score[side] += 1;
  if (wasServing) {
    if (state.type === "doubles") state.right[side] = 1 - state.right[side]; // server swaps court with partner
  } else {
    state.server = side; // receiving side won the rally, so it gains the serve
  }
  const s = state.score[side], o = state.score[other];
  const scoreText = `${state.score.a}–${state.score.b}`;
  let text = `${sideName(side)} won the rally`;

  if (wonGame(s, o)) {
    state.games.push({ a: state.score.a, b: state.score.b });
    state.gamesWon[side] += 1;
    const need = Math.ceil(state.bestOf / 2);
    text = `${sideName(side)} won game ${gameNo}`;
    if (state.gamesWon[side] >= need) {
      state.matchOver = side;
      showToast(`${sideName(side)} win the match!`);
    } else {
      state.notice = `GAME ${gameNo} TO ${sideName(side)} · ${s}–${o} · CHANGE ENDS`;
      state.score = { a: 0, b: 0 };
      state.server = side;           // winner of the game serves first in the next one
      state.right = { a: 0, b: 0 };
      state.intervalDone = false;
      showToast(`Game ${gameNo} · ${sideName(side)}`);
    }
  } else {
    if (state.points === 21 && s === 11 && !state.intervalDone) {
      state.intervalDone = true;
      const decider = state.gamesWon.a === Math.ceil(state.bestOf / 2) - 1 && state.gamesWon.b === Math.ceil(state.bestOf / 2) - 1;
      state.notice = `INTERVAL · 60 SECONDS${decider && state.bestOf > 1 ? " · CHANGE ENDS" : ""}`;
    }
    showToast(`${sideName(side)} · ${s}`);
  }
  state.history.unshift({ game: gameNo, side, score: scoreText, text });
  state.history = state.history.slice(0, 40);
  render();
  saveCloud();
}
function undo() {
  if (!isScorer) return showToast("Only the scorer can undo.");
  const previous = snapshots.pop();
  if (!previous) return showToast("Nothing to undo yet.");
  state = previous;
  render(); saveCloud(); showToast("Last point undone.");
}
function newMatch() {
  if (!isScorer) return showToast("Only the scorer can start a new match.");
  if ((started() || state.matchOver) && !confirm("Start a new match? This clears the score for everyone watching.")) return;
  state = freshState(state);
  snapshots = [];
  render(); saveCloud(); showToast("New match ready.");
}

/* ---------- render ---------- */
function render() {
  const doubles = state.type === "doubles";
  const sidesEl = document.querySelector(".sides");
  sidesEl.classList.toggle("doubles", doubles);
  sidesEl.classList.toggle("singles", !doubles);
  sidesEl.classList.toggle("serving-a", state.server === "a" && !state.matchOver);
  sidesEl.classList.toggle("serving-b", state.server === "b" && !state.matchOver);
  document.body.classList.toggle("singles-mode", !doubles);

  if (document.activeElement !== $("matchType")) $("matchType").value = state.type;
  if (document.activeElement !== $("pointsSel")) $("pointsSel").value = String(state.points);
  if (document.activeElement !== $("bestOfSel")) $("bestOfSel").value = String(state.bestOf);

  ["a", "b"].forEach(s => {
    [0, 1].forEach(i => {
      const input = $(`p${s}${i}`);
      if (document.activeElement !== input) input.value = state.players[s][i] || "";
    });
    $(`score${s.toUpperCase()}`).textContent = state.score[s];
    const need = Math.ceil(state.bestOf / 2);
    const pips = $(`pips${s.toUpperCase()}`);
    pips.innerHTML = "";
    for (let i = 0; i < need; i++) {
      const dot = document.createElement("span");
      if (i < state.gamesWon[s]) dot.className = "won";
      pips.appendChild(dot);
    }
    $(`point${s.toUpperCase()}`).querySelector(".pb-name").textContent = sideName(s);
  });

  const info = serverInfo();
  ["a", "b"].forEach(s => {
    const badge = $(`serve${s.toUpperCase()}`);
    if (state.matchOver) {
      badge.textContent = state.matchOver === s ? "★ WINNER" : "";
      badge.className = "serve-badge" + (state.matchOver === s ? " serving" : "");
    } else if (info.side === s) {
      badge.textContent = doubles ? `● ${info.name} SERVES · ${info.court} COURT` : `● SERVING · ${info.court} COURT`;
      badge.className = "serve-badge serving";
    } else {
      badge.textContent = "○ RECEIVING";
      badge.className = "serve-badge";
    }
  });

  $("gameLabel").textContent = state.matchOver ? "FINAL" : `GAME ${state.games.length + 1}`;
  $("gwA").textContent = state.gamesWon.a;
  $("gwB").textContent = state.gamesWon.b;
  $("gamesList").innerHTML = state.games.length
    ? state.games.map((g, i) => `<span class="game-chip-result ${g.a > g.b ? "a" : "b"}">G${i + 1} · ${g.a}–${g.b}</span>`).join("")
    : '<span class="empty-game">—</span>';

  // banner: match result, then notices, then game/match point
  let msg = "";
  if (state.matchOver) {
    msg = `MATCH WON BY ${sideName(state.matchOver)} · ${state.gamesWon.a}–${state.gamesWon.b} IN GAMES`;
  } else if (state.notice) {
    msg = state.notice;
  } else {
    const need = Math.ceil(state.bestOf / 2);
    const parts = [];
    ["a", "b"].forEach(s => {
      if (wouldWin(state.score[s], state.score[otherSide(s)])) {
        parts.push(`${state.gamesWon[s] + 1 >= need ? "MATCH POINT" : "GAME POINT"} · ${sideName(s)}`);
      }
    });
    msg = parts.join("   |   ");
  }
  $("statusBanner").textContent = msg;
  $("statusBanner").hidden = !msg;

  $("formatText").textContent = `${doubles ? "DOUBLES" : "SINGLES"} · BEST OF ${state.bestOf}`;
  $("servingText").textContent = state.matchOver ? "—" : (doubles ? `${info.name} (${sideName(info.side)})` : info.name);
  $("courtText").textContent = state.matchOver ? "MATCH COMPLETE" : `${info.court} COURT · SCORE ${state.score[info.side]}`;
  $("ruleText").textContent = `${state.points} POINTS · MAX ${CAPS[state.points]}`;

  $("history").innerHTML = state.history.length
    ? state.history.slice(0, 20).map(h =>
        `<div class="history-item"><span class="history-over">G${esc(h.game)}</span><span class="history-result ${h.side === "b" ? "b" : "a"}">${esc(h.score)}</span><span class="history-description">${esc(h.text)}</span></div>`
      ).join("")
    : '<div class="history-empty">No points yet. Start scoring to see the rally feed.</div>';

  document.querySelectorAll("[data-point]").forEach(b => {
    b.disabled = !isScorer || !!state.matchOver;
    b.style.opacity = b.disabled ? ".62" : "1";
    b.style.cursor = b.disabled ? "not-allowed" : "pointer";
  });
  $("undoBtn").disabled = !isScorer || !snapshots.length;
}

/* ---------- events ---------- */
document.querySelectorAll("[data-point]").forEach(button => {
  button.addEventListener("click", () => addPoint(button.dataset.point));
});
$("undoBtn").addEventListener("click", undo);
$("newMatchBtn").addEventListener("click", newMatch);
$("serveBtn").addEventListener("click", () => {
  if (!isScorer) return showToast("Only the scorer can change the serve.");
  if (state.matchOver) return;
  state.server = otherSide(state.server);
  state.notice = "";
  render(); saveCloud();
  showToast(`Serve: ${sideName(state.server)}`);
});
$("courtBtn").addEventListener("click", () => {
  if (!isScorer) return showToast("Only the scorer can change courts.");
  if (state.type !== "doubles" || state.matchOver) return;
  state.right[state.server] = 1 - state.right[state.server];
  render(); saveCloud();
  showToast("Server court swapped.");
});
[["matchType", "type"], ["pointsSel", "points"], ["bestOfSel", "bestOf"]].forEach(([id, key]) => {
  $(id).addEventListener("change", event => {
    if (!isScorer) return;
    if (started() || state.matchOver) {
      showToast("Tap NEW MATCH first, then change the format.");
      render();
      return;
    }
    state[key] = key === "type" ? event.target.value : Number(event.target.value);
    render(); saveCloud();
  });
});
["a", "b"].forEach(s => {
  [0, 1].forEach(i => {
    $(`p${s}${i}`).addEventListener("input", event => {
      event.target.value = event.target.value.toUpperCase();
      state.players[s][i] = event.target.value;
      $(`point${s.toUpperCase()}`).querySelector(".pb-name").textContent = sideName(s);
      queueSave();
    });
  });
});

render();
updateAccess();
startFirebase();
