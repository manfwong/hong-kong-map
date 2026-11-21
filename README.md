# 香港智慧城市地圖

一幅可互動的香港地圖。底圖用 [OpenFreeMap](https://openfreemap.org/) 的免費公開服務。地圖顯示十條港鐵重鐵綫和運輸署交通快拍點。

- 點選車站，查看到站班次。資料來自港鐵實時列車服務資訊。
- 點選快拍點，查看該處最新路面照片。資料來自運輸署交通情況快拍圖像。
- 到站班次和快拍照片都先經這幅地圖的共用快取。同一車站約每分鐘向上游取一次，同一快拍約每兩分鐘取一次。瀏覽器不會各自向政府網站查詢。
- 暫時沒有班次或照片時，畫面會直接說明。

輕鐵、高速鐵路，以及仍在興建的車站不在這一版。

## 在自己的電腦運行

需要 Node.js 22.12 或更新版本。

```bash
npm install
npm run dev
```

瀏覽器打開開發伺服器顯示的本機網址。預設埠是 4178。

若要重新下載官方車站表、快拍位置，並用 OpenStreetMap 配對車站座標：

```bash
python3 scripts/prepare_data.py
```

產生的檔案在 `public/data/`，並會更新伺服器允許查詢的車站和快拍名單。日常開啟網頁不會再向 OpenStreetMap 查詢。

## 資料來源

- 底圖：OpenFreeMap 公開樣式 `liberty`，地圖資料來自 OpenStreetMap
- 港鐵車站和路線順序：<https://opendata.mtr.com.hk/data/mtr_lines_and_stations.csv>
- 港鐵到站班次：<https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php>
- 車站座標和路軌曲線：OpenStreetMap。路軌沿真實走線，不是站與站之間的直線
- 交通快拍位置和照片：<https://data.gov.hk/tc-data/dataset/hk-td-tis_2-traffic-snapshot-images>

馬場站不在車站表內，但實時班次接口接受這個站。它已加在東鐵綫上，平日多數顯示「暫無即將到站班次」。

## 共用快取

`/api/schedule?sta=車站編號` 和 `/api/snapshot?key=快拍編號` 只接受內建名單。網址由伺服器自己組成，不會跟隨訪客提供的網址。

同一項資料在有效時間內只向來源取一次。同時到來的請求會共用那一次查詢。來源拒絕或超時後，一分鐘內不會再試，並繼續顯示上一份成功的資料。每分鐘向上游查詢的次數有上限。分頁在背景時，瀏覽器也不會更新。

底圖仍直接使用 OpenFreeMap。那是公開地圖服務，這幅地圖不會把全港地圖磚再複製一份。瀏覽器不能顯示 WebGL2 時，改用 Esri 街道圖，車站和路軌仍然可以點選。

## 發佈到 Cloudflare Workers

開發伺服器和 Cloudflare Worker 用同一套快取。正式發佈用 Cloudflare Workers 免費方案，網址會是 `名稱.你的帳號.workers.dev`。頁面是靜態檔，到站班次和快拍由 Worker 代取並暫存。不要開啟 Workers 付費計劃，也不要購買網域。

```bash
npm run build
npx wrangler deploy
```

`wrangler deploy` 會要求登入你自己的 Cloudflare 帳戶。帳戶請保持免費方案。若登入時被要求付費或升級，先停下來。
