const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const fs = require("fs");
const path = require("path");
const https = require("https");

// ============ 設定 ============
const KEYWORDS = [
  "シリコンラップ", "バスボム", "バランスボード", "ベビーバスローブ",
  "メッシュキャップ", "ベビー食器", "ベビーカトラリー", "赤ちゃん食器",
  "ベビーヘルメット", "シリコン食器", "ベビーサークル", "ベッドガード",
  "ベビーモニター", "搾乳機",
];

// ============ 商品ラベル識別設定（ベビーモニターのみ例外） ============
// 同じ検索キーワードで複数の自社商品を別々に記録したい場合にここに追記する
// Amazon: ASINが確定しているのでASINで識別（確実）
// 楽天: タイトルに含まれる文字列の組み合わせで識別（上から順に評価し最初にマッチしたlabelを使用）
const PRODUCT_LABEL_MAP = {
  "ベビーモニター": {
    amazon: {
      "B0DKX8M9RX": "ベビーモニター",
      "B0G1YSFWH4": "ハイブリッドベビーモニター",
    },
    rakuten: [
      { contains: ["2Way", "ハイブリッド"], label: "ハイブリッドベビーモニター" },
      { contains: ["BabyGoo"],             label: "ベビーモニター" },
    ],
  },
};
// =====================================================================

const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbyc5_a9-hP8aj_LtajTmx_ZznC49Ehd15P0dOhZUa_ZfKXd5e3y2Ais2AtSNFuPHSRDpw/exec";
const OUTPUT_DIR = __dirname;
// ==============================

function applyKeywordVariants(rows, platform) {
  return rows.map(row => {
    const map = PRODUCT_LABEL_MAP[row.keyword];
    if (!map) return row;

    // Amazon: ASINで確定
    if (platform === "amazon" && map.amazon && row.asin && map.amazon[row.asin]) {
      return { ...row, keyword: map.amazon[row.asin] };
    }

    // 楽天: タイトルの文字列で識別
    if (platform === "rakuten" && map.rakuten) {
      for (const rule of map.rakuten) {
        if (rule.contains.every(t => row.title.includes(t))) {
          return { ...row, keyword: rule.label };
        }
      }
    }

    return row;
  });
}

