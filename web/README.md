# psych-nm · Liderlik Tablosu + Yönetici Paneli

Bu klasör iki adet **tek dosyalık** arayüz içerir. Harici CDN, kütüphane veya derleme adımı yoktur; CSS ve JS dosyanın içine gömülüdür.

| Dosya | Amaç | Sunucu uçları |
| --- | --- | --- |
| `leaderboard.html` | Herkese açık, salt okunur sıralama tablosu | `GET /leaderboard` |
| `admin.html` | Puan yönetimi, kullanıcı silme, işlem geçmişi | `GET /users`, `GET /users/:id`, `DELETE /users/:id`, `POST /points`, `GET /admin/logs`, `GET /health` |

`server.js` bu klasörü **statik** olarak servis eder (`express.static`), yani deploy sonrası:

- `https://psych-nm.onrender.com/leaderboard.html`
- `https://psych-nm.onrender.com/admin.html`

adreslerinden açılır. Aynı origin'den açıldığında CORS devreye girmez.

> Not: `admin.html` service_role anahtarını **hiçbir zaman** görmez. Tarayıcı yalnızca sizin API'nize `X-Admin-Key` başlığı ile konuşur; veritabanı erişimi sunucuda kalır.

---

## 1. Kurulum

### 1.1 Ortam değişkenleri

| Değişken | Zorunlu | Açıklama |
| --- | --- | --- |
| `SUPABASE_URL` | Evet | Supabase proje URL'i |
| `SUPABASE_SERVICE_ROLE_KEY` | Evet | Yalnızca sunucuda; asla HTML/istemciye verilmez |
| `ADMIN_KEY` | Yönetici paneli için | Yönetici uçlarının anahtarı. **Tanımlı değilse yönetici uçları `503` döner.** |
| `PORT` | Hayır (varsayılan 3000) | Render bunu otomatik verir |

Anahtar üretmek için **terminal** (bash / PowerShell):

```bash
openssl rand -hex 32
# veya
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ **Bu komutlar SQL değildir.** Supabase **SQL Editor**'e yapıştırırsanız
> `ERROR: 42601: syntax error at or near "openssl"` hatası alırsınız; SQL Editor sadece SQL çalıştırır.
>
> Elinizde yalnızca SQL Editor varsa (telefon/tablet gibi terminal olmayan ortamlar) anahtarı SQL ile üretin —
> ek eklenti (`pgcrypto`) gerekmez:
>
> ```sql
> SELECT replace(gen_random_uuid()::text, '-', '')
>     || replace(gen_random_uuid()::text, '-', '') AS admin_key;
> ```
>
> Dönen 64 karakterlik değeri Render → **Environment** → `ADMIN_KEY` alanına yapıştırın.
> Bu değeri repoya, koda, ekran görüntüsüne veya sohbete yazmayın.

Anahtarı **koda gömmeyin**; yalnızca Render → Environment (veya yerelde `.env`) üzerinden verin.

### 1.2 Supabase migration (SQL Editor'de sırayla çalıştırın)

> Aşağıdaki bloklar **SQL'dir**, SQL Editor'e olduğu gibi yapıştırılabilir.
> `openssl`, `node`, `npm` gibi komutlar ise **terminal** içindir ve SQL Editor'de sözdizimi hatası verir.

```sql
-- 1) Kullanıcı puanı
ALTER TABLE users ADD COLUMN IF NOT EXISTS points integer NOT NULL DEFAULT 0;

-- 2) Yönetici işlem geçmişi
CREATE TABLE IF NOT EXISTS admin_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action           text NOT NULL CHECK (action IN ('add_points', 'set_points', 'delete_user')),
  target_user_id   uuid,
  target_username  text,
  amount           integer,
  reason           text,
  admin_ip         text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 3) Index'ler
CREATE INDEX IF NOT EXISTS users_username_idx ON users (username);
CREATE INDEX IF NOT EXISTS scores_user_id_idx ON scores (user_id);

-- 4) (Önerilir) Silme davranışı: kullanıcı silinince score'lar da gitsin.
--    Foreign key zaten varsa bu blok hata verirse atlayın; API skorları manuel de siler.
ALTER TABLE scores
  DROP CONSTRAINT IF EXISTS scores_user_id_fkey;
ALTER TABLE scores
  ADD CONSTRAINT scores_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
