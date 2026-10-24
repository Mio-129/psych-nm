const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/* ---------------------------------------------------------------------------
 * Yardımcılar
 * ------------------------------------------------------------------------- */

const DEFAULT_ADMIN_LIMIT = 20;
const MAX_ADMIN_LIMIT = 100;
const DEFAULT_BOARD_LIMIT = 50;
const MAX_BOARD_LIMIT = 100;
const MAX_POINT_AMOUNT = 1000000;
const SCORE_PAGE_SIZE = 1000;
const MAX_SCORE_PAGES = 30; // tek istekte en fazla 30.000 score satırı taranır

function readLimit(raw, fallback, max) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function readText(raw, maxLength) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, maxLength);
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function asPoints(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || null;
}

// Zamanlama saldırılarına karşı sabit süreli karşılaştırma
function safeEquals(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function adminKeyFromEnv() {
  return (process.env.ADMIN_KEY || '').trim();
}

// Yönetici uçları: X-Admin-Key zorunlu.
// ADMIN_KEY tanımlı değilse 503, anahtar yok/yanlışsa 401 {error:'yetkisiz'}.
function adminAuth(req, res, next) {
  const configured = adminKeyFromEnv();
  if (!configured) {
    return res.status(503).json({
      error: 'Yönetici işlemleri kapalı: sunucuda ADMIN_KEY tanımlı değil',
    });
  }
  const provided = req.get('x-admin-key') || '';
  if (!provided || !safeEquals(provided, configured)) {
    return res.status(401).json({ error: 'yetkisiz' });
  }
  return next();
}

// Veritabanı hatalarını anlaşılır Türkçe ipuçlarıyla zenginleştir.
function dbFailure(error) {
  const message = (error && error.message) || 'bilinmeyen veritabanı hatası';
  const missingColumn = /column/i.test(message) && /does not exist|yok/i.test(message);

  if (missingColumn && /points/i.test(message)) {
    return {
      status: 500,
      body: {
        error: message,
        hint: "Migration eksik: users.points kolonu yok. web/README.md içindeki SQL'i Supabase SQL Editor'de çalıştırın.",
      },
    };
  }
  if (/admin_logs/i.test(message)) {
    return {
      status: 500,
      body: {
        error: message,
        hint: "Migration eksik: admin_logs tablosu yok. web/README.md içindeki SQL'i Supabase SQL Editor'de çalıştırın.",
      },
    };
  }
  return { status: 500, body: { error: message } };
}

function sendDbFailure(res, error) {
  const failure = dbFailure(error);
  return res.status(failure.status).json(failure.body);
}

// İşlem geçmişi: tablo yoksa ana işlemi bozmayız, sadece loglarız.
async function writeAdminLog(entry) {
  const payload = {
    action: entry.action,
    target_user_id: entry.target_user_id || null,
    target_username: entry.target_username || null,
    amount: entry.amount == null ? null : entry.amount,
    reason: entry.reason || null,
    admin_ip: entry.admin_ip || null,
  };
  const { error } = await supabase.from('admin_logs').insert(payload);
  if (error) console.warn('[admin_logs] kayıt yazılamadı:', error.message);
  return error || null;
}

/* ---------------------------------------------------------------------------
 * Mevcut (oyun istemcisinin bağlı olduğu) uçlar — davranışları değişmedi
 * ------------------------------------------------------------------------- */

app.get('/health', async (req, res) => {
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    res.json({ status: 'ok', users_table: error ? error.message : 'ok' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username ve password gerekli' });

  const { data: existing } = await supabase.from('users').select('id').eq('username', username).single();
  if (existing) return res.status(409).json({ error: 'Bu kullanıcı adı zaten alınmış' });

  const hashed = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({ username, password: hashed }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, user_id: data.id, username: data.username });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username ve password gerekli' });

  const { data: user, error } = await supabase.from('users').select('*').eq('username', username).single();
  if (error || !user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Şifre yanlış' });

  res.json({ success: true, user_id: user.id, username: user.username });
});

app.post('/score', async (req, res) => {
  const { user_id, score, song_name } = req.body;
  if (!user_id || score == null) return res.status(400).json({ error: 'user_id ve score gerekli' });

  const { data, error } = await supabase.from('scores').insert({ user_id, score, song_name }).select().single();
  if (error) return res.status(500).json({ error: error.message });

  res.json({ success: true, score: data });
});

/* ---------------------------------------------------------------------------
 * Yönetici uçları (X-Admin-Key)
 * ------------------------------------------------------------------------- */

// GET /users?q=&limit=20 → arama (username ILIKE %q%)
app.get('/users', adminAuth, async (req, res) => {
  const query = readText(req.query.q, 64);
  const limit = readLimit(req.query.limit, DEFAULT_ADMIN_LIMIT, MAX_ADMIN_LIMIT);

  let builder = supabase
    .from('users')
    .select('id, username, points, created_at')
    .order('username', { ascending: true })
    .limit(limit);

  if (query) {
    // PostgREST LIKE jokerlerini kaçır: % _ * \
    const pattern = '%' + query.replace(/[\\%_*]/g, (char) => '\\' + char) + '%';
    builder = builder.ilike('username', pattern);
  }

  const { data, error } = await builder;
  if (error) return sendDbFailure(res, error);

  res.json({
    users: (data || []).map((row) => ({
      user_id: row.id,
      username: row.username,
      points: asPoints(row.points),
      created_at: row.created_at,
    })),
  });
});

// GET /users/:id → tek kullanıcı + score sayısı
app.get('/users/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: 'Geçersiz kullanıcı kimliği' });

  const { data: user, error } = await supabase
    .from('users')
    .select('id, username, points, created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) return sendDbFailure(res, error);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  const { count, error: countError } = await supabase
    .from('scores')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', id);

  res.json({
    user_id: user.id,
    username: user.username,
    points: asPoints(user.points),
    created_at: user.created_at,
    scores_count: countError ? null : count || 0,
  });
});

// DELETE /users/:id → kullanıcı + score kayıtları silinir
app.delete('/users/:id', adminAuth, async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: 'Geçersiz kullanıcı kimliği' });

  const { data: user, error: findError } = await supabase
    .from('users')
    .select('id, username, points')
    .eq('id', id)
    .maybeSingle();
  if (findError) return sendDbFailure(res, findError);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  // FK "on delete cascade" olsa da olmasa da score kayıtları temizlenir.
  const { error: scoresError } = await supabase.from('scores').delete().eq('user_id', id);
  if (scoresError) return sendDbFailure(res, scoresError);

  const { error: userError } = await supabase.from('users').delete().eq('id', id);
  if (userError) return sendDbFailure(res, userError);

  await writeAdminLog({
    action: 'delete_user',
    target_user_id: user.id,
    target_username: user.username,
    amount: null,
    reason: readText(req.body && req.body.reason, 200) || null,
    admin_ip: clientIp(req),
  });

  res.json({ success: true });
});

