const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}


/* =========================================================
   TELEGRAM USER
   ========================================================= */

const telegramUser =
  tg?.initDataUnsafe?.user || null;


/* =========================================================
   CATEGORIES
   ========================================================= */

const categories = [
  { name: "Oils", icon: "🛢️" },
  { name: "Orals", icon: "💪" },
  { name: "Pharma", icon: "💊" },
  { name: "Peps", icon: "⚡" }
];


const sectionOrder = {

  Oils: [
    "Oils",
    "Pre-Workout Injectables",
    "Blends"
  ],

  Orals: [
    "Tubs",
    "Pouches"
  ],

  Pharma: [
    "Cardiovascular",
    "Metabolic",
    "Hormones & Related",
    "Sleep",
    "Neurology & Wakefulness",
    "Sexual Health",
    "Hair & Skin",
    "Other Pharma"
  ],

  Peps: [
    "Recovery Research",
    "Metabolic Research",
    "Copper Peptide",
    "Other Peptides",
    "Supplies"
  ]
};


/* =========================================================
   SHOP STATE
   ========================================================= */

let products = [];

const basket = {};

let currentCategory =
  categories[0].name;

let appliedCode = null;

let appliedStoreCredit = null;


/* =========================================================
   MONEY
   ========================================================= */

const money = p =>
  `£${(Number(p || 0) / 100).toFixed(2)}`;


/* =========================================================
   CART TELEMETRY
   ========================================================= */

function postCartEvent(
  productId,
  action
) {

  fetch(
    "/api/cart-events",
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        productId,
        action
      })
    }
  ).catch(() => {});
}


/* =========================================================
   STOCK BADGE
   ========================================================= */

function stockBadge(
  stock,
  unit = "items"
) {

  if (
    stock === null ||
    stock === undefined
  ) {
    return `
      <span class="stock low">
        Stock not entered
      </span>
    `;
  }


  if (stock <= 0) {
    return `
      <span class="stock out">
        Out of stock
      </span>
    `;
  }


  if (stock <= 10) {
    return `
      <span class="stock low">
        ${stock} ${unit} left
      </span>
    `;
  }


  return `
    <span class="stock good">
      ${stock} ${unit} in stock
    </span>
  `;
}


/* =========================================================
   CATEGORY TABS
   ========================================================= */

function renderTabs() {

  const tabs =
    document.getElementById(
      "tabs"
    );

  if (!tabs) return;


  tabs.innerHTML =
    categories.map(c => `

      <button
        class="tab ${
          c.name === currentCategory
            ? "active"
            : ""
        }"
        data-category="${c.name}"
      >
        ${c.name} ${c.icon}
      </button>

    `).join("");


  document
    .querySelectorAll(
      "[data-category]"
    )
    .forEach(btn => {

      btn.addEventListener(
        "click",
        () => {

          currentCategory =
            btn.dataset.category;

          render();

          window.scrollTo({
            top: 0,
            behavior: "smooth"
          });
        }
      );

    });
}


/* =========================================================
   PRODUCT CARD
   ========================================================= */

function shopCard(p) {

  const qty =
    basket[p.id] || 0;

  return `

    <div class="product">

      <div>

        <h3>
          ${p.name}
        </h3>

        ${
          p.subtitle
            ? `
              <div class="sub">
                ${p.subtitle}
              </div>
            `
            : ""
        }

        ${stockBadge(
          p.stock,
          p.unit
        )}

      </div>


      <div>

        <div class="price">
          ${money(p.pricePence)}
        </div>


        <div class="qty">

          <button
            data-id="${p.id}"
            data-d="-1"
            ${
              qty === 0
                ? "disabled"
                : ""
            }
          >
            −
          </button>


          <span>
            ${qty}
          </span>


          <button
            data-id="${p.id}"
            data-d="1"
            ${
              qty >= p.stock
                ? "disabled"
                : ""
            }
          >
            +
          </button>

        </div>

      </div>

    </div>
  `;
}


/* =========================================================
   PRODUCTS
   ========================================================= */

