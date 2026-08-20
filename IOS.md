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

## Henüz yapılmamış olanlar

- **Bildirimler (APNs).** Native uygulamada web-push çalışmaz; sunucuya ikinci
  bir taşıma gerekiyor ve o Apple Developer hesabı ister. Hesap alınınca
  yapılacak. O zamana kadar native uygulama bildirimsiz çalışır, web sürümü
  bildirimlerine devam eder.
- **İkonlar ve açılış ekranı.** Şu an Capacitor'ın varsayılanları. Sıradaki iş.
- **App Store ekran görüntüleri ve inceleme notları.** Sıradaki iş.

## Başvururken atlanmaması gereken

İncelemeci uygulamayı **tek başına** açar. İki kişilik bir uygulamada bu, "boş
bir ekran gördüm, çalışmıyor" demesiyle sonuçlanır ve bu sık bir red sebebidir.
Başvuruya **içi dolu bir demo odası** ve o odaya girmiş bir hesabın bilgileri
konmalı; inceleme notlarında davet bağıyla girildiği de yazılmalı.
