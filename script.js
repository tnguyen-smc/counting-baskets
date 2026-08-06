const { useState, useEffect, useMemo, useRef } = React;

/* ============================ FIREBASE CONFIGURATION ============================ */
// TODO: replace with your Firebase project's web app config.
// 1. Create a project at https://console.firebase.google.com
// 2. Enable "Cloud Firestore" (Build > Firestore Database)
// 3. Enable "Authentication" > Sign-in method > Email/Password
// 4. Add at least one admin user under Authentication > Users
// 5. Copy the config object from Project Settings > General > Your apps > SDK setup
const firebaseConfig = {
  apiKey: "AIzaSyDG_8ye42ss0VT1WgS4HjVjJxk_9t1Om_0",
  authDomain: "counting-loaves.firebaseapp.com",
  projectId: "counting-loaves",
  storageBucket: "counting-loaves.firebasestorage.app",
  messagingSenderId: "634372628765",
  appId: "1:634372628765:web:4c6c9266c19cc3e126c1f4"
};

/*
  Suggested Firestore security rules (Firebase Console > Firestore > Rules):

  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /classrooms/{id} { allow read: if true; allow write: if request.auth != null; }
      match /students/{id}   { allow read: if true; allow write: if request.auth != null; }
      match /settings/{id}   { allow read: if true; allow write: if request.auth != null; }
      match /logs/{id}       { allow read: if true; allow write: if true; }
    }
  }

  This lets any teacher device read/write daily counts without signing in, while
  classroom rosters, student rosters, and term settings can only be changed by an
  authenticated admin. Consider tightening further (e.g. Firebase App Check, or
  requiring auth on log writes too) before using this in production.

  NOTE ON CONCURRENCY: every daily log document is keyed deterministically as
  "YYYY-MM-DD__classroomId" (see logId() below) and every read uses a live
  onSnapshot listener, so two teachers (or a teacher and an admin) working at the
  same time always see each other's updates immediately and never collide on a
  document ID.
*/

const FIREBASE_NOT_CONFIGURED = firebaseConfig.apiKey === 'YOUR_API_KEY';

let db = null;
let auth = null;
if (!FIREBASE_NOT_CONFIGURED) {
  firebase.initializeApp(firebaseConfig);
  db = firebase.firestore();
  auth = firebase.auth();
}

/* ============================ CONSTANTS ============================ */
const DAILY_PASSWORD = 'countingloaves';
const DEVICE_AUTH_STORAGE_KEY = 'countingloaves_device_auth_date';
const TERM_KEYS = ['S1','S2','Q1','Q2','Q3','Q4'];
const TERM_LABELS = { Q1: 'Quarter 1', Q2: 'Quarter 2', Q3: 'Quarter 3', Q4: 'Quarter 4', S1: 'Semester 1', S2: 'Semester 2' };

/* ============================ HELPERS ============================ */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function toDateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayStr() { return toDateStr(new Date()); }
function parseDateStr(s) { const parts = s.split('-').map(Number); return new Date(parts[0], parts[1] - 1, parts[2]); }
function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd; }
function formatDisplayDate(dateStr) {
  const d = parseDateStr(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
function formatShortDate(dateStr) {
  const d = parseDateStr(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2,9); }
function classroomLabel(cls) { return cls ? (cls.grade + ' — ' + cls.teacher) : 'Unknown Classroom'; }
function logId(dateStr, classroomId) { return dateStr + '__' + classroomId; }
function studentName(s) { return s ? (s.firstName + ' ' + s.lastName) : ''; }
function studentNumberOf(s) { return (s && s.number != null) ? s.number : 0; }
function sortStudents(list, sortBy) {
  const arr = (list || []).slice();
  if (sortBy === 'first') arr.sort((a,b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName));
  else if (sortBy === 'last') arr.sort((a,b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  else arr.sort((a,b) => studentNumberOf(a) - studentNumberOf(b));
  return arr;
}
function defaultEntry() { return { absent: false, meal: 'hot', milk: 'yes' }; }
function emptyEntries(roster) {
  const e = {};
  roster.forEach(s => { e[s.id] = defaultEntry(); });
  return e;
}
function tallyEntries(entries, roster) {
  let hot = 0, sack = 0, absent = 0, milk = 0;
  roster.forEach(s => {
    const e = (entries && entries[s.id]) || defaultEntry();
    if (e.absent) { absent++; return; }
    if (e.meal === 'hot') hot++; else if (e.meal === 'sack') sack++;
    if (e.milk === 'yes') milk++;
  });
  return { hot, sack, absent, milk, total: roster.length };
}
function entryChanged(preE, finalE) {
  const a = preE || defaultEntry(), b = finalE || defaultEntry();
  return a.absent !== b.absent || a.meal !== b.meal || a.milk !== b.milk;
}
function entryStatusLabel(e) {
  if (e.absent) return 'Absent';
  return e.meal === 'hot' ? 'Hot Lunch' : 'Sack Lunch';
}
function entryMilkLabel(e) {
  if (e.absent) return '—';
  return e.milk === 'yes' ? 'Yes' : 'No';
}
function getWeekRange(dateStr) {
  const d = parseDateStr(dateStr);
  const day = d.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = addDays(d, diffToMonday);
  const friday = addDays(monday, 4);
  return { start: monday, end: friday };
}
function getMonthRange(monthStr) {
  const parts = monthStr.split('-').map(Number);
  const y = parts[0], m = parts[1];
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 0) };
}
function getTermRange(settings, key) {
  const t = settings && settings.terms && settings.terms[key];
  if (!t || !t.start) return null;
  return { start: parseDateStr(t.start), end: t.end ? parseDateStr(t.end) : parseDateStr(todayStr()) };
}
function getSchoolYearRange(settings) {
  const terms = (settings && settings.terms) || {};
  let minStart = null, maxEnd = null;
  Object.keys(terms).forEach(k => {
    const t = terms[k];
    if (t && t.start) { const s = parseDateStr(t.start); if (!minStart || s < minStart) minStart = s; }
    if (t && t.end) { const e = parseDateStr(t.end); if (!maxEnd || e > maxEnd) maxEnd = e; }
  });
  if (!minStart) return null;
  return { start: minStart, end: maxEnd || parseDateStr(todayStr()) };
}
function getStartOfYearToNow(settings) {
  const terms = (settings && settings.terms) || {};
  let minStart = null;
  Object.keys(terms).forEach(k => {
    const t = terms[k];
    if (t && t.start) { const s = parseDateStr(t.start); if (!minStart || s < minStart) minStart = s; }
  });
  if (!minStart) return null;
  return { start: minStart, end: parseDateStr(todayStr()) };
}

/* ============================ FIRESTORE ACCESS ============================ */
function useCollection(name) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const unsub = db.collection(name).onSnapshot(
      snap => { setItems(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false); },
      err => { console.error('Firestore read error (' + name + '):', err); setLoading(false); }
    );
    return () => unsub();
    // eslint-disable-next-line
  }, [name]);
  return { items, loading };
}

function useSettingsDoc() {
  const [settings, setSettings] = useState({ terms: {} });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const unsub = db.collection('settings').doc('config').onSnapshot(
      doc => { setSettings(doc.exists ? { terms: {}, ...doc.data() } : { terms: {} }); setLoading(false); },
      err => { console.error('Firestore settings read error:', err); setLoading(false); }
    );
    return () => unsub();
  }, []);
  return { settings, loading };
}

function useLogs() {
  const { items, loading } = useCollection('logs');
  const logsById = useMemo(() => {
    const map = {};
    items.forEach(l => { map[l.id] = l; });
    return map;
  }, [items]);
  return { logs: items, logsById, loading };
}

async function saveClassroom(cls) {
  const id = cls.id || uid('c');
  await db.collection('classrooms').doc(id).set({ grade: cls.grade, teacher: cls.teacher });
  return id;
}
async function deleteClassroomDoc(id) { await db.collection('classrooms').doc(id).delete(); }

async function saveStudent(s) {
  const id = s.id || uid('s');
  await db.collection('students').doc(id).set({ number: s.number, firstName: s.firstName, lastName: s.lastName, classroomId: s.classroomId });
  return id;
}
async function deleteStudentDoc(id) { await db.collection('students').doc(id).delete(); }

async function saveSettings(patch) {
  await db.collection('settings').doc('config').set(patch, { merge: true });
}

// Logs are always written as a full document (rather than partial merges) since the
// UI already holds the latest synced copy locally; last write wins, which is fine for
// this app's scale (a handful of teachers editing their own classroom's counts).
async function saveLogFull(dateStr, classroomId, obj) {
  const id = logId(dateStr, classroomId);
  const payload = {
    date: dateStr,
    classroomId,
    pre: obj.pre || { entries: {}, submitted: false, submittedAt: null },
    final: obj.final || { entries: {}, submitted: false, submittedAt: null },
    verified: obj.verified || false,
    verifiedAt: obj.verifiedAt || null
  };
  await db.collection('logs').doc(id).set(payload);
}

/* ============================ AGGREGATION (ANALYTICS + EXPORT) ============================ */
function aggregateRange(data, startDate, endDate) {
  const result = {};
  data.classrooms.forEach(c => { result[c.id] = { hot: 0, sack: 0, absent: 0, milk: 0 }; });
  data.logs.forEach(log => {
    const d = parseDateStr(log.date);
    if (d < startDate || d > endDate) return;
    if (!result[log.classroomId]) return;
    if (!log.final || !log.final.submitted) return;
    const roster = data.students.filter(s => s.classroomId === log.classroomId);
    const t = tallyEntries(log.final.entries, roster);
    result[log.classroomId].hot += t.hot;
    result[log.classroomId].sack += t.sack;
    result[log.classroomId].absent += t.absent;
    result[log.classroomId].milk += t.milk;
  });
  return result;
}
function aggregateRangeByStudent(data, startDate, endDate) {
  const result = {};
  data.students.forEach(s => { result[s.id] = { hot: 0, sack: 0, absent: 0, milk: 0 }; });
  data.logs.forEach(log => {
    const d = parseDateStr(log.date);
    if (d < startDate || d > endDate) return;
    if (!log.final || !log.final.submitted) return;
    const roster = data.students.filter(s => s.classroomId === log.classroomId);
    roster.forEach(s => {
      if (!result[s.id]) return;
      const e = (log.final.entries && log.final.entries[s.id]) || defaultEntry();
      if (e.absent) { result[s.id].absent++; return; }
      if (e.meal === 'hot') result[s.id].hot++; else result[s.id].sack++;
      if (e.milk === 'yes') result[s.id].milk++;
    });
  });
  return result;
}