// ---------- Amazon ----------
async function scrapeAmazon(page, keyword, dateStr) {
  // 最大3回まで試行: 広告0件ならリロードして再取得
  let data = [];
  let attemptCount = 0;
  const maxAttempts = 3;

  while (attemptCount < maxAttempts) {
    attemptCount++;

    if (attemptCount === 1) {
      await page.goto(
        `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}`,
        { waitUntil: "domcontentloaded" }
      );
    } else {
      // リトライ時: ランダムに長めに待ってリロード
      console.log(`    広告0件のためリトライ (${attemptCount}回目)`);
      await page.waitForTimeout(8000 + Math.floor(Math.random() * 5000));
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(7000);

    try {
      await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 15000 });
    } catch {
      if (attemptCount >= maxAttempts) return [];
      continue;
    }

    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 500) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 200));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(2000);

    data = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-component-type="s-search-result"]');
      return Array.from(items).map((el) => {
        // ASIN
        let asin = el.getAttribute("data-asin") || "";
        if (!asin) {
          const inner = el.querySelector("[data-asin]");
          if (inner) asin = inner.getAttribute("data-asin") || "";
        }
        if (!asin) {
          const link = el.querySelector('a[href*="/dp/"]');
          if (link) {
            const m = link.getAttribute("href").match(/\/dp\/([A-Z0-9]{10})/);
            if (m) asin = m[1];
          }
        }
        if (!asin) {
          const sspa = el.querySelector('a[href*="/sspa/click"]');
          if (sspa) {
            const m = sspa.getAttribute("href").match(/%2Fdp%2F([A-Z0-9]{10})/);
            if (m) asin = m[1];
          }
        }

        // スポンサー判定
        const sspaLink = el.querySelector('a[href*="/sspa/click"]');
        const hasAdHolder = !!el.querySelector(".AdHolder") || el.classList.contains("AdHolder");
        const hasPuisSponsored = !!el.querySelector('[class*="puis-sponsored-label-text"]') ||
                                 !!el.querySelector('[class*="puis-sponsored-label"]') ||
                                 !!el.querySelector('[class*="sponsored-label"]') ||
                                 !!el.querySelector('[class*="s-sponsored-info"]');
        let hasSponsoredText = false;
        const labelEls = el.querySelectorAll(
          ".puis-label-popover-default, .a-size-mini, .a-size-micro, [class*='label'], [aria-label*='スポンサー'], [aria-label*='Sponsored']"
        );
        for (const lEl of labelEls) {
          const t = (lEl.textContent || "").trim();
          const aria = lEl.getAttribute("aria-label") || "";
          if (t === "スポンサー" || t === "Sponsored" || aria.includes("スポンサー") || aria.includes("Sponsored")) {
            hasSponsoredText = true;
            break;
          }
        }
        const isSponsored = !!sspaLink || hasAdHolder || hasPuisSponsored || hasSponsoredText;

        const title = el.querySelector("h2 span")?.textContent?.trim() || "";
        const productUrl = asin ? `https://www.amazon.co.jp/dp/${asin}` : "";

        let price = "";
        const priceEl = el.querySelector(".a-price .a-offscreen");
        if (priceEl) {
          const m = priceEl.textContent.replace(/[,，]/g, "").match(/(\d+)/);
          if (m) price = m[1];
        }

        let rating = "";
        const ratingEl = el.querySelector('[aria-label*="5つ星のうち"], [aria-label*="out of 5 stars"]');
        if (ratingEl) {
          const label = ratingEl.getAttribute("aria-label") || "";
          const m1 = label.match(/5つ星のうち\s*(\d+(?:\.\d+)?)/);
          const m2 = label.match(/(\d+(?:\.\d+)?)\s*out of 5/);
          if (m1) rating = m1[1];
          else if (m2) rating = m2[1];
        }
        if (!rating) {
          const altEls = el.querySelectorAll(".a-icon-alt");
          for (const altEl of altEls) {
            const text = altEl.textContent || "";
            const m1 = text.match(/5つ星のうち\s*(\d+(?:\.\d+)?)/);
            const m2 = text.match(/(\d+(?:\.\d+)?)\s*out of 5/);
            if (m1) { rating = m1[1]; break; }
            if (m2) { rating = m2[1]; break; }
          }
        }
        if (!rating) {
          const starEl = el.querySelector("[class*='a-star-']");
          if (starEl) {
            const cls = starEl.className || "";
            const m = cls.match(/a-star-(\d)-(\d)/);
            if (m) rating = `${m[1]}.${m[2]}`;
            else {
              const m2 = cls.match(/a-star-medium-(\d)/);
              if (m2) rating = `${m2[1]}.0`;
            }
          }
        }

        let reviewCount = "";
        const ratingLink = el.querySelector("a[href*='customerReviews'], a[href*='#customerReviews']");
        if (ratingLink) {
          const m = ratingLink.textContent.replace(/[,，]/g, "").match(/(\d+)/);
          if (m) reviewCount = m[1];
        }
        if (!reviewCount) {
          const cntEl = el.querySelector('[aria-label*="個の評価"], [aria-label*="ratings"]');
          if (cntEl) {
            const m = (cntEl.getAttribute("aria-label") || "").replace(/[,，]/g, "").match(/(\d+)/);
            if (m) reviewCount = m[1];
          }
        }

        return { asin: asin || "", title, productUrl, price, rating, reviewCount, isSponsored };
      });
    });

    // 1件でも広告が取れたら成功、なければリトライへ
    const hasAnyAd = data.some(d => d.isSponsored);
    if (hasAnyAd) break;
    if (attemptCount >= maxAttempts) break;
  }

  return assignRanks(data, keyword, dateStr);
}

