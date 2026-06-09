const { chromium } = require("playwright");
const fs = require("fs");

const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwpaT9ttink4eLweVhZLLlfu3a9CdhrGXhZsQk7eFDkHiHa1kSNZXsW-_qzmXOXiY6lyA/exec";

// CI/Linux で必要な最小限のフラグ
// --single-process は削除（Linuxでプロセス分離が崩れてクラッシュ増加）
const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage", // GitHub Actions の /dev/shm は 64MB 固定のため必須
  "--disable-gpu",
  "--no-first-run",
  "--no-zygote",
  "--disable-extensions",
];

const KEYWORDS = [
  "シリコンラップ",
  "バスボム",
  "バランスボード",
  "ベビーバスローブ",
  "メッシュキャップ",
  "ベビー食器",
  "ベビーカトラリー",
  "赤ちゃん食器",
  "ベビーヘルメット",
  "シリコン食器",
  "ベビーサークル",
  "ベッドガード",
  "ベビーモニター",
  "搾乳機",
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function createBrowser() {
  return chromium.launch({ headless: true, args: BROWSER_ARGS });
}

// 失敗時は false を返す（例外を投げない）
async function gotoWithRetry(page, url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return true;
    } catch (e) {
      console.log(`  [RETRY ${attempt}/2] ${e.message.slice(0, 100)}`);
      if (attempt < 2) await sleep(8000);
    }
  }
  return false;
}

// DOM解析を1回の evaluate に集約（IPC往復をN×5回→1回に削減）
function extractProducts(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-component-type="s-search-result"]')
    ).map(el => ({
      asin:  el.getAttribute("data-asin") || "",
      text:  el.innerText || "",
      title: el.querySelector("h2 span")?.innerText?.trim() || "",
      href:  el.querySelector("h2 a")?.getAttribute("href") || "",
      price: el.querySelector(".a-price .a-offscreen")?.innerText?.trim() || "",
    }))
  );
}

async function runScraper() {
  let browser = await createBrowser();
  const asinMap = {};
  const failed = [];

  for (const keyword of KEYWORDS) {
    let page;

    try {
      // ブラウザがクラッシュ済みなら作り直す
      if (!browser.isConnected()) {
        console.log("[BROWSER] 切断検知 → 再生成");
        browser = await createBrowser();
      }

      page = await browser.newPage({
        viewport: { width: 1366, height: 768 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      });

      await page.setExtraHTTPHeaders({
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
      });

      // page クラッシュを検知（silent crashでループが止まるのを防ぐ）
      let pageCrashed = false;
      page.on("crash", () => {
        pageCrashed = true;
        console.log(`[PAGE CRASH] ${keyword}`);
      });

      console.log(`\n[${keyword}] 開始`);

      const url = `https://www.amazon.co.jp/s?k=${encodeURIComponent(keyword)}`;
      const navOk = await gotoWithRetry(page, url);

      if (!navOk || pageCrashed) {
        console.log(`[SKIP] ナビゲーション失敗 → ブラウザ再生成: ${keyword}`);
        failed.push(keyword);
        // ナビ失敗はブラウザごと捨てて確実に回復
        try { await browser.close(); } catch {}
        browser = await createBrowser();
        continue;
      }

      // ページ描画安定待機（3〜6秒）
      await sleep(3000 + Math.random() * 3000);

      const rawProducts = await extractProducts(page);

      if (rawProducts.length === 0) {
        // CAPTCHAやブロック時に 0件になる
        const html = await page.content().catch(() => "");
        const blocked =
          html.includes("captcha") ||
          html.includes("Robot Check") ||
          html.includes("api-services-support");
        console.log(
          `[WARN] 0件 - ${blocked ? "CAPTCHA/ブロック疑い" : "検索結果なし"}: ${keyword}`
        );
        failed.push(keyword);
        continue;
      }

      console.log(`  → ${rawProducts.length}件取得`);

      let adRank = 0;
      let organicRank = 0;
      let overallRank = 0;

      for (const p of rawProducts) {
        if (!p.asin) continue;

        overallRank++;

        const sponsored =
          p.text.includes("スポンサー") ||
          p.text.includes("Sponsored") ||
          p.text.includes("広告");

        if (sponsored) adRank++;
        else organicRank++;

        const ratingMatch  = p.text.match(/([0-5]\.?[0-9]?)\s*5つ星/);
        const reviewMatch  = p.text.match(/([\d,]+)\s*件の評価/);

        const key = `${keyword}_${p.asin}`;

        if (!asinMap[key]) {
          asinMap[key] = {
            date: new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
            keyword,
            asin:        p.asin,
            title:       p.title,
            productUrl:  p.href ? "https://www.amazon.co.jp" + p.href : "",
            price:       p.price,
            reviewCount: reviewMatch ? reviewMatch[1].replace(/,/g, "") : "",
            rating:      ratingMatch ? ratingMatch[1] : "",
            overallRank: "",
            adRank:      "",
            organicRank: "",
          };
        }

        asinMap[key].overallRank = overallRank;
        if (sponsored) {
          if (!asinMap[key].adRank) asinMap[key].adRank = adRank;
        } else {
          if (!asinMap[key].organicRank) asinMap[key].organicRank = organicRank;
        }
      }

    } catch (e) {
      console.log(`[ERROR] ${keyword}: ${e.message}`);
      failed.push(keyword);
      // 予期しないエラー時もブラウザを確実にリセット
      try { await browser.close(); } catch {}
      browser = await createBrowser();

    } finally {
      if (page) {
        try { await page.close(); } catch {}
      }
    }

    // Amazon への連続リクエスト対策（3〜6秒）
    await sleep(3000 + Math.random() * 3000);
  }

  try { await browser.close(); } catch {}

  // ========== サマリーログ ==========
  const rows = Object.values(asinMap);
  console.log("\n========== 実行結果 ==========");
  console.log(`成功: ${KEYWORDS.length - failed.length}件 / ${KEYWORDS.length}件`);
  if (failed.length > 0) {
    console.log(`失敗キーワード: ${failed.join(", ")}`);
  }

  if (rows.length === 0) {
    console.error("[FATAL] 全キーワードで取得失敗。Amazon側ブロックの可能性大。");
    process.exit(1);
  }

  // ========== CSV出力 ==========
  let csv =
    "date,keyword,asin,title,url,price,reviewCount,rating,overallRank,adRank,organicRank\n";

  for (const r of rows) {
    csv +=
      `"${r.date}",` +
      `"${r.keyword}",` +
      `"${r.asin}",` +
      `"${(r.title || "").replace(/"/g, '""')}",` +
      `"${r.productUrl}",` +
      `"${r.price}",` +
      `"${r.reviewCount}",` +
      `"${r.rating}",` +
      `"${r.overallRank}",` +
      `"${r.adRank}",` +
      `"${r.organicRank}"\n`;
  }

  fs.writeFileSync("result.csv", csv, "utf8");
  console.log(`CSV出力: ${rows.length}件`);

  await sendToGAS(rows);
  console.log("全処理完了");
}

async function sendToGAS(rows) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rows),
      });
      console.log("GAS送信完了:", (await res.text()).slice(0, 200));
      return;
    } catch (e) {
      console.log(`GAS送信失敗 (${attempt}/2): ${e.message}`);
      if (attempt < 2) await sleep(10000);
    }
  }
}

runScraper().catch(e => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