/* ============================ EXPORT (EXCEL / CSV) ============================ */
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function rowsToCSV(rows) { return rows.map(r => r.map(csvEscape).join(',')).join('\r\n'); }
function downloadCSV(filename, rows) {
  const csv = rowsToCSV(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function downloadXLSX(filename, rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Lunch Count Export');
  XLSX.writeFile(wb, filename);
}

function buildRangeExportRows(data, startDate, endDate, rangeLabel) {
  const rows = [];
  rows.push(['Lunch Count Export']);
  rows.push(['Range', rangeLabel]);
  rows.push(['Generated', formatDisplayDate(todayStr())]);
  rows.push([]);
  rows.push(['Classroom Summary (Final Counts Only)']);
  rows.push(['Classroom', 'Grade', 'Teacher', 'Hot Lunch', 'Sack Lunch', 'Absent', 'Milk', 'Total Students']);

  const agg = aggregateRange(data, startDate, endDate);
  const grand = { hot: 0, sack: 0, absent: 0, milk: 0, total: 0 };

  data.classrooms.forEach(cls => {
    const roster = data.students.filter(s => s.classroomId === cls.id);
    const v = agg[cls.id] || { hot: 0, sack: 0, absent: 0, milk: 0 };
    rows.push([classroomLabel(cls), cls.grade, cls.teacher, v.hot, v.sack, v.absent, v.milk, roster.length]);
    grand.hot += v.hot; grand.sack += v.sack; grand.absent += v.absent; grand.milk += v.milk;
    grand.total += roster.length;
  });
  rows.push(['GRAND TOTAL', '', '', grand.hot, grand.sack, grand.absent, grand.milk, grand.total]);

  rows.push([]);
  rows.push(['Student-Level Detail (Final Counts Only)']);
  rows.push(['Classroom', 'Grade', 'Teacher', 'Student #', 'First Name', 'Last Name', 'Hot Lunch', 'Sack Lunch', 'Absent Days', 'Milk']);

  const studentAgg = aggregateRangeByStudent(data, startDate, endDate);
  data.classrooms.forEach(cls => {
    const roster = sortStudents(data.students.filter(s => s.classroomId === cls.id), 'number');
    roster.forEach(s => {
      const v = studentAgg[s.id] || { hot: 0, sack: 0, absent: 0, milk: 0 };
      rows.push([classroomLabel(cls), cls.grade, cls.teacher, s.number, s.firstName, s.lastName, v.hot, v.sack, v.absent, v.milk]);
    });
  });

  return rows;
}

/* ============================ SMALL UI PRIMITIVES ============================ */
function Badge({ status }) {
  const styles = {
    'Completed': 'bg-green-100 text-green-800 border border-green-300',
    'In Progress': 'bg-amber-100 text-amber-800 border border-amber-300',
    'Not Started': 'bg-gray-100 text-gray-600 border border-gray-300',
    'Verified': 'bg-purple-100 text-purple-800 border border-purple-300'
  };
  return (
    <span className={"px-3 py-1 rounded-full text-xs font-semibold " + styles[status]}>{status}</span>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="bg-white rounded-2xl card-shadow p-4 text-center border border-primary-100">
      <p className="text-3xl font-bold text-primary">{value}</p>
      <p className="text-xs font-medium text-primary-500 uppercase mt-1">{label}</p>
    </div>
  );
}

function FloatingSummary({ totals }) {
  return (
    <div className="hidden lg:flex flex-col gap-2 fixed left-4 top-28 z-30 bg-white rounded-2xl card-shadow-lg border border-primary-100 p-4 w-36">
      <p className="font-bold text-primary-900 text-sm leading-tight">Hot: {totals.hot}</p>
      <p className="font-bold text-primary-900 text-sm leading-tight">Sack: {totals.sack}</p>
      <p className="font-bold text-primary-900 text-sm leading-tight">Absent: {totals.absent}</p>
      <p className="font-bold text-primary-900 text-sm leading-tight">Milk: {totals.milk}</p>
    </div>
  );
}

function PrimaryButton({ children, onClick, className, disabled, type }) {
  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      disabled={disabled}
      className={"btn-touch px-5 py-3 rounded-xl bg-primary text-white font-semibold text-base transition-fast hover:bg-primary-700 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed " + (className || '')}
    >
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, className, type }) {
  return (
    <button
      type={type || 'button'}
      onClick={onClick}
      className={"btn-touch px-5 py-3 rounded-xl bg-white text-primary font-semibold text-base border-2 border-primary-200 transition-fast hover:bg-primary-50 active:scale-[0.98] " + (className || '')}
    >
      {children}
    </button>
  );
}

function SuccessModal({ title, message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2800);
    return () => clearTimeout(t);
    // eslint-disable-next-line
  }, []);
  return (
    <div className="fixed inset-0 bg-primary-900/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl card-shadow-lg p-8 w-full max-w-sm text-center border-4 border-green-500">
        <div className="w-16 h-16 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-3xl mx-auto mb-4">✓</div>
        <h2 className="text-xl font-bold text-green-700 mb-2">{title}</h2>
        <p className="text-sm font-light text-primary-600 mb-6">{message}</p>
        <button
          onClick={onDone}
          className="btn-touch w-full px-5 py-3 rounded-xl bg-green-600 text-white font-semibold text-base transition-fast hover:bg-green-700 active:scale-[0.98]"
        >
          Back to Home
        </button>
      </div>
    </div>
  );
}

/* ============================ DAILY DEVICE PASSWORD GATE ============================ */
function DailyPasswordGate({ children }) {
  const [authed, setAuthed] = useState(() => {
    try { return localStorage.getItem(DEVICE_AUTH_STORAGE_KEY) === todayStr(); } catch (e) { return false; }
  });
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');

  function submit(e) {
    e.preventDefault();
    if (pw === DAILY_PASSWORD) {
      try { localStorage.setItem(DEVICE_AUTH_STORAGE_KEY, todayStr()); } catch (e) {}
      setAuthed(true);
      setError('');
    } else {
      setError('Incorrect password. Please try again.');
      setPw('');
    }
  }

  if (authed) return children;

  return (
    <div className="fixed inset-0 bg-primary-900 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-2xl card-shadow-lg p-8 w-full max-w-sm text-center">
        <div className="text-4xl mb-3">🍞</div>
        <h2 className="text-xl font-bold text-primary-900 mb-1">Counting Loaves</h2>
        <p className="text-sm font-light text-primary-600 mb-6">Enter today's access password to continue. This is only needed once per device, per day.</p>
        <form onSubmit={submit}>
          <input
            autoFocus
            type="password"
            value={pw}
            onChange={e => { setPw(e.target.value); setError(''); }}
            placeholder="Access password"
            className="w-full border-2 border-primary-200 rounded-xl px-4 py-3 mb-3 text-center focus:outline-none focus:border-primary"
          />
          {error && <p className="text-sm text-rose-600 mb-3">{error}</p>}
          <PrimaryButton type="submit" className="w-full">Unlock for Today</PrimaryButton>
        </form>
      </div>
    </div>
  );
}