// ---------- 楽天 ----------
async function scrapeRakuten(page, keyword, dateStr) {
  const url = `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const itemSelectors = [".searchresultitem", "[class*='searchresultitem']", ".dui-card"];
  let foundSelector = null;
  for (const sel of itemSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      foundSelector = sel;
      break;
    } catch {}
  }
  if (!foundSelector) return [];

  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 200));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2000);

  const data = await page.evaluate((selector) => {
    const items = document.querySelectorAll(selector);
    return Array.from(items).map((el) => {
      // 商品URL & itemCode
      let productUrl = "", itemCode = "";
      const titleLink = el.querySelector("a[href*='item.rakuten.co.jp']") ||
                        el.querySelector("h2 a") ||
                        el.querySelector("a");
      if (titleLink) {
        productUrl = (titleLink.getAttribute("href") || "").split("?")[0];
        const m = productUrl.match(/item\.rakuten\.co\.jp\/([^\/]+)\/([^\/\?]+)/);
        if (m) itemCode = `${m[1]}:${m[2]}`;
      }

      // タイトル(先頭の[PR]は除去)
      let titleRaw = "";
      const titleEl = el.querySelector("h2") ||
                      el.querySelector("[class*='title']") ||
                      el.querySelector("[class*='Title']");
      if (titleEl) titleRaw = titleEl.textContent.trim();
      if (!titleRaw && titleLink) titleRaw = titleLink.textContent.trim();
      titleRaw = titleRaw.replace(/\s+/g, " ");

      // PR判定
      const fullText = el.textContent || "";
      const isSponsored =
        fullText.includes("[PR]") ||
        fullText.includes("【PR】") ||
        titleRaw.startsWith("[PR]") ||
        titleRaw.startsWith("【PR】");

      // 表示用タイトル
      const title = titleRaw
        .replace(/^\[PR\]\s*/, "")
        .replace(/^【PR】\s*/, "")
        .substring(0, 200);

      // 価格
      let price = "";
      const priceEl = el.querySelector("[class*='price'] .important") ||
                      el.querySelector("[class*='price--']") ||
                      el.querySelector("[class*='Price']");
      if (priceEl) {
        const m = priceEl.textContent.replace(/[,，]/g, "").match(/(\d+)/);
        if (m) price = m[1];
      }

      // 星評価: <span class="score">4.56</span>
      let rating = "";
      const scoreEl = el.querySelector(".dui-rating .score") ||
                      el.querySelector("[class*='score']");
      if (scoreEl) {
        const m = scoreEl.textContent.match(/(\d+(?:\.\d+)?)/);
        if (m) rating = m[1];
      }

      // レビュー数: <span class="legend">(4,911件)</span>
      let reviewCount = "";
      const legendEl = el.querySelector(".dui-rating-filter .legend") ||
                       el.querySelector("a[href*='review.rakuten'] .legend") ||
                       el.querySelector(".legend");
      if (legendEl) {
        const m = legendEl.textContent.replace(/[,，]/g, "").match(/(\d+)/);
        if (m) reviewCount = m[1];
      }

      return { asin: itemCode, title, productUrl, price, rating, reviewCount, isSponsored };
    }).filter(x => x.title || x.asin);
  }, foundSelector);

  return assignRanks(data, keyword, dateStr);
}

// ---------- 共通: AD/organic 連番付与 ----------
function assignRanks(data, keyword, dateStr) {
  let adCounter = 0, orgCounter = 0;
  return data.map(item => {
    let adRank = "", organicRank = "";
    if (item.isSponsored) { adCounter++; adRank = adCounter; }
    else { orgCounter++; organicRank = orgCounter; }
    return {
      date: dateStr, keyword,
      asin: item.asin, title: item.title, productUrl: item.productUrl,
      price: item.price, rating: item.rating, reviewCount: item.reviewCount,
      adRank, organicRank,
    };
  });
}

// ---------- GAS送信 ----------
function postToGAS(platform, rows) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ platform, rows });
    const url = new URL(GAS_WEBAPP_URL);
    const options = {
      method: "POST", hostname: url.hostname, path: url.pathname + url.search,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 302 && res.headers.location) {
        https.get(res.headers.location, (res2) => {
          let chunks = ""; res2.on("data", d => chunks += d);
          res2.on("end", () => resolve(chunks));
        }).on("error", reject);
        return;
      }
      let chunks = ""; res.on("data", d => chunks += d);
      res.on("end", () => resolve(chunks));
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------- プラットフォーム実行 ----------
async function runPlatform(platform, scraperFn, page, dateStr) {
  console.log(`\n========== ${platform.toUpperCase()} ==========`);
  const allRows = [];
  for (let i = 0; i < KEYWORDS.length; i++) {
    const kw = KEYWORDS[i];
    console.log(`[${i + 1}/${KEYWORDS.length}] "${kw}"`);
    try {
      const rawItems = await scraperFn(page, kw, dateStr);
      const items = applyKeywordVariants(rawItems, platform);
      let ads = 0, orgs = 0;
      for (const it of items) { allRows.push(it); if (it.adRank !== "") ads++; else orgs++; }
      console.log(`  ✓ 全${items.length}件 (広告${ads} / 自然${orgs})`);
    } catch (e) {
      console.error(`  ✗ エラー: ${e.message}`);
    }
    if (i < KEYWORDS.length - 1) {
      await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
    }
  }

  // バックアップCSV
  const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
  const csvHeader = ["date","keyword","asin","title","productUrl","price","rating","reviewCount","adRank","organicRank"];
  const csvLines = [csvHeader.join(",")];
  for (const r of allRows) csvLines.push(csvHeader.map(h => csvCell(r[h])).join(","));
  if (!fs.existsSync(path.join(OUTPUT_DIR, "backups"))) fs.mkdirSync(path.join(OUTPUT_DIR, "backups"));
  const csvPath = path.join(OUTPUT_DIR, "backups", `${platform}_${ts}.csv`);
  fs.writeFileSync(csvPath, "\uFEFF" + csvLines.join("\r\n"));
  console.log(`📁 ${csvPath}`);

  // GAS送信
  console.log(`📤 GAS送信中... (${allRows.length}行)`);
  try {
    const CHUNK = 500;
    for (let i = 0; i < allRows.length; i += CHUNK) {
      const result = await postToGAS(platform, allRows.slice(i, i + CHUNK));
      console.log(`  [${Math.min(i + CHUNK, allRows.length)}/${allRows.length}] ${result}`);
    }
    console.log(`✅ ${platform} 送信完了`);
  } catch (e) {
    console.error(`✗ GAS送信失敗: ${e.message}`);
  }
}

// ---------- メイン ----------
(async () => {
  const startTime = new Date();
  console.log(`開始: ${startTime.toLocaleString("ja-JP")}`);
  const dateStr = startTime.toISOString().substring(0, 10);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  await runPlatform("amazon", scrapeAmazon, page, dateStr);
  await runPlatform("rakuten", scrapeRakuten, page, dateStr);

  await browser.close();
  console.log(`\n全体完了 (${Math.round((new Date() - startTime) / 1000)}秒)`);
})();