```

**Notlar**

- `points` kolonu yoksa uygulama çökmez: yönetici uçları `500` + `hint` alanında "Migration eksik" mesajı döner.
- `admin_logs` tablosu yoksa puan/silme işlemleri **yine çalışır**; sadece log yazılamaz (sunucu konsoluna uyarı düşer).
- Tablolarda RLS açıksa `service_role` anahtarı RLS'i atlar; ek policy gerekmez.
- `users.username` için `UNIQUE` kısıtı zaten varsa `users_username_idx` gereksizdir (zararsız).

### 1.3 Render'da deploy sırası

1. Supabase SQL Editor'de yukarıdaki migration'ı çalıştırın (önce `points`, sonra `admin_logs`).
2. Render → servis → **Environment** → `ADMIN_KEY` ekleyin (güçlü, rastgele, en az 32 karakter).
   Üretimi için yukarıdaki 1.1 bölümüne bakın (terminal komutu **veya** SQL Editor için `gen_random_uuid()` sorgusu).
3. Kodu deploy edin (`main`'e merge sonrası otomatik).
4. `GET /health` → `{"status":"ok","users_table":"ok"}` doğrulayın.
5. `https://psych-nm.onrender.com/leaderboard.html` ve `/admin.html` adreslerini açın.
6. Panele **Sunucu URL** = `https://psych-nm.onrender.com`, **Admin Key** = Render'daki anahtar girip "Bağlan".

> Free tier: servis uykudaysa ilk istek 30-60 saniye sürebilir. İki arayüz de 90 saniyelik zaman aşımı ve "Sunucu uyanıyor, 1 dakika sürebilir…" durumu gösterir.

### 1.4 Yerelde çalıştırma

```bash
npm install
SUPABASE_URL="..." SUPABASE_SERVICE_ROLE_KEY="..." ADMIN_KEY="test-anahtar" npm start
# http://localhost:3000/leaderboard.html
# http://localhost:3000/admin.html
```

---

## 2. Endpoint sözleşmesi

Yönetici uçları `X-Admin-Key` başlığı ister:

- Başlık yok/yanlış → **401** `{ "error": "yetkisiz" }`
- `ADMIN_KEY` tanımlı değil → **503** `{ "error": "Yönetici işlemleri kapalı: sunucuda ADMIN_KEY tanımlı değil" }`

Hiçbir uç `password` (bcrypt hash) alanı döndürmez.

### Mevcut uçlar (davranışı değişmedi)

| Uç | İstek | Yanıt |
| --- | --- | --- |
| `GET /health` | — | `{ status, users_table }` |
| `POST /register` | `{ username, password }` | `{ success, user_id, username }` · 409 `{error}` |
| `POST /login` | `{ username, password }` | `{ success, user_id, username }` · 401/404 `{error}` |
| `POST /score` | `{ user_id, score, song_name }` | `{ success, score:{...} }` (her çağrıda yeni satır) |
| `GET /leaderboard?raw=1` | — | `{ leaderboard:[{ score, song_name, created_at, users:{username} }] }` (limit 50, score desc) |

> Oyun istemcisi `?raw=1` kullanmıyorsa dikkat: **`GET /leaderboard` artık yeni (kullanıcı bazlı) formatı döndürür.** Eski format gerekiyorsa `?raw=1` eklenmelidir.

### Yeni / güncellenen uçlar

#### `GET /users?q=&limit=20`  (X-Admin-Key)

`username` üzerinde `ILIKE %q%`. `limit` varsayılan 20, en fazla 100.

```json
{ "users": [ { "user_id": "uuid", "username": "mio", "points": 12, "created_at": "2026-10-01T12:00:00+00:00" } ] }
```

#### `GET /users/:id`  (X-Admin-Key)

```json
{ "user_id": "uuid", "username": "mio", "points": 12, "created_at": "...", "scores_count": 3 }
```

Yoksa **404** `{ "error": "Kullanıcı bulunamadı" }`; geçersiz id → **400**.

#### `DELETE /users/:id`  (X-Admin-Key)

Score kayıtları önce (FK cascade olsa da olmasa da) silinir, sonra kullanıcı silinir; işlem `admin_logs`'a `delete_user` olarak yazılır.

```json
{ "success": true }
```

Yoksa **404**, geçersiz id → **400**.

#### `POST /points`  (X-Admin-Key)

```json
{ "user_id": "uuid", "amount": 10, "reason": "etkinlik ödülü" }
```

`amount` tam sayı olmalı (0 olamaz, ±1.000.000 sınırı). Negatif olabilir; sonuç **0'ın altına inmez**.

```json
{ "success": true, "points": 22, "previous_points": 12, "applied_amount": 10, "clamped": false }
```

0 tabanına sabitlendiğinde `clamped: true`, `applied_amount` gerçekte uygulanan (küçültülmüş) miktardır ve log `set_points` olarak yazılır.

Hatalar: **400** (amount geçersiz), **404** (kullanıcı yok), **401/503** (anahtar).

#### `GET /admin/logs?limit=50`  (X-Admin-Key)

`limit` varsayılan 50, en fazla 200; `created_at` desc.

```json
{ "logs": [ { "id": "uuid", "action": "add_points", "target_user_id": "uuid",
              "target_username": "mio", "amount": 10, "reason": "etkinlik",
              "admin_ip": "85.100.20.11", "created_at": "..." } ] }
```

