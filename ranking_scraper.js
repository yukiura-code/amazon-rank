const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const fs = require("fs");
const path = require("path");
const https = require("https");

// ============ 設定 ============
// GAS Webアプリのエンドポイント（このGASが gas_all.gs の TARGET_SPREADSHEET_ID 先の
// スプレッドシートにデータを書き込む。出力先を変える場合は GAS側のIDを変更すること）
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxoUCWOnpxjqjI1RjahC_UgymxonE1PPTdMFEpKEsH8ata-CUE6vqF2Hdf9K_lnPqIG/exec";
const OUTPUT_DIR = __dirname;

// ============ ブランド検出設定 ============
// タイトル・ショップ名にこれらの文字列が含まれていたらヒット（大文字小文字無視）
const TARGET_BRANDS = ["babygoo", "fungoo"];
function isBrandHit(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return TARGET_BRANDS.some(b => lower.includes(b));
}
// ==========================================

const RAKUTEN_PERIODS = [
  { label: "デイリー", path: "daily" },
  { label: "週間",     path: "weekly" },
  { label: "月間",     path: "monthly" },
];

const AMAZON_BABY_URL = "https://www.amazon.co.jp/gp/bestsellers/baby/";

// 楽天 キッズ・ベビー・マタニティ 直下サブカテゴリー（フォールバック）
const RAKUTEN_BABY_SUB_CATEGORIES_FALLBACK = [
  { categoryId: "111078", categoryName: "キッズファッション" },
  { categoryId: "111102", categoryName: "ベビーファッション" },
  { categoryId: "208023", categoryName: "チャイルドシート" },
  { categoryId: "208024", categoryName: "ベビーカー" },
  { categoryId: "208025", categoryName: "抱っこひも・ベビースリング" },
  { categoryId: "208026", categoryName: "ベビー用寝具・ベッド" },
  { categoryId: "208029", categoryName: "ベビー用インテリア・収納用品" },
  { categoryId: "208030", categoryName: "おふろ・バス用品" },
  { categoryId: "208031", categoryName: "おむつ・トイレ用品" },
  { categoryId: "208032", categoryName: "ヘルスケア・衛生用品" },
  { categoryId: "208033", categoryName: "授乳用品・ベビー用食事用品" },
  { categoryId: "200840", categoryName: "キッズ用セーフティグッズ" },
  { categoryId: "200841", categoryName: "ベビー用セーフティグッズ" },
  { categoryId: "208034", categoryName: "キッズ用教材・お道具箱" },
  { categoryId: "208035", categoryName: "ベビー用教材" },
  { categoryId: "551585", categoryName: "キッズコスメ" },
  { categoryId: "551586", categoryName: "名前シール・スタンプ" },
  { categoryId: "111116", categoryName: "マタニティ・ママ用品" },
  { categoryId: "551590", categoryName: "出産祝い・ギフト" },
];

// ---------- GAS送信 ----------
function postToGAS(platform, rows, sheetName) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ platform, rows, sheetName });
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

// ---------- 楽天: サブカテゴリー一覧をサイトマップから取得 ----------
async function getRakutenSubCategories(page) {
  console.log("楽天サブカテゴリー一覧を取得中 (サイトマップ利用)...");
  await page.goto("https://ranking.rakuten.co.jp/sitemap/baby/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const subCategories = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // 直下カテゴリーは <strong><a href="/daily/数字/"> の構造
    const strongLinks = document.querySelectorAll("strong a[href*='/daily/'], b a[href*='/daily/']");
    for (const link of strongLinks) {
      const href = link.getAttribute("href") || "";
      const m = href.match(/\/daily\/(\d+)\/?/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        results.push({
          categoryId: m[1],
          categoryName: link.textContent.trim().replace(/\s+/g, " "),
        });
      }
    }

    // フォールバック
    if (results.length === 0) {
      const contentEl = document.querySelector(".content, #content, main, .rankingArea, .genreList");
      const scope = contentEl || document;
      const allLinks = scope.querySelectorAll("a[href*='/daily/']");
      for (const link of allLinks) {
        const href = link.getAttribute("href") || "";
        const m = href.match(/\/daily\/(\d+)\/?/);
        if (!m) continue;
        const id = m[1];
        if (id === "100533" || seen.has(id)) continue;
        const parentText = link.parentElement?.textContent || "";
        if (!parentText.includes("├") && !parentText.includes("└")) {
          seen.add(id);
          results.push({
            categoryId: id,
            categoryName: link.textContent.trim().replace(/\s+/g, " "),
          });
        }
      }
    }

    return results;
  });

  console.log(`  サブカテゴリー ${subCategories.length}件 取得: ${subCategories.map(c => c.categoryName).join(", ")}`);

  if (subCategories.length === 0) {
    console.log("  ⚠ サイトマップ取得失敗。ハードコードのカテゴリーリストを使用します。");
    return RAKUTEN_BABY_SUB_CATEGORIES_FALLBACK;
  }

  return subCategories;
}

