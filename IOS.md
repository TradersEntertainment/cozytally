# CozyTally'yi iPhone'a almak

Bu dosya, Mac açıldığında yapılacakların tamamı. Buraya kadarki her şey
hazırlandı ve web tarafında doğrulandı; **Mac'te derleme ve imzalama
denenmedi**, çünkü bu depo Linux'ta yazıldı — Xcode, simulator ve imzalama
yok. Yani buradaki adımlar "hazırlandı", "denendi" değil. İlk derlemede ufak
tefek şeyler çıkabilir; çıkarsa hata metniyle birlikte söyle.

## Sunucu adresi

Native uygulamaya **sunucunun adresi gömülü** gelir ve ayarlı:
`https://cetele.up.railway.app` (`scripts/build-app.mjs`). Doldurulacak bir
şey yok.

Adres uygulamanın içinde durduğu için değiştirmek **yeni bir sürüm yayınlamak**
demektir. Kendi alan adına geçersen o dosyadaki varsayılanı güncelle ve yeni
sürüm çıkar; Railway adresi çalışmaya devam ettiği için eski sürümler
kırılmaz. Yerelde denemek için: `CT_API_BASE=http://localhost:3000 npm run ios:sync`.

Sunucu tarafında bir şey tanıtman gerekmez: native uygulamanın kökeni
`capacitor://localhost` ve o zaten izinli (`server.js`, `APP_ORIGINS`).

## Adımlar

```bash
git clone <bu depo> && cd cozytally
npm install                       # Capacitor ve eklentiler dahil
npm run ios:sync
npx cap open ios                  # Xcode açılır
```

`ios:sync`, `www/` klasörünü `public/`'ten kurar (tek fark `config.js`),
sonra Xcode projesine kopyalar. `ios/` klasörü depoda hazır duruyor —
Capacitor 8 CocoaPods yerine Swift Package Manager kullandığı için Linux'ta
oluşturulabildi, yani Mac'te `pod install` beklemiyorsun.

## Xcode'da

1. **Signing & Capabilities** → Team olarak kendi Apple hesabını seç.
   Ücretsiz hesapla simulator'da ve kendi telefonunda çalışır; App Store için
   Apple Developer Program ($99/yıl) gerekir.
2. **Bundle Identifier**: `com.cozytally.app` yazıyor. Kendi alan adına göre
   değiştireceksen `capacitor.config.json` içindeki `appId`'yi de aynı yap.
3. ⌘R ile simulator'da çalıştır.

Beklenen: uygulama **kendi paketinden** açılır (yani ağ olmadan da açılır ve
"bağlantı koptu" şeridi gösterir), sonra sunucuya bağlanıp panoyu getirir.

## Neyin çalıştığını nasıl anlarsın

- **Paket yerel mi:** uçak modunu aç, uygulamayı kapatıp aç. Açılıyorsa paket
  yerel demektir. (Açılmıyorsa `www/` doğru kurulmamıştır.)
- **Sunucuyu buluyor mu:** oda kur. Kod geliyorsa API çalışıyor.
- **Soket:** iki cihazda (ya da biri tarayıcıda) aynı odayı aç, birinde bir
  şeye dokun, diğerinde anında görünmeli.
- **Haptik:** bir karta dokun — hafif bir tık. Karşı taraf hamle yaptığında
  **çift** tık gelmeli; ikisini ayırt edebiliyorsan Taptic çalışıyor demektir
  (tarayıcıda iPhone'da hiç hissedilmiyordu).
- **Paylaşım:** odadaki 🔗 düğmesi sistemin paylaşma sayfasını açmalı.

## İkonlar ve açılış ekranı

Hazır. `favicon.svg` — uygulamanın kendi çizimi: gece göküyüzü, hilal, ve
dördü yan yana beşincisi üstünden geçen çetele — 1024×1024 olarak çiziliyor ve
Xcode'un varlık kataloğuna yazılıyor. Açılış ekranı da aynı çizimin uygulamanın
kendi gökyüzü üstünde ortalanmış hali.

```bash
node scripts/make-icons.mjs
```

512'lik PNG büyütülmüyor, SVG doğrudan o ölçüde çiziliyor. **Alfa kanalı
temizleniyor**, çünkü Apple ikonda alfa taşıyan bir PNG'yi kabul etmiyor —
tamamen opak olsa bile kanalın varlığı red sebebi.

## Demo odası ve ekran görüntüleri

```bash
# canlı sunucuda bir demo odası kur (App Review için)
CT_API_BASE=https://cetele.up.railway.app node scripts/seed-demo.mjs

# ekran görüntüleri — yukarıdaki komutun verdiği davet bağıyla
node scripts/store-shots.mjs <davet-bağı>
```

`store-shots/` klasörüne **1290×2796** ve **1242×2688** ölçülerinde beşer
görüntü çıkar: pano, kumbara, evcil hayvan, sohbet, karşılama. Klasör depoya
girmiyor (16 MB) — tek komutla yeniden üretiliyor.

## Başvururken atlanmaması gereken

İncelemeci uygulamayı **tek başına** açar. İki kişilik bir uygulamada bu, "boş
bir ekran gördüm, çalışmıyor" demesiyle sonuçlanır ve bu sık bir red sebebidir.
Odalara yalnızca davetle girildiği için, bağ olmadan gerçekten boş bir ekran
görür.

`seed-demo.mjs` bunu çözmek için var: içinde iki kişinin hayatı olan bir oda
kurar — fotoğraflı hedefleri olan bir kumbara, yarısı oynanmış bir oyun,
beslenmiş bir kedi, işaretlenmiş bir liste, birkaç mesaj — ve bir **davet bağı**
basar. O bağı inceleme notlarına koy, ve şunu yaz:

> Rooms are invite-only. Open the link below to join a room that already has
> two people and their shared board in it. No account is needed; you will be
> asked only for a nickname.

## Henüz yapılmamış olanlar

- **Bildirimler (APNs).** Native uygulamada web-push çalışmaz; sunucuya ikinci
  bir taşıma gerekiyor ve o Apple Developer hesabı ister. O zamana kadar native
  uygulama bildirimsiz çalışır, web sürümü bildirimlerine devam eder.
- **Privacy nutrition labels** — App Store Connect'teki beyan formu. Ne
  saklandığı `public/privacy.html`'de yazıyor; form ondan doldurulur.
- **Yaş derecesi** ve mağaza metinleri.