/* ============================ LOGIN MODAL (FIREBASE AUTH) ============================ */
function AdminLoginModal({ onClose, onSuccess }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await auth.signInWithEmailAndPassword(email.trim(), pw);
      onSuccess();
    } catch (err) {
      setError((err && err.message) ? err.message : 'Sign-in failed. Check your email and password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-primary-900/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl card-shadow-lg p-6 w-full max-w-sm">
        <h2 className="text-xl font-bold text-primary-900 mb-1">Admin Access</h2>
        <p className="text-sm font-light text-primary-700 mb-4">Sign in with your administrator account to continue.</p>
        <form onSubmit={submit}>
          <input
            autoFocus
            type="email"
            value={email}
            onChange={e => { setEmail(e.target.value); setError(''); }}
            placeholder="Email"
            className="w-full border-2 border-primary-200 rounded-xl px-4 py-3 mb-2 focus:outline-none focus:border-primary"
          />
          <input
            type="password"
            value={pw}
            onChange={e => { setPw(e.target.value); setError(''); }}
            placeholder="Password"
            className="w-full border-2 border-primary-200 rounded-xl px-4 py-3 mb-2 focus:outline-none focus:border-primary"
          />
          {error && <p className="text-sm text-rose-600 mb-2">{error}</p>}
          <div className="flex gap-2 mt-2">
            <GhostButton onClick={onClose} className="flex-1">Cancel</GhostButton>
            <PrimaryButton type="submit" disabled={busy} className="flex-1">{busy ? 'Signing In…' : 'Log In'}</PrimaryButton>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ============================ NAV BAR ============================ */
function NavBar({ role, onRequestRole }) {
  return (
    <div className="bg-primary text-white sticky top-0 z-40 card-shadow">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <img
            src="logo-school.png"
            alt="St. Mary Catholic School Logo"
            className="h-10 w-auto"
          />
          <div>
            <h1 className="text-lg sm:text-xl font-bold leading-tight tracking-wide">St. Mary Catholic School</h1>
            <p className="text-xs sm:text-sm font-light text-primary-100">Counting Loaves · Lunch Counter App</p>
          </div>
        </div>
        <div className="flex bg-primary-700 rounded-xl p-1 gap-1">
          <button
            onClick={() => onRequestRole('teacher')}
            className={"btn-touch px-4 py-2 rounded-lg font-semibold text-sm transition-fast " + (role === 'teacher' ? 'bg-white text-primary' : 'text-white hover:bg-primary-600')}
          >
            Teacher View
          </button>
          <button
            onClick={() => onRequestRole('admin')}
            className={"btn-touch px-4 py-2 rounded-lg font-semibold text-sm transition-fast " + (role === 'admin' ? 'bg-white text-primary' : 'text-white hover:bg-primary-600')}
          >
            Admin View
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================ TEACHER: OVERVIEW ============================ */
function TeacherOverview({ data, onOpenClassroom }) {
  const today = todayStr();

  if (data.classrooms.length === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-16 text-center">
        <h2 className="text-2xl font-bold text-primary-900 mb-2">No classrooms yet</h2>
        <p className="text-primary-600 font-light">Ask your administrator to add classrooms under Admin View &rarr; Classrooms.</p>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-primary-900">Today is {formatDisplayDate(today)}</h2>
        <p className="text-primary-600 font-light">Select a classroom to take the morning pre-count or lunchtime final count.</p>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {data.classrooms.map(cls => {
          const roster = data.students.filter(s => s.classroomId === cls.id);
          const log = data.logsById[logId(today, cls.id)];
          const preStatus = (log && log.pre && log.pre.submitted) ? 'Completed' : (log && log.pre ? 'In Progress' : 'Not Started');
          const finalStatus = (log && log.final && log.final.submitted) ? 'Completed' : (log && log.final ? 'In Progress' : 'Not Started');
          const verified = !!(log && log.verified);
          return (
            <button
              key={cls.id}
              onClick={() => onOpenClassroom(cls.id)}
              className="text-left bg-white rounded-2xl card-shadow hover:card-shadow-lg transition-fast p-6 border border-primary-100 hover:border-primary-300 btn-touch"
            >
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="text-xl font-bold text-primary-900">{cls.grade}</h3>
                  <p className="text-sm font-medium text-primary-500">{cls.teacher}</p>
                </div>
                {verified && <Badge status="Verified" />}
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-primary-400 uppercase w-24">Pre-Count</span>
                <Badge status={preStatus} />
              </div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-medium text-primary-400 uppercase w-24">Final Count</span>
                <Badge status={finalStatus} />
              </div>
              <p className="text-sm font-light text-primary-600">{roster.length} students</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ STUDENT ENTRY CARD ============================ */
function StudentEntryCard({ student, entry, onChange, disabled }) {
  const e = entry || defaultEntry();
  function set(patch) { if (!disabled) onChange({ ...e, ...patch }); }
  function setMeal(meal) { set({ meal, milk: meal === 'hot' ? 'yes' : 'no' }); }

  return (
    <div className={"rounded-2xl card-shadow p-4 border flex flex-col gap-3 transition-fast " + (e.absent ? 'bg-gray-100 border-gray-300' : 'bg-white border-primary-100')}>
      <div className="flex items-start justify-between gap-2">
        <p className={"font-semibold text-primary-900 truncate " + (e.absent ? 'opacity-60' : '')}>
          <span className="text-primary-400 font-medium">#{student.number}</span> {student.firstName} {student.lastName}
        </p>
        <button
          type="button"
          disabled={disabled}
          onClick={() => set({ absent: !e.absent })}
          className={"shrink-0 text-xs font-bold px-2.5 py-1.5 rounded-full transition-fast cursor-pointer " + (e.absent ? 'bg-rose-600 text-white' : 'bg-rose-50 text-rose-600 hover:bg-rose-100')}
        >
          {e.absent ? 'Undo Absent' : 'Mark Absent'}
        </button>
      </div>

      <div className={e.absent ? 'opacity-40 pointer-events-none select-none' : ''}>
        <p className="text-xs font-medium text-primary-500 mb-1 uppercase tracking-wide">Meal</p>
        <div className="flex gap-2 mb-3">
          <button
            type="button"
            disabled={disabled}
            onClick={() => setMeal('hot')}
            className={"flex-1 btn-touch rounded-xl font-semibold text-sm transition-fast border-2 " + (e.meal === 'hot' ? 'bg-primary text-white border-primary' : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100')}
          >
            Hot Lunch
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setMeal('sack')}
            className={"flex-1 btn-touch rounded-xl font-semibold text-sm transition-fast border-2 " + (e.meal === 'sack' ? 'bg-gray-200 text-blue-700 border-gray-300' : 'bg-gray-50 text-gray-400 border-gray-200 hover:bg-gray-100')}
          >
            Sack Lunch
          </button>
        </div>
        <p className="text-xs font-medium text-primary-500 mb-1 uppercase tracking-wide">Milk Choice</p>
        <div className="flex gap-2">
          {[['yes','Yes'],['no','No']].map(([val,label]) => (
            <button
              type="button"
              key={val}
              disabled={disabled}
              onClick={() => set({ milk: val })}
              className={"flex-1 btn-touch rounded-xl font-semibold text-xs transition-fast border-2 " + (e.milk === val ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================ TEACHER: 3-COLUMN REVIEW SCREEN ============================ */
function ReviewStatusControl({ entry, onChange }) {
  const options = [['hot','Hot Lunch'], ['sack','Sack Lunch'], ['absent','Absent']];
  const current = entry.absent ? 'absent' : entry.meal;
  return (
    <select
      value={current}
      onChange={e => {
        const v = e.target.value;
        if (v === 'absent') onChange({ ...entry, absent: true });
        else onChange({ ...entry, absent: false, meal: v, milk: v === 'hot' ? 'yes' : 'no' });
      }}
      className="text-xs font-semibold border-2 border-primary-200 rounded-lg px-2 py-1 bg-white"
    >
      {options.map(([val,label]) => <option key={val} value={val}>{label}</option>)}
    </select>
  );
}

function ReviewStudentCard({ student, entry, onChange }) {
  return (
    <div className="bg-white rounded-xl card-shadow border border-primary-100 p-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="font-medium text-primary-900 truncate text-sm"><span className="text-primary-400">#{student.number}</span> {student.firstName} {student.lastName}</p>
        {!entry.absent && (
          <div className="flex gap-1 mt-1">
            {[['yes','Milk: Yes'],['no','Milk: No']].map(([val,label]) => (
              <button
                key={val}
                type="button"
                onClick={() => onChange({ ...entry, milk: val })}
                className={"px-2 py-0.5 rounded-full text-[11px] font-semibold border transition-fast " + (entry.milk === val ? 'bg-primary text-white border-primary' : 'bg-white text-primary-600 border-primary-200 hover:bg-primary-50')}
              >{label}</button>
            ))}
          </div>
        )}
      </div>
      <ReviewStatusControl entry={entry} onChange={onChange} />
    </div>
  );
}

function ReviewScreen({ stage, cls, roster, entries, onChangeEntry, onEdit, onSubmit }) {
  const totals = tallyEntries(entries, roster);
  const hotStudents = [], sackStudents = [], absentStudents = [];
  roster.forEach(s => {
    const e = entries[s.id] || defaultEntry();
    if (e.absent) absentStudents.push(s);
    else if (e.meal === 'hot') hotStudents.push(s);
    else sackStudents.push(s);
  });

  const title = stage === 'pre' ? 'Review Morning Pre-Count' : 'Review Lunch Time Count';
  const submitLabel = stage === 'pre' ? 'Submit Pre Count' : 'Submit Final Count';

  const columns = [
    { key: 'hot', label: 'Hot Lunch', students: hotStudents, color: 'border-green-300 bg-green-50' },
    { key: 'sack', label: 'Sack Lunch', students: sackStudents, color: 'border-amber-300 bg-amber-50' },
    { key: 'absent', label: 'Absent', students: absentStudents, color: 'border-gray-300 bg-gray-50' }
  ];

  return (
    <div>
      <FloatingSummary totals={totals} />
      <button onClick={onEdit} className="text-primary font-semibold text-sm mb-4 hover:underline">&larr; Edit / Go Back</button>
      <h2 className="text-2xl font-bold text-primary-900 mb-1">{title}</h2>
      <p className="text-primary-600 font-light mb-6">{cls.grade} &middot; {cls.teacher} &middot; {formatDisplayDate(todayStr())}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Hot Lunch" value={totals.hot} />
        <StatCard label="Sack Lunch" value={totals.sack} />
        <StatCard label="Absent" value={totals.absent} />
        <StatCard label="Milk" value={totals.milk} />
      </div>

      <div className="grid md:grid-cols-3 gap-4 mb-6">
        {columns.map(col => (
          <div key={col.key} className={"rounded-2xl border-2 p-3 " + col.color}>
            <div className="flex justify-between items-center mb-3 px-1">
              <h3 className="font-bold text-primary-900 text-sm uppercase tracking-wide">{col.label}</h3>
              <span className="text-sm font-bold text-primary-900 bg-white rounded-full px-2.5 py-0.5 border border-primary-100">{col.students.length}</span>
            </div>
            <div className="flex flex-col gap-2 min-h-[60px]">
              {col.students.length === 0 && <p className="text-xs font-light text-primary-400 text-center py-4">No students</p>}
              {col.students.map(s => (
                <ReviewStudentCard
                  key={s.id}
                  student={s}
                  entry={entries[s.id] || defaultEntry()}
                  onChange={(entry) => onChangeEntry(s.id, entry)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 bg-secondary/95 backdrop-blur pt-4 pb-2 border-t border-primary-100">
        <div className="flex justify-between items-center flex-wrap gap-3">
          <p className="text-sm text-primary-600 font-light lg:hidden">
            Hot {totals.hot} &middot; Sack {totals.sack} &middot; Absent {totals.absent} &middot; Milk {totals.milk}
          </p>
          <div className="flex gap-3 ml-auto">
            <GhostButton onClick={onEdit}>Edit / Go Back</GhostButton>
            <PrimaryButton onClick={onSubmit}>{submitLabel}</PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================ TEACHER: CLASSROOM ENTRY MODAL ============================ */
function ClassroomEntryModal({ cls, preSubmitted, finalSubmitted, onSelectPre, onSelectFinal, onClose }) {
  const [lockedError, setLockedError] = useState(false);

  function handleFinalClick() {
    if (!preSubmitted) { setLockedError(true); return; }
    onSelectFinal();
  }

  return (
    <div className="fixed inset-0 bg-primary-900/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl card-shadow-lg p-6 w-full max-w-sm">
        <div className="flex justify-between items-start gap-3 mb-1">
          <div>
            <h2 className="text-xl font-bold text-primary-900">{cls.grade}</h2>
            <p className="text-sm font-light text-primary-600">{cls.teacher}</p>
          </div>
          <button onClick={onClose} className="text-primary-400 hover:text-primary-700 text-2xl leading-none">&times;</button>
        </div>
        <p className="text-sm font-light text-primary-600 mb-5 mt-2">Choose which count you'd like to take.</p>

        <div className="flex flex-col gap-3">
          {preSubmitted ? (
            <div className="flex flex-col gap-2">
              <div className="btn-touch w-full px-5 py-3 rounded-xl bg-green-100 text-green-800 border-2 border-green-400 font-semibold text-base flex items-center justify-center gap-2">
                <span>Morning Pre-Count</span>
                <span className="text-xs font-bold uppercase">Completed</span>
              </div>
              <GhostButton onClick={onSelectPre} className="w-full">View/Edit Morning Count</GhostButton>
            </div>
          ) : (
            <PrimaryButton onClick={onSelectPre} className="w-full">Morning Pre-Count</PrimaryButton>
          )}

          <div>
            <button
              type="button"
              onClick={handleFinalClick}
              className={"btn-touch w-full px-5 py-3 rounded-xl font-semibold text-base border-2 transition-fast " + (!preSubmitted ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : 'bg-primary text-white border-primary hover:bg-primary-700')}
            >
              Lunch Time Count{finalSubmitted ? ' ✓' : ''}
            </button>
            {lockedError && (
              <p className="text-xs text-rose-600 font-medium mt-2">Morning pre-count must be submitted first.</p>
            )}
            {preSubmitted && !finalSubmitted && !lockedError && (
              <p className="text-xs text-primary-500 font-light mt-2">Pre-count complete — ready for the Lunch Time Final Count.</p>
            )}
          </div>
        </div>

        <button onClick={onClose} className="text-primary font-semibold text-sm mt-5 hover:underline w-full text-center">Close &amp; Return Home</button>
      </div>
    </div>
  );
}

/* ============================ TEACHER: CLASSROOM WORKSPACE ============================ */
function ClassroomWorkspace({ data, classroomId, onBack }) {
  const cls = data.classrooms.find(c => c.id === classroomId);
  const roster = data.students.filter(s => s.classroomId === classroomId);
  const today = todayStr();
  const todayLog = data.logsById[logId(today, classroomId)];
  const verified = !!(todayLog && todayLog.verified);

  const [stage, setStage] = useState('pre');
  const [reviewing, setReviewing] = useState(false);
  const [successInfo, setSuccessInfo] = useState(null);
  const [showEntryModal, setShowEntryModal] = useState(!verified);
  const [sortBy, setSortBy] = useState('number');

  useEffect(() => {
    if (!todayLog) {
      saveLogFull(today, classroomId, {
        pre: { entries: emptyEntries(roster), submitted: false, submittedAt: null },
        final: { entries: emptyEntries(roster), submitted: false, submittedAt: null },
        verified: false,
        verifiedAt: null
      });
    }
    // eslint-disable-next-line
  }, []);

  if (!cls) return null;

  const preEntries = (todayLog && todayLog.pre && todayLog.pre.entries) || emptyEntries(roster);
  const hasOwnFinalEntries = todayLog && todayLog.final && todayLog.final.entries && Object.keys(todayLog.final.entries).length > 0;
  const finalEntries = hasOwnFinalEntries ? todayLog.final.entries : preEntries;

  const preSubmitted = !!(todayLog && todayLog.pre && todayLog.pre.submitted);
  const finalSubmitted = !!(todayLog && todayLog.final && todayLog.final.submitted);

  async function updateEntry(targetStage, studentId, entry) {
    if (verified) return;
    const base = todayLog || {
      pre: { entries: emptyEntries(roster), submitted: false, submittedAt: null },
      final: { entries: emptyEntries(roster), submitted: false, submittedAt: null },
      verified: false,
      verifiedAt: null
    };
    if (targetStage === 'pre') {
      const newPre = { ...base.pre, entries: { ...base.pre.entries, [studentId]: entry } };
      await saveLogFull(today, classroomId, { ...base, pre: newPre });
    } else {
      const currentFinalEntries = (base.final && Object.keys(base.final.entries || {}).length) ? base.final.entries : preEntries;
      const newFinal = { ...(base.final || {}), entries: { ...currentFinalEntries, [studentId]: entry } };
      await saveLogFull(today, classroomId, { ...base, final: newFinal });
    }
  }

  async function submitPre() {
    const base = todayLog || { final: { entries: emptyEntries(roster), submitted: false, submittedAt: null }, verified: false, verifiedAt: null };
    await saveLogFull(today, classroomId, { ...base, pre: { entries: preEntries, submitted: true, submittedAt: new Date().toISOString() } });
    setSuccessInfo({ stage: 'pre' });
  }

  async function submitFinal() {
    const base = todayLog || { pre: { entries: emptyEntries(roster), submitted: false, submittedAt: null }, verified: false, verifiedAt: null };
    await saveLogFull(today, classroomId, { ...base, final: { entries: finalEntries, submitted: true, submittedAt: new Date().toISOString() } });
    setSuccessInfo({ stage: 'final' });
  }

  function handleDone() {
    setSuccessInfo(null);
    setReviewing(false);
    onBack();
  }

  const activeEntries = stage === 'pre' ? preEntries : finalEntries;
  const totals = tallyEntries(activeEntries, roster);
  const sortedRoster = sortStudents(roster, sortBy);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 lg:pl-40">
      {!reviewing && roster.length > 0 && <FloatingSummary totals={totals} />}

      {showEntryModal && roster.length > 0 && (
        <ClassroomEntryModal
          cls={cls}
          preSubmitted={preSubmitted}
          finalSubmitted={finalSubmitted}
          onSelectPre={() => { setStage('pre'); setReviewing(false); setShowEntryModal(false); }}
          onSelectFinal={() => { setStage('final'); setReviewing(false); setShowEntryModal(false); }}
          onClose={onBack}
        />
      )}

      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <button onClick={onBack} className="text-primary font-semibold text-sm mb-2 hover:underline">&larr; Back to Overview</button>
          <h2 className="text-2xl font-bold text-primary-900">{cls.grade}</h2>
          <p className="text-primary-600 font-light">{cls.teacher} &middot; {formatDisplayDate(today)}</p>
        </div>
        {verified && <Badge status="Verified" />}
      </div>

      {verified && (
        <div className="mb-6 bg-purple-50 border border-purple-300 text-purple-800 rounded-xl p-4 text-sm font-medium">
          An administrator has verified and finalized today's counts for this classroom. Counts can no longer be edited.
        </div>
      )}

      {roster.length === 0 ? (
        <div className="bg-white rounded-2xl card-shadow p-8 text-center border border-primary-100">
          <p className="text-primary-600 font-light">No students assigned to this classroom yet. Ask your admin to add students under Admin View &rarr; Students.</p>
        </div>
      ) : reviewing ? (
        <ReviewScreen
          stage={stage}
          cls={cls}
          roster={sortedRoster}
          entries={activeEntries}
          onChangeEntry={(studentId, entry) => updateEntry(stage, studentId, entry)}
          onEdit={() => setReviewing(false)}
          onSubmit={stage === 'pre' ? submitPre : submitFinal}
        />
      ) : (
        <React.Fragment>
          <div className="flex gap-2 mb-6 flex-wrap">
            <button
              onClick={() => setStage('pre')}
              className={"btn-touch px-5 py-2.5 rounded-xl font-semibold text-sm transition-fast border-2 " + (stage === 'pre' ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}
            >
              Morning Pre-Count {preSubmitted ? '✓' : ''}
            </button>
            <button
              onClick={() => { if (preSubmitted) setStage('final'); }}
              disabled={!preSubmitted}
              title={!preSubmitted ? "Submit the Morning Pre-Count first" : ''}
              className={"btn-touch px-5 py-2.5 rounded-xl font-semibold text-sm transition-fast border-2 disabled:opacity-40 disabled:cursor-not-allowed " + (stage === 'final' ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}
            >
              Lunchtime Final Count {finalSubmitted ? '✓' : ''}{!preSubmitted ? ' 🔒' : ''}
            </button>
          </div>

          {!preSubmitted && stage === 'pre' && (
            <div className="mb-6 bg-primary-50 border border-primary-200 text-primary-700 rounded-xl p-4 text-sm font-medium">
              Complete and submit the Morning Pre-Count before the Lunchtime Final Count unlocks.
            </div>
          )}
          {stage === 'pre' && preSubmitted && !verified && (
            <div className="mb-6 bg-amber-50 border border-amber-300 text-amber-800 rounded-xl p-4 text-sm font-medium">
              The pre-count was already submitted for today. You can still make corrections and re-submit.
            </div>
          )}
          {stage === 'final' && finalSubmitted && !verified && (
            <div className="mb-6 bg-amber-50 border border-amber-300 text-amber-800 rounded-xl p-4 text-sm font-medium">
              The final count was already submitted. You can still switch any student's status and re-submit before it's verified by an admin.
            </div>
          )}
          {stage === 'final' && !hasOwnFinalEntries && (
            <div className="mb-6 bg-primary-50 border border-primary-200 text-primary-700 rounded-xl p-4 text-sm font-medium">
              Starting from this morning's pre-count. Switch any student's meal, milk, or absence status below before submitting.
            </div>
          )}

          <div className="flex items-center justify-end gap-2 mb-4">
            <label className="text-xs font-medium text-primary-500 uppercase">Sort by</label>
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="border-2 border-primary-200 rounded-lg px-2 py-1.5 text-sm">
              <option value="number">Student #</option>
              <option value="first">First Name</option>
              <option value="last">Last Name</option>
            </select>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {sortedRoster.map(s => (
              <StudentEntryCard
                key={s.id}
                student={s}
                entry={activeEntries[s.id] || defaultEntry()}
                onChange={(entry) => updateEntry(stage, s.id, entry)}
                disabled={verified}
              />
            ))}
          </div>

          <div className="sticky bottom-0 bg-secondary/95 backdrop-blur pt-4 pb-2 border-t border-primary-100">
            <div className="flex justify-between items-center flex-wrap gap-3">
              <p className="text-sm text-primary-600 font-light lg:hidden">
                Hot {totals.hot} &middot; Sack {totals.sack} &middot; Absent {totals.absent} &middot; Milk {totals.milk}
              </p>
              <div className="flex gap-3 ml-auto">
                <GhostButton onClick={onBack}>Cancel</GhostButton>
                <PrimaryButton disabled={verified} onClick={() => setReviewing(true)}>
                  {stage === 'pre' ? 'Review Morning Count' : 'Review Lunch Time Count'} &rarr;
                </PrimaryButton>
              </div>
            </div>
          </div>
        </React.Fragment>
      )}

      {successInfo && (
        <SuccessModal
          title={successInfo.stage === 'pre' ? 'Pre-Count Submitted!' : 'Final Count Submitted!'}
          message={successInfo.stage === 'pre' ? "The morning pre-count has been saved. Come back at lunchtime to complete the final count." : "The lunchtime final count has been saved for today."}
          onDone={handleDone}
        />
      )}
    </div>
  );
}

/* ============================ ADMIN: VERIFICATION ============================ */
function VerificationPanel({ data }) {
  const [dateVal, setDateVal] = useState(todayStr());
  const [expanded, setExpanded] = useState({});

  function toggleExpand(id) { setExpanded(prev => ({ ...prev, [id]: !prev[id] })); }

  async function verifyClassroom(cls) {
    const log = data.logsById[logId(dateVal, cls.id)];
    if (!log || !log.final || !log.final.submitted) { alert('The final count has not been submitted yet for this classroom.'); return; }
    await saveLogFull(dateVal, cls.id, { ...log, verified: true, verifiedAt: new Date().toISOString() });
  }
  async function unverifyClassroom(cls) {
    const log = data.logsById[logId(dateVal, cls.id)];
    if (!log) return;
    await saveLogFull(dateVal, cls.id, { ...log, verified: false, verifiedAt: null });
  }
  async function verifyAll() {
    const eligible = data.classrooms.filter(cls => {
      const log = data.logsById[logId(dateVal, cls.id)];
      return log && log.final && log.final.submitted && !log.verified;
    });
    if (eligible.length === 0) { alert('No submitted, unverified classrooms to finalize for this date.'); return; }
    if (!confirm('Verify and finalize ' + eligible.length + ' classroom(s) for ' + formatDisplayDate(dateVal) + '?')) return;
    for (const cls of eligible) {
      const log = data.logsById[logId(dateVal, cls.id)];
      await saveLogFull(dateVal, cls.id, { ...log, verified: true, verifiedAt: new Date().toISOString() });
    }
  }

  return (
    <div>
      <h3 className="text-xl font-bold text-primary-900 mb-4">Daily Verification &amp; Finalization</h3>
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <input type="date" value={dateVal} onChange={e => setDateVal(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
        <PrimaryButton onClick={verifyAll}>Verify &amp; Finalize All Submitted</PrimaryButton>
      </div>

      {data.classrooms.length === 0 ? (
        <p className="text-sm font-light text-primary-500">No classrooms yet.</p>
      ) : (
        <div className="grid gap-4">
          {data.classrooms.slice().sort((a,b) => a.grade.localeCompare(b.grade, undefined, { numeric: true })).map(cls => {
            const roster = sortStudents(data.students.filter(s => s.classroomId === cls.id), 'number');
            const log = data.logsById[logId(dateVal, cls.id)];
            const preEntries = (log && log.pre && log.pre.entries) || {};
            const finalEntries = (log && log.final && log.final.entries) || {};
            const preT = tallyEntries(preEntries, roster);
            const finalT = tallyEntries(finalEntries, roster);
            const preSubmitted = !!(log && log.pre && log.pre.submitted);
            const finalSubmitted = !!(log && log.final && log.final.submitted);
            const verified = !!(log && log.verified);
            const status = verified ? 'Verified' : (finalSubmitted ? 'Completed' : (preSubmitted ? 'In Progress' : 'Not Started'));

            const changedStudents = finalSubmitted ? roster.filter(s => entryChanged(preEntries[s.id], finalEntries[s.id])) : [];
            const summaryDiffs = [];
            if (finalSubmitted) {
              [['Hot Lunch','hot'],['Sack Lunch','sack'],['Absent','absent'],['Milk','milk']].forEach(([label,key]) => {
                if (preT[key] !== finalT[key]) {
                  const delta = finalT[key] - preT[key];
                  summaryDiffs.push(label + ': ' + preT[key] + ' \u2192 ' + finalT[key] + ' (' + (delta > 0 ? '+' : '') + delta + ')');
                }
              });
            }

            return (
              <div key={cls.id} className="bg-white rounded-2xl card-shadow border border-primary-100 p-5">
                <div className="flex justify-between items-start mb-4 flex-wrap gap-2">
                  <div>
                    <h4 className="font-bold text-primary-900">{classroomLabel(cls)}</h4>
                    <p className="text-xs font-light text-primary-500">{roster.length} students{changedStudents.length > 0 ? ' \u00b7 ' + changedStudents.length + ' changed since morning' : ''}</p>
                  </div>
                  <Badge status={status} />
                </div>

                {verified ? (
                  <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-4">
                    <p className="text-xs font-semibold text-purple-700 uppercase mb-2">Verified Final Count</p>
                    <p className="font-bold text-primary-900 text-sm leading-snug">Hot: {finalT.hot}</p>
                    <p className="font-bold text-primary-900 text-sm leading-snug">Sack: {finalT.sack}</p>
                    <p className="font-bold text-primary-900 text-sm leading-snug">Absent: {finalT.absent}</p>
                    <p className="font-bold text-primary-900 text-sm leading-snug">Milk: {finalT.milk}</p>
                    <p className="font-bold text-purple-700 text-sm leading-snug mt-1">Verified</p>
                  </div>
                ) : (
                  <div className="grid sm:grid-cols-2 gap-4 mb-4">
                    <div className="bg-primary-50 rounded-xl p-3">
                      <p className="text-xs font-semibold text-primary-700 uppercase mb-1">Morning Pre-Count {preSubmitted ? '' : '(not submitted)'}</p>
                      <p className="text-sm text-primary-800">Hot {preT.hot} &middot; Sack {preT.sack} &middot; Absent {preT.absent} &middot; Milk {preT.milk}</p>
                    </div>
                    <div className="bg-primary-50 rounded-xl p-3">
                      <p className="text-xs font-semibold text-primary-700 uppercase mb-1">Lunchtime Final Count {finalSubmitted ? '' : '(not submitted)'}</p>
                      <p className="text-sm text-primary-800">Hot {finalT.hot} &middot; Sack {finalT.sack} &middot; Absent {finalT.absent} &middot; Milk {finalT.milk}</p>
                    </div>
                  </div>
                )}

                {finalSubmitted && summaryDiffs.length > 0 && (
                  <div className="mb-4 bg-amber-50 border border-amber-300 rounded-xl p-3">
                    <p className="text-xs font-semibold text-amber-800 uppercase mb-1">Changed Since Morning</p>
                    <p className="text-sm text-amber-800">{summaryDiffs.join(' \u00b7 ')}</p>
                  </div>
                )}

                {finalSubmitted && (
                  <button onClick={() => toggleExpand(cls.id)} className="text-xs font-semibold text-primary hover:underline mb-3">
                    {expanded[cls.id] ? 'Hide Student Detail \u25b2' : 'Show Student Detail \u25bc'}
                  </button>
                )}

                {finalSubmitted && expanded[cls.id] && (
                  <div className="border border-primary-100 rounded-xl overflow-hidden mb-4 overflow-x-auto">
                    <p className="text-xs font-semibold text-primary-500 uppercase px-2 pt-2 bg-primary-50">Verified Final Count</p>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-primary-50 text-primary-700 text-left">
                          <th className="p-2 font-semibold">Student</th>
                          <th className="p-2 font-semibold">Final Count</th>
                          <th className="p-2 font-semibold">Milk</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-primary-50">
                        {roster.map(s => {
                          const pe = preEntries[s.id] || defaultEntry();
                          const fe = finalEntries[s.id] || defaultEntry();
                          const changed = entryChanged(pe, fe);
                          const mealColor = fe.absent ? 'text-primary-700' : (fe.meal === 'hot' ? 'text-gray-400' : 'text-blue-600');
                          const milkOn = !fe.absent && fe.milk === 'yes';
                          const milkColor = !milkOn ? 'text-primary-300' : (fe.meal === 'sack' ? 'text-blue-600' : 'text-gray-400');
                          return (
                            <tr key={s.id}>
                              <td className="p-2 font-medium text-primary-900">
                                #{s.number} {s.firstName} {s.lastName}{changed && <span className="ml-1 text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">Changed</span>}
                              </td>
                              <td className={"p-2 font-semibold " + mealColor}>{entryStatusLabel(fe)}</td>
                              <td className={"p-2 font-semibold " + milkColor}>{entryMilkLabel(fe)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  {verified ? (
                    <GhostButton onClick={() => unverifyClassroom(cls)}>Unlock (Undo Verification)</GhostButton>
                  ) : (
                    <PrimaryButton disabled={!finalSubmitted} onClick={() => verifyClassroom(cls)}>Verify &amp; Finalize</PrimaryButton>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================ ADMIN: ANALYTICS ============================ */
function AnalyticsDashboard({ data }) {
  const [range, setRange] = useState('daily');
  const [dateVal, setDateVal] = useState(todayStr());
  const [monthVal, setMonthVal] = useState(todayStr().slice(0,7));
  const [termKey, setTermKey] = useState('Q1');
  const [customStart, setCustomStart] = useState(todayStr());
  const [customEnd, setCustomEnd] = useState(todayStr());

  let startDate, endDate, periodLabel, rangeError = null;

  if (range === 'daily') {
    startDate = parseDateStr(dateVal); endDate = parseDateStr(dateVal);
    periodLabel = formatDisplayDate(dateVal);
  } else if (range === 'weekly') {
    const wr = getWeekRange(dateVal); startDate = wr.start; endDate = wr.end;
    periodLabel = formatShortDate(toDateStr(wr.start)) + ' \u2013 ' + formatShortDate(toDateStr(wr.end));
  } else if (range === 'monthly') {
    const mr = getMonthRange(monthVal); startDate = mr.start; endDate = mr.end;
    periodLabel = mr.start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  } else if (range === 'quarter' || range === 'semester') {
    const r = getTermRange(data.settings, termKey);
    if (!r) {
      rangeError = 'No dates set for ' + TERM_LABELS[termKey] + ' yet. Set them in Admin \u2192 Term Settings.';
      startDate = parseDateStr(todayStr()); endDate = startDate; periodLabel = '';
    } else {
      startDate = r.start; endDate = r.end;
      periodLabel = TERM_LABELS[termKey] + ': ' + formatShortDate(toDateStr(r.start)) + ' \u2013 ' + formatShortDate(toDateStr(r.end));
    }
  } else {
    startDate = parseDateStr(customStart); endDate = parseDateStr(customEnd);
    if (endDate < startDate) endDate = startDate;
    periodLabel = formatShortDate(customStart) + ' \u2013 ' + formatShortDate(toDateStr(endDate));
  }

  const agg = useMemo(() => aggregateRange(data, startDate, endDate), [data, startDate.getTime(), endDate.getTime()]);
  const studentAgg = useMemo(() => aggregateRangeByStudent(data, startDate, endDate), [data, startDate.getTime(), endDate.getTime()]);

  const overall = useMemo(() => {
    let hot = 0, sack = 0, absent = 0, milk = 0;
    Object.values(agg).forEach(v => { hot += v.hot; sack += v.sack; absent += v.absent; milk += v.milk; });
    return { hot, sack, absent, milk };
  }, [agg]);

  const sortedClassrooms = useMemo(() => data.classrooms.slice().sort((a,b) => a.grade.localeCompare(b.grade, undefined, { numeric: true })), [data.classrooms]);

  return (
    <div>
      <h3 className="text-xl font-bold text-primary-900 mb-4">Analytics &amp; Reporting</h3>

      <div className="flex flex-wrap gap-2 mb-4">
        {[['daily','Daily'],['weekly','Weekly'],['monthly','Monthly'],['quarter','This Quarter'],['semester','This Semester'],['custom','Custom Date Range']].map(([val,label]) => (
          <button
            key={val}
            onClick={() => setRange(val)}
            className={"px-4 py-2 rounded-xl font-semibold text-sm border-2 transition-fast " + (range === val ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}
          >{label}</button>
        ))}
      </div>

      <div className="mb-6 flex items-center gap-2 flex-wrap">
        {(range === 'daily' || range === 'weekly') && (
          <input type="date" value={dateVal} onChange={e => setDateVal(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
        )}
        {range === 'monthly' && (
          <input type="month" value={monthVal} onChange={e => setMonthVal(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
        )}
        {range === 'quarter' && ['Q1','Q2','Q3','Q4'].map(k => (
          <button key={k} onClick={() => setTermKey(k)} className={"px-3 py-1.5 rounded-lg text-sm font-semibold border-2 " + (termKey === k ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200')}>{k}</button>
        ))}
        {range === 'semester' && ['S1','S2'].map(k => (
          <button key={k} onClick={() => setTermKey(k)} className={"px-3 py-1.5 rounded-lg text-sm font-semibold border-2 " + (termKey === k ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200')}>{k}</button>
        ))}
        {range === 'custom' && (
          <React.Fragment>
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
            <span className="text-sm text-primary-500">to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
          </React.Fragment>
        )}
        {!rangeError && <span className="text-sm font-light italic text-primary-500">Showing: {periodLabel}</span>}
      </div>

      {rangeError ? (
        <div className="bg-amber-50 border border-amber-300 text-amber-800 rounded-xl p-4 text-sm font-medium mb-6">{rangeError}</div>
      ) : (
        <React.Fragment>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            <StatCard label="Hot Lunches" value={overall.hot} />
            <StatCard label="Sack Lunches" value={overall.sack} />
            <StatCard label="Absences" value={overall.absent} />
            <StatCard label="Milk" value={overall.milk} />
          </div>

          {sortedClassrooms.length === 0 ? (
            <p className="text-sm font-light text-primary-500">No classrooms yet.</p>
          ) : (
            <div className="grid gap-4">
              {sortedClassrooms.map(c => {
                const v = agg[c.id] || { hot: 0, sack: 0, absent: 0, milk: 0 };
                const roster = sortStudents(data.students.filter(s => s.classroomId === c.id), 'number');
                return (
                  <div key={c.id} className="bg-white rounded-2xl card-shadow border border-primary-100 p-5">
                    <div className="flex justify-between items-start mb-3 flex-wrap gap-2">
                      <div>
                        <h4 className="font-bold text-primary-900">{classroomLabel(c)}</h4>
                        <p className="text-xs font-light text-primary-500">{roster.length} students</p>
                      </div>
                      <p className="text-sm text-primary-700 font-medium">Hot {v.hot} &middot; Sack {v.sack} &middot; Absent {v.absent} &middot; Milk {v.milk}</p>
                    </div>
                    {roster.length > 0 && (
                      <div className="border-t border-primary-50 pt-3 mt-2">
                        <p className="text-xs font-semibold text-primary-500 uppercase mb-2">Student Detail</p>
                        <div className="divide-y divide-primary-50">
                          {roster.map(s => {
                            const sv = studentAgg[s.id] || { hot: 0, sack: 0, absent: 0, milk: 0 };
                            return (
                              <div key={s.id} className="flex items-center gap-3 py-2">
                                <p className="font-medium text-primary-900 flex-1 min-w-0 truncate text-sm">#{s.number} {s.firstName} {s.lastName}</p>
                                <p className="text-xs text-primary-600 font-light">Hot {sv.hot} &middot; Sack {sv.sack} &middot; Absent {sv.absent} &middot; Milk {sv.milk}</p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </React.Fragment>
      )}
    </div>
  );
}

/* ============================ ADMIN: TERM & CALENDAR SETTINGS ============================ */
function TermSettingsPanel({ settings }) {
  const terms = settings.terms || {};
  const [activeTerm, setActiveTerm] = useState('S1');
  const [start, setStart] = useState((terms.S1 && terms.S1.start) || '');
  const [end, setEnd] = useState((terms.S1 && terms.S1.end) || '');
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    const t = terms[activeTerm] || {};
    setStart(t.start || '');
    setEnd(t.end || '');
    // eslint-disable-next-line
  }, [activeTerm, settings.terms]);

  async function save() {
    const newTerms = { ...terms, [activeTerm]: { start, end } };
    await saveSettings({ terms: newTerms });
    setSavedMsg('Saved!');
    setTimeout(() => setSavedMsg(''), 2000);
  }

  return (
    <div>
      <h3 className="text-xl font-bold text-primary-900 mb-4">Term &amp; Calendar Settings</h3>
      <p className="text-sm font-light text-primary-600 mb-4">Set the start and end date for each term. These dates power "This Quarter" / "This Semester" in Analytics, and the Quarter / Semester / School Year exports.</p>

      <div className="flex flex-wrap gap-2 mb-4">
        {TERM_KEYS.map(k => (
          <button
            key={k}
            onClick={() => setActiveTerm(k)}
            className={"px-4 py-2 rounded-xl font-semibold text-sm border-2 transition-fast " + (activeTerm === k ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}
          >{k}</button>
        ))}
      </div>

      <div className="bg-white rounded-2xl card-shadow border border-primary-100 p-5 flex flex-wrap gap-4 items-end">
        <div>
          <label className="text-xs font-medium text-primary-500 uppercase block mb-1">{TERM_LABELS[activeTerm]} Start Date</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
        </div>
        <div>
          <label className="text-xs font-medium text-primary-500 uppercase block mb-1">{TERM_LABELS[activeTerm]} End Date</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
        </div>
        <PrimaryButton onClick={save}>Save {TERM_LABELS[activeTerm]}</PrimaryButton>
        {savedMsg && <span className="text-sm font-semibold text-green-600">{savedMsg}</span>}
      </div>

      <div className="mt-6 bg-primary-50 rounded-2xl p-4">
        <p className="text-xs font-semibold text-primary-700 uppercase mb-2">All Configured Terms</p>
        <div className="grid sm:grid-cols-2 gap-2 text-sm text-primary-800">
          {TERM_KEYS.map(k => {
            const t = terms[k];
            return (
              <p key={k}><span className="font-semibold">{TERM_LABELS[k]}:</span> {(t && t.start) ? formatShortDate(t.start) : '—'} to {(t && t.end) ? formatShortDate(t.end) : '—'}</p>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================ ADMIN: STUDENT MANAGEMENT ============================ */
function StudentManagement({ data }) {
  const [newNumber, setNewNumber] = useState('');
  const [newFirst, setNewFirst] = useState('');
  const [newLast, setNewLast] = useState('');
  const [newClass, setNewClass] = useState(data.classrooms[0] ? data.classrooms[0].id : '');
  const [editingId, setEditingId] = useState(null);
  const [editNumber, setEditNumber] = useState('');
  const [editFirst, setEditFirst] = useState('');
  const [editLast, setEditLast] = useState('');

  const [search, setSearch] = useState('');
  const [filterClassroom, setFilterClassroom] = useState('');
  const [sortBy, setSortBy] = useState('classroom');
  const [studentSortBy, setStudentSortBy] = useState('number');

  const [importRows, setImportRows] = useState(null);
  const [importBusy, setImportBusy] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!newClass && data.classrooms[0]) setNewClass(data.classrooms[0].id);
    // eslint-disable-next-line
  }, [data.classrooms]);

  async function addStudent(e) {
    e.preventDefault();
    if (!newNumber.trim() || !newFirst.trim() || !newLast.trim() || !newClass) return;
    await saveStudent({ number: newNumber.trim(), firstName: newFirst.trim(), lastName: newLast.trim(), classroomId: newClass });
    setNewNumber(''); setNewFirst(''); setNewLast('');
  }

  async function deleteStudent(id) {
    if (!confirm('Remove this student? This cannot be undone.')) return;
    await deleteStudentDoc(id);
  }

  async function moveStudent(id, classroomId) {
    const s = data.students.find(x => x.id === id);
    if (!s) return;
    await saveStudent({ id, number: s.number, firstName: s.firstName, lastName: s.lastName, classroomId });
  }

  function startEdit(s) { setEditingId(s.id); setEditNumber(String(s.number)); setEditFirst(s.firstName); setEditLast(s.lastName); }
  async function saveEdit(id) {
    const s = data.students.find(x => x.id === id);
    if (!s) return;
    await saveStudent({
      id,
      number: editNumber.trim() || s.number,
      firstName: editFirst.trim() || s.firstName,
      lastName: editLast.trim() || s.lastName,
      classroomId: s.classroomId
    });
    setEditingId(null);
  }

  const visibleClassrooms = useMemo(() => {
    let list = data.classrooms.slice();
    if (filterClassroom) list = list.filter(c => c.id === filterClassroom);
    if (sortBy === 'classroom') list.sort((a,b) => classroomLabel(a).localeCompare(classroomLabel(b)));
    if (sortBy === 'grade') list.sort((a,b) => a.grade.localeCompare(b.grade, undefined, { numeric: true }));
    return list;
  }, [data.classrooms, filterClassroom, sortBy]);

  function studentsFor(classroomId) {
    let list = data.students.filter(s => s.classroomId === classroomId);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(s => (s.firstName + ' ' + s.lastName).toLowerCase().includes(q) || String(s.number).includes(q));
    }
    return sortStudents(list, studentSortBy);
  }

  function handleFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const wb = XLSX.read(evt.target.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        if (!rows.length) { alert('That file appears to be empty.'); return; }
        const header = rows[0].map(h => String(h).trim().toLowerCase());
        const numberIdx = header.indexOf('student #');
        const firstIdx = header.indexOf('first name');
        const lastIdx = header.indexOf('last name');
        const classroomIdx = header.indexOf('classroom');
        if (numberIdx === -1 || firstIdx === -1 || lastIdx === -1 || classroomIdx === -1) {
          alert('The file must have a header row with columns: Student #, First Name, Last Name, Classroom');
          return;
        }
        const parsed = rows.slice(1).filter(r => r.length && (String(r[firstIdx]).trim() || String(r[lastIdx]).trim())).map(r => {
          const number = String(r[numberIdx]).trim();
          const firstName = String(r[firstIdx]).trim();
          const lastName = String(r[lastIdx]).trim();
          const classroomVal = String(r[classroomIdx]).trim().toLowerCase();
          const match = data.classrooms.find(c => classroomLabel(c).trim().toLowerCase() === classroomVal);
          return { number, firstName, lastName, classroomText: String(r[classroomIdx]).trim(), classroomId: match ? match.id : null };
        });
        setImportRows(parsed);
      } catch (err) {
        console.error(err);
        alert('Could not read that file. Please upload a CSV or Excel (.xlsx) file with columns: Student #, First Name, Last Name, Classroom.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function confirmImport() {
    if (!importRows) return;
    setImportBusy(true);
    const matched = importRows.filter(r => r.classroomId);
    for (const r of matched) {
      await saveStudent({ number: r.number, firstName: r.firstName, lastName: r.lastName, classroomId: r.classroomId });
    }
    setImportBusy(false);
    setImportRows(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    alert('Imported ' + matched.length + ' student(s).');
  }

  return (
    <div>
      <h3 className="text-xl font-bold text-primary-900 mb-4">Student Management</h3>

      {data.classrooms.length === 0 ? (
        <p className="text-sm font-light text-primary-500 mb-4">Add a classroom first before adding students.</p>
      ) : (
        <form onSubmit={addStudent} className="bg-white rounded-2xl card-shadow p-4 border border-primary-100 mb-4 flex flex-wrap gap-3 items-end">
          <div className="w-24">
            <label className="text-xs font-medium text-primary-500 uppercase">Student #</label>
            <input value={newNumber} onChange={e => setNewNumber(e.target.value)} placeholder="101" className="w-full border-2 border-primary-200 rounded-xl px-3 py-2 mt-1 focus:outline-none focus:border-primary" />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs font-medium text-primary-500 uppercase">First Name</label>
            <input value={newFirst} onChange={e => setNewFirst(e.target.value)} placeholder="Grace" className="w-full border-2 border-primary-200 rounded-xl px-3 py-2 mt-1 focus:outline-none focus:border-primary" />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="text-xs font-medium text-primary-500 uppercase">Last Name</label>
            <input value={newLast} onChange={e => setNewLast(e.target.value)} placeholder="Miller" className="w-full border-2 border-primary-200 rounded-xl px-3 py-2 mt-1 focus:outline-none focus:border-primary" />
          </div>
          <div>
            <label className="text-xs font-medium text-primary-500 uppercase">Classroom</label>
            <select value={newClass} onChange={e => setNewClass(e.target.value)} className="w-full border-2 border-primary-200 rounded-xl px-3 py-2 mt-1 focus:outline-none focus:border-primary">
              {data.classrooms.map(c => <option key={c.id} value={c.id}>{classroomLabel(c)}</option>)}
            </select>
          </div>
          <PrimaryButton type="submit">Add Student</PrimaryButton>
        </form>
      )}

      <div className="bg-white rounded-2xl card-shadow p-4 border border-primary-100 mb-6">
        <p className="text-sm font-semibold text-primary-800 mb-2">Batch Upload Roster (CSV or Excel)</p>
        <p className="text-xs font-light text-primary-500 mb-3">File must include a header row with columns named exactly: <span className="font-semibold">Student #</span>, <span className="font-semibold">First Name</span>, <span className="font-semibold">Last Name</span>, <span className="font-semibold">Classroom</span>. Classroom must match an existing classroom's "Grade — Teacher" label exactly.</p>
        <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleFileSelected} className="text-sm" />
        {importRows && (
          <div className="mt-4 border border-primary-100 rounded-xl overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-primary-50 text-primary-700 text-left">
                  <th className="p-2 font-semibold">Student #</th>
                  <th className="p-2 font-semibold">First Name</th>
                  <th className="p-2 font-semibold">Last Name</th>
                  <th className="p-2 font-semibold">Classroom</th>
                  <th className="p-2 font-semibold">Match</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary-50">
                {importRows.map((r,i) => (
                  <tr key={i} className={!r.classroomId ? 'bg-rose-50' : ''}>
                    <td className="p-2">{r.number}</td>
                    <td className="p-2">{r.firstName}</td>
                    <td className="p-2">{r.lastName}</td>
                    <td className="p-2">{r.classroomText}</td>
                    <td className="p-2">{r.classroomId ? <span className="text-green-700 font-semibold">Matched</span> : <span className="text-rose-600 font-semibold">No matching classroom</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-3 flex justify-end gap-2 bg-primary-50">
              <GhostButton onClick={() => { setImportRows(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}>Cancel</GhostButton>
              <PrimaryButton disabled={importBusy} onClick={confirmImport}>{importBusy ? 'Importing…' : 'Confirm Import (' + importRows.filter(r => r.classroomId).length + ')'}</PrimaryButton>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-3 mb-4 items-end">
        <div className="flex-1 min-w-[180px]">
          <label className="text-xs font-medium text-primary-500 uppercase block mb-1">Search Students</label>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by name or #…" className="w-full border-2 border-primary-200 rounded-xl px-3 py-2 focus:outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs font-medium text-primary-500 uppercase block mb-1">Filter by Classroom</label>
          <select value={filterClassroom} onChange={e => setFilterClassroom(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2">
            <option value="">All Classrooms</option>
            {data.classrooms.map(c => <option key={c.id} value={c.id}>{classroomLabel(c)}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-primary-500 uppercase block mb-1">Sort Groups By</label>
          <select value={sortBy} onChange={e => setSortBy(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2">
            <option value="classroom">Classroom Name (A–Z)</option>
            <option value="grade">Grade (A–Z)</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-primary-500 uppercase block mb-1">Sort Students By</label>
          <select value={studentSortBy} onChange={e => setStudentSortBy(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2">
            <option value="number">Student #</option>
            <option value="first">First Name</option>
            <option value="last">Last Name</option>
          </select>
        </div>
      </div>

      <div className="grid gap-5">
        {visibleClassrooms.length === 0 && <p className="text-sm font-light text-primary-500">No classrooms match.</p>}
        {visibleClassrooms.map(c => {
          const students = studentsFor(c.id);
          if (search.trim() && students.length === 0) return null;
          return (
            <div key={c.id} className="bg-white rounded-2xl card-shadow border border-primary-100 overflow-hidden">
              <div className="bg-primary-50 px-4 py-2.5 border-b border-primary-100">
                <h4 className="font-bold text-primary-900 text-sm">{classroomLabel(c)}</h4>
              </div>
              <div className="divide-y divide-primary-50">
                {students.length === 0 && <p className="p-4 text-sm font-light text-primary-500">No students.</p>}
                {students.map(s => (
                  <div key={s.id} className="flex items-center gap-3 p-4 flex-wrap">
                    {editingId === s.id ? (
                      <React.Fragment>
                        <input value={editNumber} onChange={e => setEditNumber(e.target.value)} className="border-2 border-primary-200 rounded-lg px-2 py-1 w-20" placeholder="#" autoFocus />
                        <input value={editFirst} onChange={e => setEditFirst(e.target.value)} className="border-2 border-primary-200 rounded-lg px-2 py-1 flex-1 min-w-[110px]" placeholder="First" />
                        <input value={editLast} onChange={e => setEditLast(e.target.value)} className="border-2 border-primary-200 rounded-lg px-2 py-1 flex-1 min-w-[110px]" placeholder="Last" />
                      </React.Fragment>
                    ) : (
                      <p className="font-medium text-primary-900 flex-1 min-w-[140px]"><span className="text-primary-400">#{s.number}</span> {s.firstName} {s.lastName}</p>
                    )}
                    <select
                      value={s.classroomId}
                      onChange={e => moveStudent(s.id, e.target.value)}
                      className="border-2 border-primary-200 rounded-lg px-2 py-1 text-sm"
                    >
                      {data.classrooms.map(cc => <option key={cc.id} value={cc.id}>{classroomLabel(cc)}</option>)}
                    </select>
                    {editingId === s.id ? (
                      <button onClick={() => saveEdit(s.id)} className="px-3 py-1.5 rounded-lg bg-primary text-white text-sm font-semibold">Save</button>
                    ) : (
                      <button onClick={() => startEdit(s)} className="px-3 py-1.5 rounded-lg bg-primary-50 text-primary text-sm font-semibold hover:bg-primary-100">Edit</button>
                    )}
                    <button onClick={() => deleteStudent(s.id)} className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-600 text-sm font-semibold hover:bg-rose-100">Delete</button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ ADMIN: CLASSROOM MANAGEMENT ============================ */
function ClassroomManagement({ data }) {
  const [form, setForm] = useState({ grade: '', teacher: '' });
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ grade: '', teacher: '' });

  async function addClassroom(e) {
    e.preventDefault();
    if (!form.grade.trim() || !form.teacher.trim()) return;
    await saveClassroom({ grade: form.grade.trim(), teacher: form.teacher.trim() });
    setForm({ grade: '', teacher: '' });
  }

  async function deleteClassroom(id) {
    const hasStudents = data.students.some(s => s.classroomId === id);
    if (hasStudents) { alert('Cannot delete a classroom that still has students assigned. Move students first.'); return; }
    if (!confirm('Delete this classroom?')) return;
    await deleteClassroomDoc(id);
  }

  function startEdit(c) { setEditingId(c.id); setEditForm({ grade: c.grade, teacher: c.teacher }); }
  async function saveEdit(id) {
    await saveClassroom({ id, grade: editForm.grade.trim(), teacher: editForm.teacher.trim() });
    setEditingId(null);
  }

  return (
    <div>
      <h3 className="text-xl font-bold text-primary-900 mb-4">Classroom Management</h3>
      <p className="text-sm font-light text-primary-600 mb-4">Classrooms are identified by grade and teacher only.</p>
      <form onSubmit={addClassroom} className="bg-white rounded-2xl card-shadow p-4 border border-primary-100 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="text-xs font-medium text-primary-500 uppercase">Grade</label>
          <input value={form.grade} onChange={e => setForm({ ...form, grade: e.target.value })} placeholder="2nd Grade" className="border-2 border-primary-200 rounded-xl px-3 py-2 mt-1 w-40 focus:outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs font-medium text-primary-500 uppercase">Teacher</label>
          <input value={form.teacher} onChange={e => setForm({ ...form, teacher: e.target.value })} placeholder="Mrs. Smith" className="border-2 border-primary-200 rounded-xl px-3 py-2 mt-1 w-48 focus:outline-none focus:border-primary" />
        </div>
        <PrimaryButton type="submit">Add Classroom</PrimaryButton>
      </form>

      <div className="grid sm:grid-cols-2 gap-4">
        {data.classrooms.length === 0 && <p className="text-sm font-light text-primary-500">No classrooms yet.</p>}
        {data.classrooms.map(c => (
          <div key={c.id} className="bg-white rounded-2xl card-shadow border border-primary-100 p-4">
            {editingId === c.id ? (
              <div className="flex flex-col gap-2">
                <input value={editForm.grade} onChange={e => setEditForm({ ...editForm, grade: e.target.value })} className="border-2 border-primary-200 rounded-lg px-2 py-1" placeholder="Grade" />
                <input value={editForm.teacher} onChange={e => setEditForm({ ...editForm, teacher: e.target.value })} className="border-2 border-primary-200 rounded-lg px-2 py-1" placeholder="Teacher" />
                <div className="flex gap-2 mt-1">
                  <button onClick={() => saveEdit(c.id)} className="px-3 py-1.5 rounded-lg bg-primary text-white text-sm font-semibold">Save</button>
                  <button onClick={() => setEditingId(null)} className="px-3 py-1.5 rounded-lg bg-gray-100 text-gray-600 text-sm font-semibold">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex justify-between items-center flex-wrap gap-2">
                <div>
                  <p className="font-bold text-primary-900">{c.grade}</p>
                  <p className="text-sm text-primary-600 font-light">{c.teacher}</p>
                  <p className="text-xs text-primary-400 font-light mt-1">{data.students.filter(s => s.classroomId === c.id).length} students</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => startEdit(c)} className="px-3 py-1.5 rounded-lg bg-primary-50 text-primary text-sm font-semibold hover:bg-primary-100">Edit</button>
                  <button onClick={() => deleteClassroom(c.id)} className="px-3 py-1.5 rounded-lg bg-rose-50 text-rose-600 text-sm font-semibold hover:bg-rose-100">Delete</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================ ADMIN: EXPORT ============================ */
function ExportPanel({ data }) {
  const [rangeType, setRangeType] = useState('daily');
  const [dateVal, setDateVal] = useState(todayStr());
  const [monthVal, setMonthVal] = useState(todayStr().slice(0,7));
  const [termKey, setTermKey] = useState('Q1');
  const [customStart, setCustomStart] = useState(todayStr());
  const [customEnd, setCustomEnd] = useState(todayStr());
  const [format, setFormat] = useState('xlsx');

  const rangeOptions = [
    ['daily','Daily'],
    ['weekly','Weekly'],
    ['monthly','Monthly'],
    ['quarter','By Quarter'],
    ['semester','By Semester'],
    ['schoolyear','By School Year'],
    ['ytd','Start of School Year to Now'],
    ['custom','Custom Date Range']
  ];

  function computeRange() {
    if (rangeType === 'daily') {
      const d = parseDateStr(dateVal);
      return { start: d, end: d, label: formatDisplayDate(dateVal), filePart: dateVal };
    }
    if (rangeType === 'weekly') {
      const wr = getWeekRange(dateVal);
      return { start: wr.start, end: wr.end, label: 'Week of ' + formatShortDate(toDateStr(wr.start)), filePart: 'week-' + toDateStr(wr.start) };
    }
    if (rangeType === 'monthly') {
      const mr = getMonthRange(monthVal);
      return { start: mr.start, end: mr.end, label: mr.start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), filePart: monthVal };
    }
    if (rangeType === 'quarter' || rangeType === 'semester') {
      const r = getTermRange(data.settings, termKey);
      if (!r) return null;
      return { start: r.start, end: r.end, label: TERM_LABELS[termKey], filePart: termKey };
    }
    if (rangeType === 'schoolyear') {
      const r = getSchoolYearRange(data.settings);
      if (!r) return null;
      return { start: r.start, end: r.end, label: 'Full School Year', filePart: 'school-year' };
    }
    if (rangeType === 'ytd') {
      const r = getStartOfYearToNow(data.settings);
      if (!r) return null;
      return { start: r.start, end: r.end, label: 'Start of School Year \u2013 Today', filePart: 'ytd' };
    }
    let s = parseDateStr(customStart), e = parseDateStr(customEnd);
    if (e < s) e = s;
    return { start: s, end: e, label: formatShortDate(customStart) + ' \u2013 ' + formatShortDate(toDateStr(e)), filePart: customStart + '_to_' + toDateStr(e) };
  }

  function runExport() {
    const r = computeRange();
    if (!r) { alert('That date range has not been configured yet. Set it in Admin \u2192 Term Settings.'); return; }
    const rows = buildRangeExportRows(data, r.start, r.end, r.label);
    const filename = 'lunch-count-export-' + r.filePart;
    if (format === 'xlsx') downloadXLSX(filename + '.xlsx', rows);
    else downloadCSV(filename + '.csv', rows);
  }

  return (
    <div>
      <h3 className="text-xl font-bold text-primary-900 mb-4">Lunch Count Export</h3>
      <p className="text-sm font-light text-primary-600 mb-6">Choose a date range and download a classroom-by-classroom and student-by-student breakdown of final lunch counts.</p>

      <div className="bg-white rounded-2xl card-shadow border border-primary-100 p-5">
        <p className="text-xs font-semibold text-primary-500 uppercase mb-2">Date Range</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {rangeOptions.map(([val,label]) => (
            <button
              key={val}
              onClick={() => setRangeType(val)}
              className={"px-4 py-2 rounded-xl font-semibold text-sm border-2 transition-fast " + (rangeType === val ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}
            >{label}</button>
          ))}
        </div>

        <div className="flex flex-wrap gap-3 items-center mb-4">
          {rangeType === 'daily' && <input type="date" value={dateVal} onChange={e => setDateVal(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />}
          {rangeType === 'weekly' && <input type="date" value={dateVal} onChange={e => setDateVal(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />}
          {rangeType === 'monthly' && <input type="month" value={monthVal} onChange={e => setMonthVal(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />}
          {rangeType === 'quarter' && ['Q1','Q2','Q3','Q4'].map(k => (
            <button key={k} onClick={() => setTermKey(k)} className={"px-3 py-1.5 rounded-lg text-sm font-semibold border-2 " + (termKey === k ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200')}>{k}</button>
          ))}
          {rangeType === 'semester' && ['S1','S2'].map(k => (
            <button key={k} onClick={() => setTermKey(k)} className={"px-3 py-1.5 rounded-lg text-sm font-semibold border-2 " + (termKey === k ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200')}>{k}</button>
          ))}
          {rangeType === 'custom' && (
            <React.Fragment>
              <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
              <span className="text-sm text-primary-500">to</span>
              <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="border-2 border-primary-200 rounded-xl px-3 py-2" />
            </React.Fragment>
          )}
        </div>

        <p className="text-xs font-semibold text-primary-500 uppercase mb-2">File Format</p>
        <div className="flex gap-2 mb-5">
          {[['xlsx','Excel (.xlsx)'],['csv','CSV (.csv)']].map(([val,label]) => (
            <button key={val} onClick={() => setFormat(val)} className={"px-4 py-2 rounded-xl font-semibold text-sm border-2 transition-fast " + (format === val ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}>{label}</button>
          ))}
        </div>

        <PrimaryButton onClick={runExport}>Download Export</PrimaryButton>
      </div>
    </div>
  );
}

/* ============================ ADMIN PANEL ============================ */
function AdminPanel({ data, authUser, onLogout }) {
  const [tab, setTab] = useState('analytics');
  const tabs = [
    ['analytics', 'Analytics'],
    ['verification', 'Verification'],
    ['classrooms', 'Classrooms'],
    ['students', 'Students'],
    ['settings', 'Term Settings'],
    ['export', 'Export']
  ];
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex justify-between items-start mb-6 flex-wrap gap-3">
        <h2 className="text-2xl font-bold text-primary-900">Admin Dashboard</h2>
        <div className="text-right">
          <p className="text-xs text-primary-500 font-light">Signed in as {authUser && authUser.email}</p>
          <button onClick={onLogout} className="text-xs font-semibold text-primary hover:underline">Log Out</button>
        </div>
      </div>
      <div className="flex gap-2 mb-6 flex-wrap">
        {tabs.map(([val,label]) => (
          <button
            key={val}
            onClick={() => setTab(val)}
            className={"btn-touch px-5 py-2.5 rounded-xl font-semibold text-sm transition-fast border-2 " + (tab === val ? 'bg-primary text-white border-primary' : 'bg-white text-primary-700 border-primary-200 hover:bg-primary-50')}
          >{label}</button>
        ))}
      </div>

      {tab === 'analytics' && <AnalyticsDashboard data={data} />}
      {tab === 'verification' && <VerificationPanel data={data} />}
      {tab === 'classrooms' && <ClassroomManagement data={data} />}
      {tab === 'students' && <StudentManagement data={data} />}
      {tab === 'settings' && <TermSettingsPanel settings={data.settings} />}
      {tab === 'export' && <ExportPanel data={data} />}
    </div>
  );
}

/* ============================ SETUP SCREEN (NO FIREBASE CONFIG YET) ============================ */
function SetupRequiredScreen() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <h2 className="text-2xl font-bold text-primary-900 mb-3 text-center">Connect Firebase to get started</h2>
      <p className="text-primary-600 font-light mb-6 text-center">
        This app stores all data in Firebase so every teacher and admin sees the same live counts.
        Open the &lt;script&gt; block near the top of this file and replace the <code>firebaseConfig</code> placeholder
        values with your project's config.
      </p>
      <ol className="text-sm text-primary-700 font-light list-decimal list-inside space-y-2 bg-white rounded-2xl card-shadow p-6 border border-primary-100">
        <li>Create a project at console.firebase.google.com</li>
        <li>Enable Cloud Firestore (Build &rarr; Firestore Database)</li>
        <li>Enable Authentication &rarr; Sign-in method &rarr; Email/Password</li>
        <li>Create at least one admin user under Authentication &rarr; Users</li>
        <li>Copy your Web App config into <code>firebaseConfig</code> in this file</li>
        <li>Apply the suggested Firestore security rules included as a comment near the config</li>
      </ol>
    </div>
  );
}

/* ============================ ROOT APP ============================ */
function ConnectedApp() {
  const { items: classrooms, loading: classroomsLoading } = useCollection('classrooms');
  const { items: students, loading: studentsLoading } = useCollection('students');
  const { settings, loading: settingsLoading } = useSettingsDoc();
  const { logs, logsById, loading: logsLoading } = useLogs();

  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [role, setRole] = useState('teacher');
  const [showLogin, setShowLogin] = useState(false);
  const [view, setView] = useState({ screen: 'overview', classroomId: null });

  useEffect(() => {
    const unsub = auth.onAuthStateChanged(u => {
      setAuthUser(u);
      setAuthChecked(true);
      if (!u) setRole('teacher');
    });
    return () => unsub();
  }, []);

  function requestRole(r) {
    if (r === 'admin') {
      if (authUser) setRole('admin'); else setShowLogin(true);
      return;
    }
    setRole('teacher');
    setView({ screen: 'overview', classroomId: null });
  }

  function handleLogout() {
    auth.signOut();
    setRole('teacher');
    setView({ screen: 'overview', classroomId: null });
  }

  const data = { classrooms, students, settings, logs, logsById };
  const stillLoading = classroomsLoading || studentsLoading || settingsLoading || logsLoading || !authChecked;

  return (
    <div className="min-h-screen">
      <NavBar role={role} onRequestRole={requestRole} />

      {showLogin && (
        <AdminLoginModal
          onClose={() => setShowLogin(false)}
          onSuccess={() => { setRole('admin'); setShowLogin(false); }}
        />
      )}

      {stillLoading ? (
        <div className="max-w-6xl mx-auto px-6 py-24 text-center text-primary-500 font-light">Loading live data&hellip;</div>
      ) : (
        <React.Fragment>
          {role === 'teacher' && view.screen === 'overview' && (
            <TeacherOverview data={data} onOpenClassroom={(id) => setView({ screen: 'workspace', classroomId: id })} />
          )}
          {role === 'teacher' && view.screen === 'workspace' && (
            <ClassroomWorkspace
              key={view.classroomId}
              data={data}
              classroomId={view.classroomId}
              onBack={() => setView({ screen: 'overview', classroomId: null })}
            />
          )}
          {role === 'admin' && authUser && (
            <AdminPanel data={data} authUser={authUser} onLogout={handleLogout} />
          )}
        </React.Fragment>
      )}

      <footer className="text-center text-xs font-light text-primary-400 py-8">
        <p>Counting Loaves · Lunch Counter App</p>
        <p className="mt-1">Made only for St. Mary Catholic School</p>
      </footer>
    </div>
  );
}

function App() {
  return (
    <DailyPasswordGate>
      {FIREBASE_NOT_CONFIGURED ? (
        <div className="min-h-screen">
          <div className="bg-primary text-white">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
              <h1 className="text-2xl font-bold leading-tight">🍞 Counting Loaves</h1>
            </div>
          </div>
          <SetupRequiredScreen />
        </div>
      ) : (
        <ConnectedApp />
      )}
    </DailyPasswordGate>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