// ---------- 楽天: 特定カテゴリー・期間のランキングをスクレイプ ----------
async function scrapeRakutenRanking(page, categoryId, categoryName, period, dateStr) {
  // パーソナライズ防止: 毎回Cookieをクリアしてゲスト状態を維持
  await page.context().clearCookies();

  const url = `https://ranking.rakuten.co.jp/${period.path}/${categoryId}/`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // フルスクロールして遅延ロード商品も表示させる
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(({ catName, periodLabel, dateStr }) => {
    const results = [];

    // ---- アイテムコンテナを特定 ----
    // 実際のHTML構造: div.rnkRanking_preRank が各商品のコンテナ
    const containerSelectors = [
      ".rnkRanking_preRank",       // 確認済み（メイン）
      ".rnkRanking_after4box",     // 上位コンテナ
      "[class*='rnkRanking_pre']", // クラス名ゆれに対応
      "[class*='rnkRanking_']",    // その他rnkRankingクラス
      // 旧来・フォールバック
      ".rnkItem", "[class*='rnkItem']",
      ".dui-card", "[class*='dui-card']",
      ".searchresultitem",
      "ol li", "ul.ranking li",
    ];

    let items = [];
    for (const sel of containerSelectors) {
      const found = document.querySelectorAll(sel);
      // 2件以上取れたものを採用（ナビ等の誤ヒット排除）
      if (found.length >= 2) {
        items = found;
        break;
      }
    }

    // ---- フォールバック: 順位バッジを持つ要素の親を探す ----
    if (items.length < 2) {
      // 「1位」「2位」などのテキストを持つ要素を探し、その共通の親リストを取得
      const rankBadges = document.querySelectorAll(
        "[class*='rank'] .num, [class*='rank-num'], [class*='rankNum'], " +
        "[class*='position'], [class*='order']"
      );
      if (rankBadges.length >= 2) {
        // 共通の親を特定
        const parent = rankBadges[0].closest("ol, ul, [class*='list'], [class*='List']");
        if (parent) {
          items = parent.children;
        }
      }
    }

    // ---- 各アイテムからデータ抽出 ----
    let rank = 0;
    const seenUrls = new Set();  // 重複除去用（TOP4ボックス等での二重カウント防止）
    const seenRanks = new Set(); // 順位の重複検出用
    for (const item of items) {
      rank++;

      // タイトル: より広いセレクターで取得
      let title = "";
      const titleSelectors = [
        "h2", "h3",
        "[class*='title']", "[class*='Title']", "[class*='name']", "[class*='Name']",
        "a[class*='item']", "a[class*='product']",
      ];
      for (const sel of titleSelectors) {
        const el = item.querySelector(sel);
        if (el && el.textContent.trim().length > 5) {
          title = el.textContent.trim().replace(/\s+/g, " ").substring(0, 200);
          break;
        }
      }
      // タイトルがまだ取れない場合: item内の最も長いテキストを持つリンク
      if (!title) {
        let maxLen = 0;
        item.querySelectorAll("a").forEach(a => {
          const t = a.textContent.trim().replace(/\s+/g, " ");
          if (t.length > maxLen) { maxLen = t.length; title = t.substring(0, 200); }
        });
      }

      // URL & itemCode & shopName
      let productUrl = "", itemCode = "", shopName = "";
      const itemLink = item.querySelector("a[href*='item.rakuten.co.jp']");
      if (itemLink) {
        productUrl = (itemLink.getAttribute("href") || "").split("?")[0];
        const m = productUrl.match(/item\.rakuten\.co\.jp\/([^\/]+)\/([^\/\?]+)/);
        if (m) { itemCode = `${m[1]}:${m[2]}`; shopName = m[1]; }
      }
      // ショップ名テキスト: 家アイコン隣のテキスト (例: "BabyGoo（ベビーグー）楽天市場店")
      let shopNameText = "";
      const shopEl = item.querySelector(
        ".rnkRanking_shopName, [class*='rnkRanking_shop'], [class*='shopName'], " +
        "[class*='shop-name'], [class*='shop_name'], " +
        "[class*='shop'], [class*='Store'], [class*='seller'], " +
        "a[href*='shop.rakuten'], a[href*='.rakuten.co.jp/shop']"
      );
      if (shopEl) shopNameText = shopEl.textContent.trim().replace(/\s+/g, " ");

      // 価格
      let price = "";
      const priceEl = item.querySelector(
        "[class*='price'] .important, [class*='price--'], [class*='Price'], " +
        ".price, [class*='kakaku']"
      );
      if (priceEl) {
        const m = priceEl.textContent.replace(/[,，]/g, "").match(/(\d+)/);
        if (m) price = m[1];
      }

      // 評価
      let rating = "";
      const scoreEl = item.querySelector(
        ".score, [class*='score'], [class*='rating'], [class*='star']"
      );
      if (scoreEl) {
        const m = scoreEl.textContent.match(/(\d+(?:\.\d+)?)/);
        if (m && parseFloat(m[1]) <= 5) rating = m[1];
      }

      // レビュー数
      let reviewCount = "";
      const legendEl = item.querySelector(
        ".legend, [class*='legend'], [class*='review'], [class*='Review']"
      );
      if (legendEl) {
        const m = legendEl.textContent.replace(/[,，]/g, "").match(/(\d+)/);
        if (m) reviewCount = m[1];
      }

      // 順位: div.rnkRanking_dispRank 内の数字テキスト（「位」はspanで別要素）
      // ※ ページ内に複数セクション（TOP4ボックス等）がある場合、
      //    dispRankが重複・不整合になることがあるため、
      //    最終的な順位は「重複除去後の出現順」で振り直す（下記参照）
      let dispRankRaw = "";
      const rankEl = item.querySelector(
        ".rnkRanking_dispRank, [class*='rnkRanking_disp'], " +
        "[class*='rank-num'], [class*='rankNum'], [class*='rank'] .num, .num"
      );
      if (rankEl) {
        const m = rankEl.textContent.replace(/[位\s]/g, "").match(/^(\d+)$/);
        if (m) dispRankRaw = m[1];
      }

      // 重複除去キー（productUrl優先、なければitemCode）
      const dedupKey = productUrl || itemCode;

      if ((title || itemCode) && !(dedupKey && seenUrls.has(dedupKey))) {
        if (dedupKey) seenUrls.add(dedupKey);

        // 順位決定: dispRankが有効かつ未使用ならそれを使用、
        // そうでなければ「重複除去後の出現順」にフォールバック
        let finalRank = results.length + 1;
        if (dispRankRaw) {
          const n = parseInt(dispRankRaw);
          if (!seenRanks.has(n)) {
            finalRank = n;
          }
        }
        seenRanks.add(finalRank);

        results.push({
          date: dateStr,
          platform: "rakuten",
          period: periodLabel,
          category: catName,
          rank: finalRank,
          rankRaw: dispRankRaw,             // 元のdispRank値（デバッグ用）
          itemCode,
          shopName: shopNameText || shopName,
          title,
          productUrl,
          price,
          rating,
          reviewCount,
        });
      }

      if (results.length >= 20) break;
    }

    return results;
  }, { categoryName, periodLabel: period.label, dateStr });

  // ブランドヒットのみ返す（タイトルまたはショップ名テキストで判定）
  const hits = data.filter(r => isBrandHit(r.title) || isBrandHit(r.shopName));

  // ---- フォールバック: 通常スクレイプで0件の場合、ページ全体からブランドリンクを直接探す ----
  if (data.length === 0) {
    console.log(`      ⚠ アイテム取得0件 → ページ全体スキャンに切り替え`);
    const fallbackHits = await page.evaluate(({ catName, periodLabel, dateStr, brands }) => {
      const results = [];
      const seen = new Set();

      // ページ内の全リンクをスキャン
      const allLinks = document.querySelectorAll("a[href*='item.rakuten.co.jp']");
      for (const link of allLinks) {
        const href = (link.getAttribute("href") || "").split("?")[0];
        if (seen.has(href)) continue;

        const linkText = link.textContent.trim().replace(/\s+/g, " ");
        // 親要素のテキスト全体も取得（ショップ名が別要素の場合に対応）
        const parentText = (link.closest("li, div, article, section")?.textContent || "")
          .trim().replace(/\s+/g, " ");

        const combined = (linkText + " " + parentText).toLowerCase();
        const isHit = brands.some(b => combined.includes(b));

        if (isHit) {
          seen.add(href);
          const m = href.match(/item\.rakuten\.co\.jp\/([^\/]+)\/([^\/\?]+)/);
          const itemCode = m ? `${m[1]}:${m[2]}` : "";
          const shopName = m ? m[1] : "";

          // 順位を親コンテナの rnkRanking_dispRank から取得
          const container = link.closest("[class*='rnkRanking_'], li, [class*='item'], [class*='card']");
          let rank = results.length + 1;
          if (container) {
            const rankEl = container.querySelector(".rnkRanking_dispRank, [class*='rnkRanking_disp']");
            if (rankEl) {
              const m = rankEl.textContent.replace(/[位\s]/g, "").match(/^(\d+)$/);
              if (m) rank = parseInt(m[1]);
            } else {
              const rankMatch = container.textContent.match(/(\d+)\s*位/);
              if (rankMatch) rank = parseInt(rankMatch[1]);
            }
          }

          results.push({
            date: dateStr, platform: "rakuten", period: periodLabel, category: catName,
            rank, itemCode, shopName,
            title: linkText.substring(0, 200),
            productUrl: href, price: "", rating: "", reviewCount: "",
          });
        }
      }
      return results;
    }, { catName: categoryName, periodLabel: period.label, dateStr, brands: TARGET_BRANDS });

    return fallbackHits;
  }

  return hits;
}