function renderProducts() {

  const productsElement =
    document.getElementById(
      "products"
    );

  if (!productsElement) return;


  let html = "";


  (
    sectionOrder[currentCategory] ||
    []
  ).forEach(section => {

    const shopItems =
      products.filter(
        p =>
          p.category ===
            currentCategory &&
          p.section ===
            section
      );


    html += `
      <div class="section-title">
        ${section}
      </div>
    `;


    if (!shopItems.length) {

      html += `
        <div class="empty">
          No products added yet.
        </div>
      `;

    } else {

      html +=
        shopItems
          .map(shopCard)
          .join("");
    }
  });


  productsElement.innerHTML =
    html;


  document
    .querySelectorAll(
      "[data-d]"
    )
    .forEach(btn => {

      btn.addEventListener(
        "click",
        () => {

          const id =
            Number(
              btn.dataset.id
            );

          const delta =
            Number(
              btn.dataset.d
            );

          const product =
            products.find(
              p => p.id === id
            );

          if (!product) return;


          const current =
            basket[id] || 0;


          const next =
            Math.max(
              0,
              Math.min(
                product.stock,
                current + delta
              )
            );


          if (next === 0) {

            delete basket[id];

            if (current > 0) {
              postCartEvent(
                id,
                "remove"
              );
            }

          } else {

            basket[id] =
              next;

            if (current === 0) {
              postCartEvent(
                id,
                "add"
              );
            }
          }


          tg
            ?.HapticFeedback
            ?.selectionChanged();


          render();
        }
      );

    });
}


/* =========================================================
   BASKET CALCULATIONS
   ========================================================= */

function basketCount() {

  return Object
    .values(basket)
    .reduce(
      (sum, qty) =>
        sum + qty,
      0
    );
}


function basketSubtotalValue() {

  return Object
    .entries(basket)
    .reduce(
      (
        sum,
        [id, qty]
      ) => {

        const product =
          products.find(
            p =>
              p.id ===
              Number(id)
          );

        return (
          sum +
          (
            product
              ? product.pricePence *
                qty
              : 0
          )
        );
      },
      0
    );
}


function discountForSubtotal(
  subtotalPence
) {

  if (!appliedCode) {
    return 0;
  }


  const raw =
    appliedCode.discountType ===
    "percent"

      ? Math.round(
          subtotalPence *
          (
            appliedCode.discountValue /
            100
          )
        )

      : appliedCode.discountValue;


  return Math.min(
    raw,
    subtotalPence
  );
}


function storeCreditForRemaining(
  remainingPence
) {

  if (!appliedStoreCredit) {
    return 0;
  }


  return Math.min(
    appliedStoreCredit.balancePence,
    remainingPence
  );
}


function basketTotalValue() {

  const subtotal =
    basketSubtotalValue();

  const discount =
    discountForSubtotal(
      subtotal
    );

  const credit =
    storeCreditForRemaining(
      subtotal - discount
    );


  return Math.max(
    0,
    subtotal -
      discount -
      credit
  );
}


/* =========================================================
   RENDER BASKET
   ========================================================= */

function renderBasket() {

  const basketLines =
    document.getElementById(
      "basketLines"
    );

  const basketTotal =
    document.getElementById(
      "basketTotal"
    );

  const cartCount =
    document.getElementById(
      "cartCount"
    );

  const discountRow =
    document.getElementById(
      "discountRow"
    );

  const creditRow =
    document.getElementById(
      "creditRow"
    );


  const entries =
    Object.entries(
      basket
    );


  const subtotal =
    basketSubtotalValue();

  const discount =
    discountForSubtotal(
      subtotal
    );

  const credit =
    storeCreditForRemaining(
      subtotal - discount
    );


  if (cartCount) {
    cartCount.textContent =
      basketCount();
  }


  if (basketTotal) {

    basketTotal.textContent =
      money(
        Math.max(
          0,
          subtotal -
            discount -
            credit
        )
      );
  }


  if (discountRow) {

    discountRow.innerHTML =
      discount > 0

        ? `
          <div class="discount-line">
            Code
            <strong>
              ${appliedCode.code}
            </strong>
            applied:
            −${money(discount)}
          </div>
        `

        : "";
  }


  if (creditRow) {

    creditRow.innerHTML =
      credit > 0

        ? `
          <div class="discount-line">
            Store credit
            <strong>
              ${appliedStoreCredit.code}
            </strong>
            applied:
            −${money(credit)}
          </div>
        `

        : "";
  }


  if (!basketLines) return;


  if (!entries.length) {

    basketLines.innerHTML = `
      <div class="empty">
        Your basket is empty.
      </div>
    `;

    return;
  }


  basketLines.innerHTML =
    entries.map(
      ([id, qty]) => {

        const p =
          products.find(
            x =>
              x.id ===
              Number(id)
          );

        if (!p) return "";


        return `

          <div class="basket-line">

            <div>

              <strong>
                ${p.name}
              </strong>

              <br>

              <span>
                ${qty} ×
                ${money(
                  p.pricePence
                )}
              </span>

            </div>


            <div class="basket-right">

              <strong>
                ${money(
                  p.pricePence *
                  qty
                )}
              </strong>

              <button
                data-remove="${p.id}"
              >
                Remove
              </button>

            </div>

          </div>

        `;
      }
    ).join("");


  document
    .querySelectorAll(
      "[data-remove]"
    )
    .forEach(btn => {

      btn.addEventListener(
        "click",
        () => {

          const id =
            Number(
              btn.dataset.remove
            );

          delete basket[id];

          postCartEvent(
            id,
            "remove"
          );

          tg
            ?.HapticFeedback
            ?.selectionChanged();

          render();
        }
      );

    });
}