// POST /points {user_id, amount, reason} → puan ekle/çıkar (0'ın altına inmez)
app.post('/points', adminAuth, async (req, res) => {
  const body = req.body || {};
  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  const amount = Number(body.amount);
  const reason = readText(body.reason, 200);

  if (!isValidId(userId)) return res.status(400).json({ error: 'Geçerli bir user_id gerekli' });
  if (!Number.isInteger(amount)) return res.status(400).json({ error: 'amount tam sayı olmalı' });
  if (amount === 0) return res.status(400).json({ error: 'amount 0 olamaz' });
  if (Math.abs(amount) > MAX_POINT_AMOUNT) {
    return res.status(400).json({ error: 'amount en fazla ±' + MAX_POINT_AMOUNT + ' olabilir' });
  }

  const { data: user, error: findError } = await supabase
    .from('users')
    .select('id, username, points')
    .eq('id', userId)
    .maybeSingle();
  if (findError) return sendDbFailure(res, findError);
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  const current = asPoints(user.points);
  const requested = current + amount;
  const next = Math.max(0, requested);
  const applied = next - current;

  const { data: updated, error: updateError } = await supabase
    .from('users')
    .update({ points: next })
    .eq('id', userId)
    .select('id, username, points')
    .single();
  if (updateError) return sendDbFailure(res, updateError);

  // Puan 0'a sabitlendiyse gerçekleşen miktar "set_points" olarak loglanır.
  const clamped = applied !== amount;
  await writeAdminLog({
    action: clamped ? 'set_points' : 'add_points',
    target_user_id: updated.id,
    target_username: updated.username,
    amount: applied,
    reason: clamped
      ? (reason ? reason + ' (puan 0 tabanına sabitlendi)' : 'Puan 0 tabanına sabitlendi')
      : reason || null,
    admin_ip: clientIp(req),
  });

  res.json({
    success: true,
    points: asPoints(updated.points),
    previous_points: current,
    applied_amount: applied,
    clamped,
  });
});

