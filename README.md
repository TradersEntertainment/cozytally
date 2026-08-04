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
| 💌 **Not** | Birbirinize yapışkan notlar bırakırsınız — kim yazdıysa imzası düşer. Uzun notlar kâğıdın içinde kaydırılır, altına yorum yazılabilir |
| 💰 **Kumbara** | Birlikte para biriktirin. **Kademeli hedefler:** tek kumbaraya birden fazla hedef koyabilirsin (kira → okul → araba), her birinin kendi tutarı, adı ve fotoğrafı olur. Kumbara **şelale gibi sırayla dolar**: önce 1. hedef kendi tutarını alır, ancak o bittikten sonra artan para 2.'ye geçer — sıradaki hedef ödenmeden alttakine pay düşmez. Her adımda "17.250/25.000₺" gibi kendi payını görürsün. Ayrıca aktif hedefe göre %25/50/75/100 yaklaşma yıldızları, kim ne kadar koydu gösteren katkı yarışı, +/− işlem geçmişi ve para atınca 🪙 yağmuru |
| 📝 **Liste** | Ortak yapılacaklar — herkes madde ekler ve işaretler, hepsi bitince konfeti |
| 🤝 **Beraber** | Ortak seri: herkesin kendi günlük tiki var ama seri odanın. “Herkes” ya da “biri yeter” modu, son 7 günün ızgarası ve birbirinize hediye edebildiğiniz **pas hakkı** — biri günü kaçırdıysa pasını harcayıp onun için örtebilirsin, seri bozulmaz |
| 🎲 **Oyun** | Sıra tabanlı mini oyunlar — dördü de aynı anda açık olabilir: ⭕ **XOX**, 🔵 **Dört Taş**, ⬜ **Nokta-Kutu** ve 🤥 **İki Doğru Bir Yalan**. Aynı anda çevrimiçi olmanız gerekmez: hamleni yaparsın, karşı tarafa “sıra sende” bildirimi gider, o müsait olunca oynar. Kim kaç tur aldı üstte durur, kazananda konfeti patlar, “yeni tur” ile kaldığınız yerden devam edersiniz. Kartın başındaki **?** ile nasıl oynandığını gösteren canlı bir tanıtım açılır, altındaki kutudan da **oynarken yorumlaşabilirsiniz** |

**Sıralama:** Kartlar başlıklarındaki ≡ tutamağından basılı tutulup sürüklenerek istediğin
sıraya dizilir (klavyede tutamağa odaklanıp ↑/↓ de olur). Yeni eklenen kartlar panonun
en üstüne gelir.

**Hazır paketler:** Tek tıkla birden fazla kart kuran şablonlar — 🏖️ *Tatil planı* (geri sayım + bütçe kumbarası + hazırlık listesi), 📦 *Ev taşınma*, 💪 *Sağlıklı yaşam*.

**Hesap (isteğe bağlı):** Kullanıcı adı + şifre ile kayıt olursan odaların hesabına bağlanır ve
telefonda da bilgisayarda da aynı yerden devam edersin. Hesapsız da çalışmaya devam eder —
o zaman odalar sadece o cihazda durur.

Ayrıca her odada:

- 💬 **Kalıcı sohbet** — mesajlar veritabanında saklanır, sonra girince de durur; 📷 fotoğraf da atabilirsiniz.
  Gönderdiğin mesajın altında önce sönük bir ✓ (ulaştı) durur, karşı taraf sohbeti açınca yerini onun
  avatarına bırakır — avatar hep gördüğü **son** mesajın altındadır. Uygulama arka plandayken ya da sohbet
  kapalıyken "gördüm" denmez
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

### Diskte şifreleme (`CT_SECRET`)

Servise **`CT_SECRET`** adında uzun ve rastgele bir ortam değişkeni eklersen
(örn. `openssl rand -base64 32` çıktısı), yazılan her şey diske **AES-256-GCM**
ile şifrelenmiş olarak kaydedilir: oda adları, kart başlıkları ve içerikleri,
notlar, liste maddeleri, sohbet mesajları ve yüklenen fotoğraflar. Veritabanı
dosyasını ya da bir yedeği eline geçiren biri yalnızca şifreli veri görür.

**Neyi korur:** çalınan/yanlışlıkla paylaşılan volume anlık görüntüsünü, unutulmuş
bir yedeği, diski doğrudan okuyan birini.
**Neyi korumaz:** hem diske **hem de ortam değişkenlerine** erişebilen birini.
Anahtar orada durduğu için uygulama şifreyi çözebiliyor; çözebiliyorsa aynı
yetkiye sahip biri de çözebilir. Bunun tek gerçek çözümü içeriği tarayıcıda
şifrelemektir (uçtan uca).

Anahtarı sonradan eklemek güvenlidir: daha önce düz metin yazılmış kayıtlar
okunmaya devam eder, yeni yazılanlar şifrelenir. **Anahtarı kaybedersen ya da
değiştirirsen, onunla yazılmış içerik geri gelmez** — bir yere kaydet.

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
- **Oyun kuralları** tek bir yerde (`public/games.js`): oyunun hakemi sunucudur,
  tarayıcı sadece sunucudan gelen tahtayı çizer ve hamle ister, hiçbir hamlenin
  geçerli olup olmadığına kendisi karar vermez. "İki Doğru Bir Yalan"da
  hangisinin yalan olduğu, tahmin yapılana kadar tarayıcıya hiç gönderilmez
- **? tanıtımı** aynı kural modülünü tarayıcıda çalıştırır: gösterilen maç
  gerçekten oynanır, uydurma bir çizim değil — kurallar değişirse tanıtım da
  kendiliğinden değişir
- Kronometre ve geri sayımlar sunucu saatine göre senkronlanır
  (istemciler saat farkını `ping/pong` ile düzeltir)
- **Cam iki türlü:** Yerinde duran yüzeyler (başlık, alt çubuk, kâğıtlar, sohbet)
  gerçek `backdrop-filter` kullanır; kaydırılan kartlar aynı görüntüyü veren
  hazır bir malzeme kullanır. Kartlarda canlı bulanıklık varken telefonda pano
  ~30 FPS'te kayıyordu, malzemeyle 60 FPS'te kayıyor
- **Fotoğraflar seçilir seçilmez** küçültülüp sunucuya gider (sırayla, tek tek);
  kaydete basınca kart beklemeden oluşur, geciken fotoğraflar hazır oldukça
  kartın üstüne oturur

---

# English

CozyTally is a cozy, real-time shared tracking board. Create a **room**, get a short
code like `luna-mocha-42`, share the link — everyone in the room sees the same board
live. Add as many cards as you like: tallies (with optional goals), day-streak
counters, shared stopwatches (start/pause synced for everyone), countdowns, notes,
checklists and piggy banks. A piggy bank can carry several goals, each with its own
price and photo — the pot fills them in order, so nothing spills into the next goal
until the one before it is fully paid off.
No accounts — just a nickname and a room code. Turkish and English UI.

**Deploy on Railway:** create a service from this repo, attach a Volume mounted at
`/data`, done. Data lives in `/data/cozytally.db`. Use the `DATA_DIR` env var if you
mount the volume elsewhere.

**Local dev:** `npm install && npm start`, then open `http://localhost:3000`.