/* =========================================================
   MAIN RENDER
   ========================================================= */

function render() {

  renderTabs();
  renderProducts();
  renderBasket();
}


/* =========================================================
   LOAD PRODUCTS
   ========================================================= */

async function loadProducts() {

  try {

    const res =
      await fetch(
        "/products.json",
        {
          cache: "no-store"
        }
      );


    products =
      await res.json();

  } catch (err) {

    console.error(
      "Failed to load products",
      err
    );

    products = [];
  }


  render();
}


/* =========================================================
   STATUS
   ========================================================= */

function setStatus(
  message,
  kind = ""
) {

  const status =
    document.getElementById(
      "status"
    );

  if (!status) return;


  status.textContent =
    message;

  status.className =
    `status ${kind}`;
}


/* =========================================================
   DISCOUNT CODE
   ========================================================= */

async function applyDiscountCode() {

  const input =
    document.getElementById(
      "discountCode"
    );

  const code =
    input?.value.trim();


  if (!code) {

    appliedCode = null;

    renderBasket();

    return;
  }


  try {

    const params =
      new URLSearchParams();


    if (telegramUser?.id) {

      params.set(
        "telegramId",
        telegramUser.id
      );
    }


    if (
      telegramUser?.username
    ) {

      params.set(
        "telegramUsername",
        telegramUser.username
      );
    }


    const res =
      await fetch(
        `/api/discount-codes/${encodeURIComponent(code)}?${params.toString()}`
      );


    const data =
      await res.json();


    if (
      !res.ok ||
      !data.valid
    ) {

      appliedCode = null;

      renderBasket();

      setStatus(
        data.error ||
        "That code isn't valid.",
        "error"
      );

      return;
    }


    appliedCode = {

      code:
        data.code,

      discountType:
        data.discountType,

      discountValue:
        data.discountValue
    };


    setStatus(
      "Code applied!",
      "success"
    );


    renderBasket();

  } catch (err) {

    setStatus(
      "Couldn't check that code, try again.",
      "error"
    );
  }
}


/* =========================================================
   STORE CREDIT
   ========================================================= */

async function applyStoreCredit() {

  const input =
    document.getElementById(
      "storeCreditCode"
    );

  const code =
    input?.value.trim();


  if (!code) {

    appliedStoreCredit =
      null;

    renderBasket();

    return;
  }


  try {

    const res =
      await fetch(
        `/api/referral-codes/${encodeURIComponent(code)}/earnings`
      );


    const data =
      await res.json();


    if (!res.ok) {

      appliedStoreCredit =
        null;

      renderBasket();

      setStatus(
        data.error ||
        "That code isn't valid.",
        "error"
      );

      return;
    }


    if (
      !data.balancePence ||
      data.balancePence <= 0
    ) {

      appliedStoreCredit =
        null;

      renderBasket();

      setStatus(
        "No store credit available on that code.",
        "error"
      );

      return;
    }


    appliedStoreCredit = {

      code:
        data.code,

      balancePence:
        data.balancePence
    };


    setStatus(
      `Store credit applied: ${money(data.balancePence)} available!`,
      "success"
    );


    renderBasket();

  } catch (err) {

    setStatus(
      "Couldn't check that code, try again.",
      "error"
    );
  }
}


/* =========================================================
   SUBMIT ORDER
   ========================================================= */