// ---------- Amazon: ベビー＆マタニティのサブカテゴリー取得 ----------
async function getAmazonBabySubCategories(page) {
  console.log("Amazonベビー＆マタニティ サブカテゴリー取得中...");
  await page.goto(AMAZON_BABY_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const subCategories = await page.evaluate(() => {
    const results = [];
    const seen = new Set();

    const sidebarLinks = document.querySelectorAll(
      "#zg_browseRoot a, .zg_browseRoot a, [id*='browseRoot'] a, " +
      "._p13n-zg-nav-tree-all_style_zg-browse-group__88fbz a, " +
      "[class*='zg-browse'] a, " +
      "a[href*='/gp/bestsellers/baby/']"
    );

    for (const link of sidebarLinks) {
      const href = link.getAttribute("href") || "";
      const m = href.match(/\/gp\/bestsellers\/baby\/(\d+)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        results.push({
          nodeId: m[1],
          categoryName: link.textContent.trim().replace(/\s+/g, " "),
          url: `https://www.amazon.co.jp/gp/bestsellers/baby/${m[1]}`,
        });
      }
    }
    return results;
  });

  console.log(`  サブカテゴリー ${subCategories.length}件 取得`);
  return subCategories;
}

// ---------- Amazon: 特定カテゴリーのランキングをスクレイプ ----------
async function scrapeAmazonRanking(page, categoryUrl, categoryName, dateStr) {
  // パーソナライズ防止: 毎回Cookieをクリアしてゲスト状態を維持
  await page.context().clearCookies();

  await page.goto(categoryUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);

  try {
    await page.waitForSelector(
      ".zg-item-immersion, [class*='zg-item'], .p13n-asin, [class*='p13n-asin']",
      { timeout: 10000 }
    );
  } catch {
    // フォールバックで続行
  }

  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2000);

  const data = await page.evaluate(({ catName, dateStr }) => {
    const results = [];

    const itemSelectors = [
      // 実際のHTML構造で確認済み: id="p13n-asin-index-N" を持つdiv（カード全体）
      "[id^='p13n-asin-index-']",
      // gridItemRoot（li > div構造の親）
      "[id^='gridItemRoot']",
      // 旧来・フォールバック
      ".zg-item-immersion", "[class*='zg-item-immersion']",
      ".p13n-asin", "[class*='p13n-asin']",
      "[data-p13n-asin-metadata]", ".zg_item",
    ];

    let items = [];
    for (const sel of itemSelectors) {
      items = document.querySelectorAll(sel);
      if (items.length > 0) break;
    }

    // 最終フォールバック: data-asin を持つ要素から、十分な情報量を持つ親要素まで遡る
    if (items.length === 0) {
      const asinEls = document.querySelectorAll("div[data-asin]:not([data-asin=''])");
      const seen = new Set();
      const climbed = [];
      asinEls.forEach(el => {
        // a-cardui または gridItemRoot を持つ祖先を探す
        let container = el.closest("[id^='gridItemRoot'], .a-cardui, [class*='cardui'], li.a-list-item");
        if (!container) container = el.parentElement;
        if (container && !seen.has(container)) {
          seen.add(container);
          climbed.push(container);
        }
      });
      items = climbed;
    }

    let rank = 0;
    const seenAsins = new Set(); // 重複除去用
    const seenRanks = new Set(); // 順位の重複検出用
    for (const item of items) {
      rank++;

      // ASIN
      let asin = "";
      // 自身がdata-asinを持つ場合
      if (item.hasAttribute && item.hasAttribute("data-asin")) {
        asin = item.getAttribute("data-asin") || "";
      }
      // 子要素から取得
      if (!asin) {
        const asinEl = item.querySelector("[data-asin]:not([data-asin=''])");
        if (asinEl) asin = asinEl.getAttribute("data-asin") || "";
      }
      if (!asin) {
        const link = item.querySelector('a[href*="/dp/"]');
        if (link) {
          const m = (link.getAttribute("href") || "").match(/\/dp\/([A-Z0-9]{10})/);
          if (m) asin = m[1];
        }
      }
      if (!asin) {
        const metaEl = item.closest("[data-p13n-asin-metadata]");
        if (metaEl) {
          try {
            const meta = JSON.parse(metaEl.getAttribute("data-p13n-asin-metadata") || "{}");
            asin = meta.asin || "";
          } catch {}
        }
      }

      // タイトル
      let title = "";
      const titleEl = item.querySelector(
        "._cDEzb_p13n-sc-css-line-clamp-3_g3dy1, ._cDEzb_p13n-sc-css-line-clamp-4_2q2cc, " +
        "[class*='p13n-sc-truncate'], [class*='line-clamp'], " +
        ".a-size-small.a-link-normal, span.a-size-base, " +
        "[class*='_cDEzb_p13n-sc-css-line-clamp'], " +
        "div[class*='a-text-normal'], " +
        "a[class*='a-link-normal'] span"
      );
      if (titleEl) title = titleEl.textContent.trim().replace(/\s+/g, " ").substring(0, 200);
      if (!title) {
        const anchor = item.querySelector('a[href*="/dp/"]');
        if (anchor) title = anchor.textContent.trim().replace(/\s+/g, " ").substring(0, 200);
      }
      // 最終フォールバック: アイテム内のテキストが最も長いspan/divを使用
      if (!title) {
        let maxLen = 0;
        item.querySelectorAll("span, div").forEach(el => {
          // 子要素を持たない（テキストのみの）要素に限定
          if (el.children.length === 0) {
            const t = el.textContent.trim().replace(/\s+/g, " ");
            if (t.length > maxLen && t.length > 10 && t.length < 250) {
              maxLen = t.length;
              title = t;
            }
          }
        });
      }

      // 順位
      let dispRankRaw = "";
      const rankEl = item.querySelector(
        ".zg-bdg-text, [class*='zg-bdg'], ._cDEzb_p13n-sc-badge-label_aAVlN, [class*='badge-label']"
      );
      if (rankEl) {
        const m = rankEl.textContent.replace(/[#,，]/g, "").match(/(\d+)/);
        if (m) dispRankRaw = m[1];
      }

      // 価格
      let price = "";
      const priceEl = item.querySelector(".a-price .a-offscreen, ._cDEzb_p13n-sc-price_3mJ9Z, [class*='p13n-sc-price']");
      if (priceEl) {
        const m = priceEl.textContent.replace(/[,，]/g, "").match(/(\d+)/);
        if (m) price = m[1];
      }

      // 評価
      let rating = "";
      const ratingEl = item.querySelector('[aria-label*="5つ星のうち"], [aria-label*="out of 5 stars"]');
      if (ratingEl) {
        const label = ratingEl.getAttribute("aria-label") || "";
        const m1 = label.match(/5つ星のうち\s*(\d+(?:\.\d+)?)/);
        const m2 = label.match(/(\d+(?:\.\d+)?)\s*out of 5/);
        if (m1) rating = m1[1];
        else if (m2) rating = m2[1];
      }

      // レビュー数
      let reviewCount = "";
      const reviewEl = item.querySelector(
        "a[href*='customerReviews'] span, [class*='a-size-small'][href*='customerReviews'], .a-link-normal[href*='customerReviews']"
      );
      if (reviewEl) {
        const m = reviewEl.textContent.replace(/[,，]/g, "").match(/(\d+)/);
        if (m) reviewCount = m[1];
      }

      const productUrl = asin ? `https://www.amazon.co.jp/dp/${asin}` : "";

      const dedupKey = asin || productUrl;

      if ((title || asin) && !(dedupKey && seenAsins.has(dedupKey))) {
        if (dedupKey) seenAsins.add(dedupKey);

        let finalRank = results.length + 1;
        if (dispRankRaw) {
          const n = parseInt(dispRankRaw);
          if (!seenRanks.has(n)) {
            finalRank = n;
          }
        }
        seenRanks.add(finalRank);

        results.push({
          date: dateStr,
          platform: "amazon",
          period: "デイリー",
          category: catName,
          rank: finalRank,
          rankRaw: dispRankRaw,
          itemCode: asin,
          shopName: "",
          title,
          productUrl,
          price,
          rating,
          reviewCount,
        });
      }

      if (results.length >= 20) break;
    }
    return results;
  }, { catName: categoryName, dateStr });

  console.log(`      （取得アイテム数: ${data.length}件）`);

  // ブランドヒットのみ返す
  return data.filter(r => isBrandHit(r.title));
}

// ---------- バックアップCSV出力 ----------
function saveBackupCsv(platform, allRows, ts) {
  const csvHeader = ["date","platform","period","category","rank","rankRaw","itemCode","shopName","title","productUrl","price","rating","reviewCount"];
  const csvLines = [csvHeader.join(",")];
  for (const r of allRows) csvLines.push(csvHeader.map(h => csvCell(r[h])).join(","));
  if (!fs.existsSync(path.join(OUTPUT_DIR, "backups"))) fs.mkdirSync(path.join(OUTPUT_DIR, "backups"));
  const csvPath = path.join(OUTPUT_DIR, "backups", `brand_${platform}_${ts}.csv`);
  fs.writeFileSync(csvPath, "\uFEFF" + csvLines.join("\r\n"));
  console.log(`📁 バックアップ: ${csvPath}`);
}

// ---------- GASへ送信 ----------
async function sendToGAS(platform, allRows, sheetName) {
  if (allRows.length === 0) {
    console.log(`📤 送信スキップ (0件) → ${sheetName}`);
    return;
  }
  console.log(`📤 GAS送信中 (${allRows.length}行) → シート: ${sheetName}`);
  const CHUNK = 500;
  for (let i = 0; i < allRows.length; i += CHUNK) {
    try {
      const result = await postToGAS(platform, allRows.slice(i, i + CHUNK), sheetName);
      console.log(`  [${Math.min(i + CHUNK, allRows.length)}/${allRows.length}] ${result}`);
    } catch (e) {
      console.error(`  ✗ GAS送信失敗: ${e.message}`);
    }
  }
}

// ---------- メイン ----------
(async () => {
  const startTime = new Date();
  console.log(`\n====== ブランド検出スクレイパー 開始: ${startTime.toLocaleString("ja-JP")} ======`);
  console.log(`対象ブランド: ${TARGET_BRANDS.join(", ")}`);
  const dateStr = startTime.toISOString().substring(0, 10);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);

  const browser = await chromium.launch({ headless: true });

  // ---- シークレットモード相当の設定 ----
  // storageState を指定しない = Cookie/localStorage/セッション情報なしの
  // 完全にクリーンな状態でコンテキストを作成（ログイン状態を一切持たない）
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    viewport: { width: 1440, height: 900 },
    // storageState: undefined ← 明示的に指定しないことで毎回ゲスト状態
  });

  // 念のため既存Cookieを全クリア（多重実行時の残留対策）
  await context.clearCookies();

  const page = await context.newPage();

  // ===== 楽天ランキング =====
  console.log("\n========== 楽天 ブランド検出 ==========");
  const rakutenHits = [];

  try {
    let subCategories = await getRakutenSubCategories(page);
    if (subCategories.length === 0) {
      console.warn("  ⚠ サブカテゴリー取得失敗。フォールバックリストを使用します。");
      subCategories = [...RAKUTEN_BABY_SUB_CATEGORIES_FALLBACK];
    }

    for (const cat of subCategories) {
      for (const period of RAKUTEN_PERIODS) {
        console.log(`  📂 ${cat.categoryName} / ${period.label}`);
        try {
          const rows = await scrapeRakutenRanking(page, cat.categoryId, cat.categoryName, period, dateStr);
          if (rows.length > 0) {
            rows.forEach(r => console.log(`    🎯 HIT! ${r.rank}位 「${r.title.substring(0, 40)}」`));
            rakutenHits.push(...rows);
          } else {
            console.log(`    - ヒットなし`);
          }
        } catch (e) {
          console.error(`    ✗ エラー: ${e.message}`);
        }
        await page.waitForTimeout(2000 + Math.floor(Math.random() * 1500));
      }
    }

    saveBackupCsv("rakuten", rakutenHits, ts);
    await sendToGAS("rakuten_ranking", rakutenHits, "楽天ブランド検出");
    console.log(`✅ 楽天完了 (ヒット${rakutenHits.length}件)`);

  } catch (e) {
    console.error(`✗ 楽天全体エラー: ${e.message}`);
  }

  // ===== Amazonランキング =====
  console.log("\n========== Amazon ブランド検出 ==========");
  const amazonHits = [];

  try {
    let subCategories = await getAmazonBabySubCategories(page);
    if (subCategories.length === 0) {
      console.warn("  ⚠ サブカテゴリー取得失敗。親カテゴリのみで試みます。");
      subCategories = [{ nodeId: "", categoryName: "ベビー＆マタニティ", url: AMAZON_BABY_URL }];
    }

    for (let i = 0; i < subCategories.length; i++) {
      const cat = subCategories[i];
      console.log(`  [${i + 1}/${subCategories.length}] 📂 ${cat.categoryName}`);
      try {
        const rows = await scrapeAmazonRanking(page, cat.url, cat.categoryName, dateStr);
        if (rows.length > 0) {
          rows.forEach(r => console.log(`    🎯 HIT! ${r.rank}位 「${r.title.substring(0, 40)}」`));
          amazonHits.push(...rows);
        } else {
          console.log(`    - ヒットなし`);
        }
      } catch (e) {
        console.error(`    ✗ エラー: ${e.message}`);
      }
      if (i < subCategories.length - 1) {
        await page.waitForTimeout(3000 + Math.floor(Math.random() * 2000));
      }
    }

    saveBackupCsv("amazon", amazonHits, ts);
    await sendToGAS("amazon_ranking", amazonHits, "Amazonブランド検出");
    console.log(`✅ Amazon完了 (ヒット${amazonHits.length}件)`);

  } catch (e) {
    console.error(`✗ Amazon全体エラー: ${e.message}`);
  }

  await browser.close();
  console.log(`\n====== 全体完了 (${Math.round((new Date() - startTime) / 1000)}秒) ======`);
  console.log(`楽天ヒット: ${rakutenHits.length}件 / Amazonヒット: ${amazonHits.length}件`);
})();