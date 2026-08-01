# CozyTally 🌙

Yıldızların altında birlikte sayın ✨ — gerçek zamanlı, çok kişilik, tatlı mı tatlı bir takip panosu.

Bir **oda** kurarsın, kısa bir kod çıkar (örn. `luna-mocha-42`). Linki sevdiğin biriyle paylaşırsın;
ikiniz de aynı panoyu **canlı** görürsünüz. Panoya istediğiniz kadar kart eklersiniz:

| Kart | Ne yapar? |
|------|-----------|
| ✏️ **Çetele** | Klasik çetele işaretleriyle sayar, istersen hedef koyarsın |
| 🔥 **Gün Sayacı** | "Kaç gündür?" — seriyi takip eder, en iyi seriyi saklar |
| ⏳ **Ortak Kronometre** | Birlikte süre sayarsınız; başlat/durdur herkeste senkron |
| 🎈 **Geri Sayım** | Özel bir güne kalan süreyi sayar, vakti gelince konfeti 🎉 |
| 💌 **Not** | Birbirinize yapışkan notlar bırakırsınız — kim yazdıysa imzası düşer |
| 💰 **Kumbara** | Birlikte para biriktirin: hedef tutar, %25/50/75/100 seviye yıldızları, hedef fotoğrafı, +/− işlem geçmişi ve para atınca 🪙 yağmuru |
| 📝 **Liste** | Ortak yapılacaklar — herkes madde ekler ve işaretler, hepsi bitince konfeti |
| 🤝 **Beraber** | Ortak seri: herkesin kendi günlük tiki var ama seri odanın. “Herkes” ya da “biri yeter” modu, son 7 günün ızgarası ve birbirinize hediye edebildiğiniz **pas hakkı** — biri günü kaçırdıysa pasını harcayıp onun için örtebilirsin, seri bozulmaz |

**Hazır paketler:** Tek tıkla birden fazla kart kuran şablonlar — 🏖️ *Tatil planı* (geri sayım + bütçe kumbarası + hazırlık listesi), 📦 *Ev taşınma*, 💪 *Sağlıklı yaşam*.

**Hesap (isteğe bağlı):** Kullanıcı adı + şifre ile kayıt olursan odaların hesabına bağlanır ve
telefonda da bilgisayarda da aynı yerden devam edersin. Hesapsız da çalışmaya devam eder —
o zaman odalar sadece o cihazda durur.

Ayrıca her odada:

- 💬 **Kalıcı sohbet** — mesajlar veritabanında saklanır, sonra girince de durur; 📷 fotoğraf da atabilirsiniz
- 🔔 **Push bildirimleri** — odadaki 🔔 düğmesiyle açılır. Kart eklenince/silinince, çetele
  artınca, kumbaraya para girince, listeye madde eklenince, kronometre başlayınca, not
  bırakılınca, mesaj gelince ve kalp gönderilince haber verir. Uygulamaya bakan kişiye
  bildirim gitmez; hızlı tekrarlar kart başına dakikada bire kısılır. Bildirim metni
  alıcının diline göre (TR/EN) yazılır. VAPID anahtarları ilk açılışta üretilip `/data`'da saklanır
- 📱 **PWA** — telefonda "Ana Ekrana Ekle" ile gerçek uygulama gibi kurulur

Hesap yok, şifre yok — sadece takma ad + oda kodu. TR/EN dil desteği var.

## Railway'e kurulum

1. Bu repoyu Railway'de yeni bir servis olarak ekle (GitHub'dan deploy).
2. Servise bir **Volume** ekle ve mount path olarak **`/data`** yaz.
3. Bu kadar! Uygulama SQLite veritabanını `/data/cozytally.db` içinde,
   sohbet fotoğraflarını `/data/uploads/` içinde, bildirim anahtarlarını
   `/data/vapid.json` içinde tutar — deploy'lar arasında hiçbiri kaybolmaz.

> Not: `PORT` değişkenini Railway kendisi verir. Volume başka bir yere mount
> edersen `DATA_DIR` ortam değişkeniyle yolu belirtebilirsin.

## Lokal geliştirme

```bash
npm install
npm start
# http://localhost:3000
```

Lokalde veriler `./data/` klasörüne yazılır.

## Teknik

- **Sunucu:** Node.js + Express + WebSocket (`ws`)
- **Veritabanı:** SQLite (`better-sqlite3`), tek dosya, WAL modu
- **İstemci:** Bağımlılıksız vanilla JS — build adımı yok
- Kronometre ve geri sayımlar sunucu saatine göre senkronlanır
  (istemciler saat farkını `ping/pong` ile düzeltir)

---

# English

CozyTally is a cozy, real-time shared tracking board. Create a **room**, get a short
code like `luna-mocha-42`, share the link — everyone in the room sees the same board
live. Add as many cards as you like: tallies (with optional goals), day-streak
counters, shared stopwatches (start/pause synced for everyone) and countdowns.
No accounts — just a nickname and a room code. Turkish and English UI.

**Deploy on Railway:** create a service from this repo, attach a Volume mounted at
`/data`, done. Data lives in `/data/cozytally.db`. Use the `DATA_DIR` env var if you
mount the volume elsewhere.

**Local dev:** `npm install && npm start`, then open `http://localhost:3000`.