async function submitOrder() {

  const customerName =
    document
      .getElementById("name")
      ?.value.trim();


  const telegramUsername =
    telegramUser?.username ||
    document
      .getElementById("handle")
      ?.value.trim();


  const telegramId =
    telegramUser?.id ||
    undefined;


  const address =
    document
      .getElementById("address")
      ?.value.trim();


  const items =
    Object
      .entries(basket)
      .map(
        ([id, quantity]) => ({
          id:
            Number(id),

          quantity
        })
      );


  if (!items.length) {

    setStatus(
      "Your basket is empty.",
      "error"
    );

    return;
  }


  if (
    !customerName ||
    !address
  ) {

    setStatus(
      "Please add your name and delivery address.",
      "error"
    );

    return;
  }


  const checkoutBtn =
    document.getElementById(
      "checkoutBtn"
    );


  if (checkoutBtn) {
    checkoutBtn.disabled =
      true;
  }


  setStatus(
    "Placing your order…"
  );


  try {

    const res =
      await fetch(
        "/api/orders",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            customerName,

            telegramUsername,

            telegramId,

            address,

            items,

            discountCode:
              appliedCode?.code ||
              undefined,

            storeCreditCode:
              appliedStoreCredit?.code ||
              undefined
          })
        }
      );


    const data =
      await res.json();


    if (!res.ok) {

      setStatus(
        data.error ||
        "Something went wrong placing your order.",
        "error"
      );

      return;
    }


    setStatus(
      `Order #${data.orderId} created — total ${money(data.totalPence)}.`,
      "success"
    );


    Object
      .keys(basket)
      .forEach(
        id =>
          delete basket[id]
      );


    appliedCode = null;

    appliedStoreCredit =
      null;


    const discountInput =
      document.getElementById(
        "discountCode"
      );

    if (discountInput) {
      discountInput.value = "";
    }


    const creditInput =
      document.getElementById(
        "storeCreditCode"
      );

    if (creditInput) {
      creditInput.value = "";
    }


    render();

    renderPaymentPanel(
      data
    );

  } catch (err) {

    console.error(
      "ORDER ERROR:",
      err
    );

    setStatus(
      "Couldn't reach the server, try again.",
      "error"
    );

  } finally {

    if (checkoutBtn) {
      checkoutBtn.disabled =
        false;
    }
  }
}


/* =========================================================
   PAYMENT PANEL
   ========================================================= */

function renderPaymentPanel(
  order
) {

  const panel =
    document.getElementById(
      "paymentPanel"
    );


  if (!panel) return;


  if (
    !order.payment ||
    order.payment.method !==
      "crypto"
  ) {

    panel.innerHTML = "";

    return;
  }


  panel.innerHTML = `

    <div class="payment-panel">

      <div class="payment-title">
        Send USDT (ERC-20, Ethereum mainnet) to
      </div>


      <div class="wallet-box">

        <div
          class="payment-address"
          id="walletAddress"
        >
          ${order.payment.address}
        </div>


        <button
          id="copyWalletBtn"
          type="button"
          class="copy-btn"
        >
          📋 Copy address
        </button>

      </div>


      <div class="payment-quote">

        ${
          order.payment.quote.USDT ===
          "QUOTE_PENDING"

            ? "Waiting for secure quote"

            : `≈ ${order.payment.quote.USDT} USDT`
        }

      </div>


      <div class="payment-sub">
        ${order.payment.instructions}
      </div>


      <label>
        Transaction hash
      </label>


      <input
        id="paymentTxId"
        placeholder="0x..."
      >


      <button
        id="confirmPaymentBtn"
        class="gold-btn"
        type="button"
      >
        I've paid — submit transaction
      </button>


      <div
        id="paymentStatus"
        class="status"
      ></div>

    </div>
  `;


  async function copyWalletAddress() {

    try {

      await navigator
        .clipboard
        .writeText(
          order.payment.address
        );


      const btn =
        document.getElementById(
          "copyWalletBtn"
        );


      if (btn) {

        btn.textContent =
          "✅ Copied!";


        setTimeout(
          () => {

            btn.textContent =
              "📋 Copy address";

          },
          2000
        );
      }


      tg
        ?.HapticFeedback
        ?.notificationOccurred(
          "success"
        );

    } catch (err) {

      console.error(
        "Couldn't copy wallet address:",
        err
      );
    }
  }


  document
    .getElementById(
      "copyWalletBtn"
    )
    ?.addEventListener(
      "click",
      copyWalletAddress
    );


  document
    .getElementById(
      "walletAddress"
    )
    ?.addEventListener(
      "click",
      copyWalletAddress
    );


  document
    .getElementById(
      "confirmPaymentBtn"
    )
    ?.addEventListener(
      "click",
      () =>
        confirmPayment(
          order.orderId
        )
    );
}