#### `GET /leaderboard?limit=50`

Kullanıcı bazlı toplam puan sıralaması. `limit` varsayılan 50, en fazla 100. Sıralama: `points desc` → `best_score desc` → `username` (TR).

```json
{
  "leaderboard": [
    { "rank": 1, "user_id": "uuid", "username": "mio", "points": 128,
      "songs_played": 24, "best_score": 96, "updated_at": "2026-10-20T19:04:00+00:00" }
  ]
}
```

- `songs_played` = kullanıcının score satırı sayısı
- `best_score` = en yüksek score değeri (hiç yoksa `null`)
- `updated_at` = son score kaydının zamanı; yoksa kayıt tarihi

`GET /leaderboard?raw=1` eski formatı aynen döndürür (geriye dönük uyumluluk).

---

## 3. Arayüzler

### `leaderboard.html`

- Sıra, kullanıcı adı, toplam puan, çalınan şarkı, en iyi skor.
- İlk 3: altın/gümüş/bronz zemin + 🥇🥈🥉.
- `?user=<username>` → kendi satırını vurgular ("SEN" etiketi). Kişi ilk N'de yoksa bilgi kutusu çıkar.
- Top 10/25/50/100 seçici (seçim `localStorage`'a yazılır), kullanıcı adı filtresi, 30 sn otomatik yenileme + "son güncelleme" saati (sekme gizliyken durur).
- Salt okunur; yönetici işlemi yok.
- Mobilde tablo yatay kaydırılır (360 px'te bozulmaz), ilk kolon sabittir.
- Sunucu adresi: `?api=https://...` → `localStorage.psychnm_api` → aynı origin → (file:// ise) `https://psych-nm.onrender.com`.

Örnek: `leaderboard.html?user=mio&limit=100`

### `admin.html`

- **Ayarlar**: Sunucu URL (varsayılan `https://psych-nm.onrender.com`) + Admin Key, ikisi de `localStorage`'da (`psychnm_admin_server`, `psychnm_admin_key`). Anahtar varsayılan olarak maskelidir (👁 ile gösterilir). Sunucuya hiçbir zaman service_role anahtarı gitmez.
- **Bağlan**: `GET /health` + anahtar doğrulama (`GET /users?limit=1`).
  - Başarılı → "Bağlı · tam yetki"
  - 401 / 503 / ağ hatası → **salt okunur mod**: uyarı bandı görünür, puan ve silme düğmeleri kapalı.
- **Kullanıcı arama**: 280 ms debounce ile canlı `GET /users?q=...&limit=20`.
- **Seçili kullanıcı kartı**: ad, kimlik, puan, kayıt tarihi, score sayısı (`GET /users/:id`).
- **Puan işlemleri**: miktar + sebep, hızlı düğmeler (+1/+5/+10/+50/−1/−5), özetli **onay penceresi**, sonuç toast'u ve işlem sonrası kullanıcının sunucudan yeniden çekilmesi.
- **Hesap silme**: iki aşamalı onay — önce "geri alınamaz" uyarısı + kullanıcının puanı, sonra kullanıcı adının birebir yazılması; eşleşmeden silme düğmesi açılmaz.
- **İşlem geçmişi**: "Sunucu kayıtları" (`GET /admin/logs`) ve "Bu tarayıcı" (`localStorage`, son 100 işlem; sayfa yenilense de kalır).
- İstek sırasında düğmeler kilitlenir; hata mesajı Türkçe açıklama + `HTTP <kod>` + sunucunun `error` metni olarak ayrı satırlarda gösterilir; tüm isteklerde 90 sn `AbortController` zaman aşımı vardır.
- **`?mock=1`**: ağ isteği yapmadan örnek verilerle tam panel (puan ekleme/silme/loglar dahil) — demo ve test için.

Örnek: `admin.html?mock=1`

---

## 4. CORS ve güvenlik notları

- `server.js` içinde `cors()` varsayılan ayarlarla açıktır: tüm origin'ler ve `X-Admin-Key` dahil istenen başlıklar (`OPTIONS` preflight) desteklenir. Bu yüzden panelleri **kendi origin'inizden** (yukarıdaki iki URL) açmanız önerilir; aynı origin'de CORS hiç devreye girmez.
- Origin'i kısıtlamak isterseniz: `app.use(cors({ origin: ['https://psych-nm.onrender.com'], allowedHeaders: ['Content-Type','X-Admin-Key'] }))`.
- `X-Admin-Key` tarayıcı `localStorage`'ında tutulur. Ortak kullanılan bir bilgisayarda "Kes" + tarayıcı verilerini temizleme önerilir. Anahtar sızarsa Render'dan değiştirip yeniden deploy edin (eski anahtar anında geçersiz olur).
- Yönetici uçları anahtar karşılaştırmasını sabit süreli (`crypto.timingSafeEqual`) yapar.
- `DELETE /users/:id` geri alınamaz; `admin_logs` kaydı kimin ne zaman sildiğini tutar.
- `admin.html` ve `leaderboard.html` içinde hiçbir Supabase anahtarı/bağlantı bilgisi yoktur.

---

## 5. Test ve doğrulama

### Tarayıcıda hızlı kontrol

| URL | Beklenen |
| --- | --- |
| `/health` | `{"status":"ok","users_table":"ok"}` |
| `/leaderboard.html?mock=1` | Örnek 40 kullanıcı, madalyalar, filtre, limit seçici |
| `/admin.html?mock=1` | "Bağlı (demo)", arama, puan ekleme, silme onayı, loglar |

### Sunucu sözleşmesi için curl

```bash
# Yetkisiz erişim → 401 yetkisiz
curl -i https://psych-nm.onrender.com/users

# Yetkisiz puan denemesi → 401
curl -i -X POST https://psych-nm.onrender.com/points \
  -H 'Content-Type: application/json' -d '{"user_id":"...","amount":5}'

# Yetkili arama
curl -s "https://psych-nm.onrender.com/users?q=mio&limit=20" -H "X-Admin-Key: $ADMIN_KEY"

# Puan ekleme
curl -s -X POST https://psych-nm.onrender.com/points \
  -H "X-Admin-Key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"user_id":"<uuid>","amount":10,"reason":"etkinlik"}'

# Eski liderlik formatı
curl -s "https://psych-nm.onrender.com/leaderboard?raw=1"
```

### Bu değişiklikte test edilenler

Sunucu tarafı 36 test + arayüz tarafı 67 test (jsdom ile gerçek DOM, sahte Supabase istemcisi ve gerçek yerel Express sunucusu üzerinden) çalıştırıldı; hepsi geçti:

- **Mevcut uçlar bozulmadı**: `/health` 200; `/register` 200 + 409 (aynı ad); `/login` 200 (hash dönmüyor), 401, 404; `/score` 200 + 400 (eksik alan); `/leaderboard?raw=1` eski formatı korudu.
- **Yetkilendirme**: `/users`, `/users/:id`, `/points`, `/admin/logs`, `DELETE /users/:id` → anahtarsız/yanlış anahtar **401 `yetkisiz`**; `ADMIN_KEY` boşken **503**.
- **`GET /users`**: 200 liste, `ILIKE %q%` filtresi, `limit`, hash yok.
- **`GET /users/:id`**: 200 + `scores_count`, geçersiz id 400, olmayan kullanıcı 404.
- **`POST /points`**: +10 → 200 `points:10`; −100 → 200 `points:0, clamped:true, applied_amount:-10`; 0/`"abc"` → 400; olmayan kullanıcı 404.
- **`GET /admin/logs`**: 200, `add_points`/`set_points`/`delete_user` kayıtları, `admin_ip` dolu.
- **`DELETE /users/:id`**: 200 `{success:true}`; kullanıcı 404'e düştü; score satırları da silindi; log yazıldı.
- **`GET /leaderboard`**: 200 kullanıcı bazlı format (`rank`, `points`, `songs_played`, `best_score`, `updated_at`), `limit` çalışıyor; `?raw=1` eski çıktı.
- **Arayüzler (mock)**: liderlik tablosu 25 satır/madalya/filtre/limit + `?user=` vurgusu; admin panelde demo bağlantı, canlı arama, +10 puan onayı → 138, silme onayı (ad yazılmadan kapalı), yerel geçmiş.
- **Arayüzler (gerçek API)**: bağlan → liste/arama/detay; +5 puan sunucuda doğrulandı; −50 → 0 tabanı; sunucu logları göründü; kullanıcı silme sonrası sunucuda 404; yanlış anahtar → "Salt okunur" + `HTTP 401 yetkisiz`; kapalı sunucu → uyarı bandı + işlemler kapalı.
- **Demo verisi**: `?mock=1` ile hiç ağ isteği yapılmadan tüm akışlar çalışıyor.

### Notlar / bilinen sınırlar

- API'de "kullanıcı adına göre sıralama" yok; `?user=` yalnızca yüklenen ilk N içinde vurgu yapar (kişi listede yoksa bilgi kutusu gösterilir).
- `POST /points` puanı okuyup yazar; aynı kullanıcıya eşzamanlı iki yönetici işlemi yarışabilir. Gerekirse Supabase RPC (`points = GREATEST(0, points + amount)`) ile atomik hale getirilebilir.
- İlk 50 dışındaki kullanıcıların `songs_played`/`best_score` değerleri leaderboard yanıtına dahil edilmez (istenen `limit` kadar kullanıcı için score satırları sayfalanarak toplanır).