// GET /admin/logs?limit=50 → yönetici işlem geçmişi
app.get('/admin/logs', adminAuth, async (req, res) => {
  const limit = readLimit(req.query.limit, DEFAULT_BOARD_LIMIT, 200);

  const { data, error } = await supabase
    .from('admin_logs')
    .select('id, action, target_user_id, target_username, amount, reason, admin_ip, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return sendDbFailure(res, error);

  res.json({ logs: data || [] });
});

/* ---------------------------------------------------------------------------
 * Liderlik tablosu
 *   GET /leaderboard          → kullanıcı bazlı toplam puan sıralaması
 *   GET /leaderboard?raw=1    → eski score-satırı formatı (geriye dönük uyum)
 * ------------------------------------------------------------------------- */

async function handleRawLeaderboard(res) {
  const { data, error } = await supabase
    .from('scores')
    .select('score, song_name, created_at, users(username)')
    .order('score', { ascending: false })
    .limit(50);
  if (error) return sendDbFailure(res, error);

  res.json({ leaderboard: data });
}

// Seçilen kullanıcıların score satırlarını sayfalayarak toplar.
async function fetchScoresForUsers(userIds) {
  const rows = [];
  for (let page = 0; page < MAX_SCORE_PAGES; page += 1) {
    const from = page * SCORE_PAGE_SIZE;
    const to = from + SCORE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from('scores')
      .select('user_id, score, created_at')
      .in('user_id', userIds)
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) return { rows, error };

    const batch = data || [];
    rows.push(...batch);
    if (batch.length < SCORE_PAGE_SIZE) return { rows, error: null };
  }
  return { rows, error: null };
}

app.get('/leaderboard', async (req, res) => {
  if (String(req.query.raw || '').toLowerCase() === '1') {
    return handleRawLeaderboard(res);
  }

  const limit = readLimit(req.query.limit, DEFAULT_BOARD_LIMIT, MAX_BOARD_LIMIT);

  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('id, username, points, created_at')
    .order('points', { ascending: false })
    .order('username', { ascending: true })
    .limit(limit);
  if (usersError) return sendDbFailure(res, usersError);

  const list = users || [];
  if (list.length === 0) return res.json({ leaderboard: [] });

  const { rows, error: scoresError } = await fetchScoresForUsers(list.map((user) => user.id));
  if (scoresError) return sendDbFailure(res, scoresError);

  const stats = new Map();
  for (const row of rows) {
    const key = String(row.user_id);
    const current = stats.get(key) || { songs_played: 0, best_score: null, last_played: null };
    current.songs_played += 1;
    const scoreValue = Number(row.score);
    if (Number.isFinite(scoreValue) && (current.best_score == null || scoreValue > current.best_score)) {
      current.best_score = scoreValue;
    }
    if (row.created_at && (!current.last_played || String(row.created_at) > String(current.last_played))) {
      current.last_played = row.created_at;
    }
    stats.set(key, current);
  }

  const leaderboard = list
    .map((user) => {
      const stat = stats.get(String(user.id)) || { songs_played: 0, best_score: null, last_played: null };
      return {
        user_id: user.id,
        username: user.username,
        points: asPoints(user.points),
        songs_played: stat.songs_played,
        best_score: stat.best_score,
        updated_at: stat.last_played || user.created_at || null,
      };
    })
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const bestA = a.best_score == null ? -Infinity : a.best_score;
      const bestB = b.best_score == null ? -Infinity : b.best_score;
      if (bestB !== bestA) return bestB - bestA;
      return String(a.username || '').localeCompare(String(b.username || ''), 'tr');
    })
    .map((entry, index) => ({ rank: index + 1, ...entry }));

  res.json({ leaderboard });
});

/* ---------------------------------------------------------------------------
 * Statik arayüzler (web/) — aynı origin'den servis edilirse CORS gerekmez
 * ------------------------------------------------------------------------- */

app.use(express.static(path.join(__dirname, 'web'), { index: false }));
app.get('/', (req, res) => res.redirect('/leaderboard.html'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[uyarı] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tanımlı değil.');
  }
  if (!adminKeyFromEnv()) {
    console.warn('[uyarı] ADMIN_KEY tanımlı değil: yönetici uçları 503 dönecek.');
  }
});
