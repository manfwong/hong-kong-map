# 香港智慧城市地圖

一幅可互動的香港地圖。底圖用 [OpenFreeMap](https://openfreemap.org/) 的免費公開服務。地圖顯示十條港鐵重鐵綫和運輸署交通快拍點。

- 點選車站，查看到站班次。資料來自港鐵實時列車服務資訊。
- 點選快拍點，查看該處最新路面照片。資料來自運輸署交通情況快拍圖像。
- 暫時沒有班次或照片時，畫面會直接說明。

輕鐵、高速鐵路，以及仍在興建的車站不在這一版。

## 在自己的電腦運行

需要 Node.js 22 或更新版本。

```bash
npm install
npm run dev
```

瀏覽器打開開發伺服器顯示的本機網址。預設埠是 4178。

若要重新下載官方車站表、快拍位置，並用 OpenStreetMap 配對車站座標：

```bash
python3 scripts/prepare_data.py
```

產生的檔案在 `public/data/`。日常開啟網頁不會再向 OpenStreetMap 查詢。

## 資料來源

- 底圖：OpenFreeMap 公開樣式 `liberty`，地圖資料來自 OpenStreetMap
- 港鐵車站和路線順序：<https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv>
- 港鐵到站班次：<https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php>
- 車站座標：OpenStreetMap，以官方車站代碼配對後存檔
- 交通快拍位置和照片：<https://data.gov.hk/tc-data/dataset/hk-td-tis_2-traffic-snapshot-images>

馬場站不在車站表內，但實時班次接口接受這個站。它已加在東鐵綫上，平日多數顯示「暫無即將到站班次」。

## 發佈到 Cloudflare Workers

這一版的預覽在開發伺服器。正式發佈用 Cloudflare Workers 免費方案的靜態資源，網址會是 `名稱.你的帳號.workers.dev`。

頁面是靜態檔。到站班次和快拍照片由瀏覽器直接向政府網站讀取，不經 Worker 程式，也不用資料庫。靜態資源在免費方案不計入每日 10 萬次請求，預計費用是 0 元。不要開啟 Workers 付費計劃，也不要購買網域。

```bash
npm run build
npx wrangler deploy
```

`wrangler deploy` 會要求登入你自己的 Cloudflare 帳戶。帳戶請保持免費方案。若登入時被要求付費或升級，先停下來。