/* =========================================================
   SUBMIT TRANSACTION HASH
   ========================================================= */

async function confirmPayment(
  orderId
) {

  const transactionId =
    document
      .getElementById(
        "paymentTxId"
      )
      ?.value.trim();


  const paymentStatus =
    document.getElementById(
      "paymentStatus"
    );


  const setPaymentStatus =
    (
      message,
      kind = ""
    ) => {

      if (!paymentStatus) {
        return;
      }


      paymentStatus.textContent =
        message;

      paymentStatus.className =
        `status ${kind}`;
    };


  if (!transactionId) {

    setPaymentStatus(
      "Enter your transaction hash.",
      "error"
    );

    return;
  }


  const btn =
    document.getElementById(
      "confirmPaymentBtn"
    );


  if (btn) {
    btn.disabled = true;
  }


  setPaymentStatus(
    "Submitting transaction…"
  );


  try {

    const res =
      await fetch(
        `/api/orders/${orderId}/confirm-payment`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({
            transactionId
          })
        }
      );


    const raw =
      await res.text();


    let data;


    try {

      data =
        JSON.parse(raw);

    } catch {

      console.error(
        "Server returned non-JSON:",
        raw
      );


      setPaymentStatus(
        `Server error (${res.status}). Check Render logs.`,
        "error"
      );

      return;
    }


    if (!res.ok) {

      console.error(
        "Payment submission error:",
        res.status,
        data
      );


      setPaymentStatus(
        data.error ||
        `Server error (${res.status})`,
        "error"
      );

      return;
    }


    /*
      The current server records the transaction
      submission. It does not automatically prove
      the payment has been confirmed on-chain.
    */

    setPaymentStatus(
      "Payment submitted! We'll confirm it shortly.",
      "success"
    );


    tg
      ?.HapticFeedback
      ?.notificationOccurred(
        "success"
      );

  } catch (err) {

    console.error(
      "PAYMENT ERROR:",
      err
    );


    setPaymentStatus(
      "Couldn't reach the server, try again.",
      "error"
    );

  } finally {

    if (btn) {
      btn.disabled = false;
    }
  }
}


/* =========================================================
   CUSTOMER REVIEWS
   ========================================================= */

const reviewsBtn =
  document.getElementById(
    "reviewsBtn"
  );


const closeReviewsBtn =
  document.getElementById(
    "closeReviews"
  );


const reviewsSection =
  document.getElementById(
    "reviewsSection"
  );


const reviewsList =
  document.getElementById(
    "reviewsList"
  );


const reviewsSummary =
  document.getElementById(
    "reviewsSummary"
  );


/* Prevent review text from injecting HTML */

function escapeReviewHtml(
  value
) {

  return String(
    value ?? ""
  )

    .replaceAll(
      "&",
      "&amp;"
    )

    .replaceAll(
      "<",
      "&lt;"
    )

    .replaceAll(
      ">",
      "&gt;"
    )

    .replaceAll(
      '"',
      "&quot;"
    )

    .replaceAll(
      "'",
      "&#039;"
    );
}


/* =========================================================
   LOAD APPROVED REVIEWS
   ========================================================= */

async function loadReviews() {

  if (!reviewsList) return;


  reviewsList.innerHTML = `
    <div class="empty">
      Loading reviews...
    </div>
  `;


  try {

    const res =
      await fetch(
        "/api/reviews",
        {
          cache: "no-store"
        }
      );


    const data =
      await res.json();


    if (!res.ok) {

      throw new Error(
        data.error ||
        "Couldn't load reviews."
      );
    }


    /*
      Supports:

      [review, review]

      OR

      { reviews: [...] }
    */

    const reviews =
      Array.isArray(data)

        ? data

        : Array.isArray(
            data.reviews
          )

          ? data.reviews

          : [];


    /* -----------------------------------------
       NO REVIEWS
       ----------------------------------------- */

    if (!reviews.length) {

      if (reviewsSummary) {

        reviewsSummary.innerHTML = `

          <div class="review-average">
            ⭐ No reviews yet
          </div>

          <div class="review-count">
            Approved customer reviews
            will appear here.
          </div>

        `;
      }


      reviewsList.innerHTML = `

        <div class="no-reviews">

          <div class="no-reviews-star">
            ☆
          </div>

          <strong>
            No approved reviews yet
          </strong>

          <span>
            Customer feedback will
            appear here once approved.
          </span>

        </div>
      `;


      return;
    }


    /* -----------------------------------------
       AVERAGE
       ----------------------------------------- */

    const ratingTotal =
      reviews.reduce(
        (
          sum,
          review
        ) =>

          sum +
          Number(
            review.rating || 0
          ),

        0
      );


    const average =
      ratingTotal /
      reviews.length;


    const roundedStars =
      Math.max(
        1,
        Math.min(
          5,
          Math.round(
            average
          )
        )
      );


    if (reviewsSummary) {

      reviewsSummary.innerHTML = `

        <div class="review-summary-stars">
          ${"★".repeat(
            roundedStars
          )}${"☆".repeat(
            5 -
            roundedStars
          )}
        </div>


        <div class="review-average">
          ${average.toFixed(1)} / 5
        </div>


        <div class="review-count">
          Based on
          ${reviews.length}
          approved
          ${
            reviews.length === 1
              ? "review"
              : "reviews"
          }
        </div>

      `;
    }


    /* -----------------------------------------
       REVIEW CARDS
       ----------------------------------------- */

    reviewsList.innerHTML =
      reviews.map(
        review => {

          const rating =
            Math.max(
              1,
              Math.min(
                5,
                Number(
                  review.rating || 1
                )
              )
            );


          const stars =
            "★".repeat(
              rating
            ) +
            "☆".repeat(
              5 - rating
            );


          const name =
            escapeReviewHtml(
              review.display_name ||
              review.displayName ||
              "Customer"
            );


          const text =
            escapeReviewHtml(
              review.review_text ||
              review.reviewText ||
              ""
            );


          return `

            <div class="review-card">

              <div class="review-card-top">

                <div>

                  <div class="review-name">
                    ${name}
                  </div>

                  <div class="verified-order">
                    ✓ Verified order
                  </div>

                </div>


                <div class="review-stars">
                  ${stars}
                </div>

              </div>


              <div class="review-text">
                ${text}
              </div>

            </div>

          `;

        }
      ).join("");

  } catch (err) {

    console.error(
      "Failed to load reviews:",
      err
    );


    if (reviewsSummary) {
      reviewsSummary.innerHTML =
        "";
    }


    reviewsList.innerHTML = `

      <div class="no-reviews">

        <strong>
          Couldn't load reviews
        </strong>

        <span>
          Please try again.
        </span>

      </div>
    `;
  }
}


/* =========================================================
   OPEN REVIEWS
   ========================================================= */

reviewsBtn
  ?.addEventListener(
    "click",
    async () => {

      if (!reviewsSection) {
        return;
      }


      reviewsSection.hidden =
        false;


      await loadReviews();


      reviewsSection
        .scrollIntoView({
          behavior: "smooth",
          block: "start"
        });


      tg
        ?.HapticFeedback
        ?.selectionChanged();
    }
  );


/* =========================================================
   CLOSE REVIEWS
   ========================================================= */

closeReviewsBtn
  ?.addEventListener(
    "click",
    () => {

      if (!reviewsSection) {
        return;
      }


      reviewsSection.hidden =
        true;


      document
        .getElementById(
          "products"
        )
        ?.scrollIntoView({
          behavior: "smooth",
          block: "start"
        });


      tg
        ?.HapticFeedback
        ?.selectionChanged();
    }
  );


/* =========================================================
   TELEGRAM USERNAME
   ========================================================= */

if (
  telegramUser?.username
) {

  const handleInput =
    document.getElementById(
      "handle"
    );


  if (handleInput) {

    handleInput.value =
      `@${telegramUser.username}`;

    handleInput.disabled =
      true;
  }
}


/* =========================================================
   BUTTON EVENTS
   ========================================================= */

document
  .getElementById(
    "applyDiscount"
  )
  ?.addEventListener(
    "click",
    applyDiscountCode
  );


document
  .getElementById(
    "applyStoreCredit"
  )
  ?.addEventListener(
    "click",
    applyStoreCredit
  );


document
  .getElementById(
    "checkoutBtn"
  )
  ?.addEventListener(
    "click",
    submitOrder
  );


document
  .getElementById(
    "cartJump"
  )
  ?.addEventListener(
    "click",
    () => {

      document
        .getElementById(
          "checkout"
        )
        ?.scrollIntoView({
          behavior: "smooth"
        });
    }
  );


/* =========================================================
   START SHOP
   ========================================================= */

loadProducts();