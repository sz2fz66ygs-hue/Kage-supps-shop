const tg = window.Telegram?.WebApp;

if (tg) {
  tg.ready();
  tg.expand();
}

const telegramUser =
  tg?.initDataUnsafe?.user ||
  null;


/* =========================================================
   CATALOGUE SETTINGS
   ========================================================= */

const preferredCategoryOrder = [
  "Oils",
  "Orals",
  "Pharma",
  "Peps"
];

const categoryIcons = {
  Oils: "🛢️",
  Orals: "💪",
  Pharma: "💊",
  Peps: "⚡"
};

const preferredSectionOrder = {
  Oils: [
    "Pre-Workout",
    "Oils",
    "Blends"
  ],

  Orals: [
    "Orals"
  ],

  Pharma: [
    "General Pharma"
  ],

  Peps: [
    "Recovery",
    "Performance",
    "Weight Management",
    "Other"
  ]
};


/* =========================================================
   SHOP STATE
   ========================================================= */

let products = [];
let categories = [];
let sectionOrder = {};

const basket = {};

let currentCategory = null;

let appliedCode = null;
let appliedStorewideCode = null;
let appliedStoreCredit = null;

let paymentCountdownTimer = null;


/* =========================================================
   BASIC HELPERS
   ========================================================= */

const money = p =>
  `£${(
    Number(
      p ||
      0
    ) /
    100
  ).toFixed(2)}`;


function escapeHtml(value) {
  return String(
    value ??
    ""
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
   CATALOGUE NAVIGATION
   ========================================================= */

function rebuildCatalogueNavigation() {
  const foundCategories = [
    ...new Set(
      products.map(
        p =>
          String(
            p.category ||
            "Other"
          ).trim() ||
          "Other"
      )
    )
  ];

  const ordered = [
    ...preferredCategoryOrder.filter(
      name =>
        foundCategories.includes(
          name
        )
    ),

    ...foundCategories.filter(
      name =>
        !preferredCategoryOrder.includes(
          name
        )
    )
  ];

  categories =
    ordered.map(
      name => ({
        name,

        icon:
          categoryIcons[name] ||
          "•"
      })
    );

  sectionOrder = {};

  for (
    const category
    of ordered
  ) {
    const foundSections = [
      ...new Set(
        products
          .filter(
            p =>
              String(
                p.category ||
                "Other"
              ).trim() ===
              category
          )
          .map(
            p =>
              String(
                p.section ||
                "Other"
              ).trim() ||
              "Other"
          )
      )
    ];

    const preferred =
      preferredSectionOrder[category] ||
      [];

    sectionOrder[category] = [
      ...preferred.filter(
        name =>
          foundSections.includes(
            name
          )
      ),

      ...foundSections.filter(
        name =>
          !preferred.includes(
            name
          )
      )
    ];
  }

  if (
    !currentCategory ||
    !ordered.includes(
      currentCategory
    )
  ) {
    currentCategory =
      ordered[0] ||
      null;
  }
}


/* =========================================================
   CART EVENTS
   ========================================================= */

function postCartEvent(
  productId,
  action
) {
  fetch(
    "/api/cart-events",
    {
      method:
        "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body:
        JSON.stringify({
          productId,
          action
        })
    }
  )
    .catch(
      () => {}
    );
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
    stock === undefined ||
    Number.isNaN(
      Number(
        stock
      )
    )
  ) {
    return `
      <span class="stock low">
        Stock not entered
      </span>
    `;
  }

  const n =
    Number(
      stock
    );

  if (
    n <=
    0
  ) {
    return `
      <span class="stock out">
        Out of stock
      </span>
    `;
  }

  if (
    n <=
    10
  ) {
    return `
      <span class="stock low">
        ${n} ${escapeHtml(unit)} left
      </span>
    `;
  }

  return `
    <span class="stock good">
      ${n} ${escapeHtml(unit)} in stock
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

  if (
    !tabs
  ) {
    return;
  }

  tabs.innerHTML =
    categories
      .map(
        c => `
          <button
            class="tab ${
              c.name === currentCategory
                ? "active"
                : ""
            }"
            data-category="${escapeHtml(c.name)}"
            type="button"
          >
            ${c.icon} ${escapeHtml(c.name)}
          </button>
        `
      )
      .join("");

  document
    .querySelectorAll(
      "[data-category]"
    )
    .forEach(
      btn => {
        btn.addEventListener(
          "click",
          () => {
            currentCategory =
              btn.dataset.category;

            render();

            window.scrollTo({
              top:
                0,

              behavior:
                "smooth"
            });
          }
        );
      }
    );
}


/* =========================================================
   PRODUCT CARD
   ========================================================= */

function shopCard(p) {
  const id =
    Number(
      p.id
    );

  const qty =
    basket[id] ||
    0;

  const shownPricePence =
    Number(
      p.displayPricePence ??
      p.pricePence
    );

  const truePricePence =
    Number(
      p.pricePence
    );

  const stock =
    Number(
      p.stock ??
      0
    );

  const canPurchase =
    p.purchasable !==
      false &&
    Number.isFinite(
      truePricePence
    ) &&
    truePricePence >=
      0;

  const priceText =
    Number.isFinite(
      shownPricePence
    )
      ? money(
          shownPricePence
        )
      : "";

  return `
    <div class="product">

      <div>
        <h3>
          ${escapeHtml(p.name)}
        </h3>

        ${
          p.subtitle
            ? `
              <div class="sub">
                ${escapeHtml(p.subtitle)}
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
          ${priceText}
        </div>

        ${
          canPurchase
            ? `
              <div class="qty">

                <button
                  data-id="${id}"
                  data-d="-1"
                  type="button"
                  ${
                    qty ===
                    0
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
                  data-id="${id}"
                  data-d="1"
                  type="button"
                  ${
                    qty >=
                    stock
                      ? "disabled"
                      : ""
                  }
                >
                  +
                </button>

              </div>
            `
            : ""
        }

      </div>

    </div>
  `;
}


/* =========================================================
   PRODUCTS
   ========================================================= */

function renderProducts() {
  const container =
    document.getElementById(
      "products"
    );

  if (
    !container
  ) {
    return;
  }

  if (
    !products.length
  ) {
    container.innerHTML = `
      <div class="catalogue-error">
        No products could be loaded.
        Please refresh the shop.
      </div>
    `;

    return;
  }

  if (
    !currentCategory
  ) {
    container.innerHTML =
      products
        .map(
          shopCard
        )
        .join("");

    return;
  }

  const sections =
    sectionOrder[currentCategory] ||
    [];

  let html =
    "";

  for (
    const section
    of sections
  ) {
    const shopItems =
      products.filter(
        p =>
          String(
            p.category ||
            "Other"
          ).trim() ===
            currentCategory &&

          String(
            p.section ||
            "Other"
          ).trim() ===
            section
      );

    if (
      !shopItems.length
    ) {
      continue;
    }

    html += `
      <div class="section-title">
        ${escapeHtml(section)}
      </div>
    `;

    html +=
      shopItems
        .map(
          shopCard
        )
        .join("");
  }

  if (
    !html
  ) {
    const fallback =
      products.filter(
        p =>
          String(
            p.category ||
            "Other"
          ).trim() ===
          currentCategory
      );

    html =
      fallback
        .map(
          shopCard
        )
        .join("");
  }

  container.innerHTML =
    html;

  document
    .querySelectorAll(
      "[data-d]"
    )
    .forEach(
      btn => {
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
                p =>
                  Number(
                    p.id
                  ) ===
                  id
              );

            if (
              !product
            ) {
              return;
            }

            const stock =
              Math.max(
                0,
                Number(
                  product.stock ||
                  0
                )
              );

            const current =
              basket[id] ||
              0;

            const next =
              Math.max(
                0,

                Math.min(
                  stock,
                  current +
                    delta
                )
              );

            if (
              next ===
              0
            ) {
              delete basket[id];

              if (
                current >
                0
              ) {
                postCartEvent(
                  id,
                  "remove"
                );
              }

            } else {
              basket[id] =
                next;

              if (
                current ===
                0
              ) {
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
      }
    );
}


/* =========================================================
   BASKET HELPERS
   ========================================================= */

function basketCount() {
  return Object
    .values(
      basket
    )
    .reduce(
      (
        sum,
        qty
      ) =>
        sum +
        Number(
          qty ||
          0
        ),

      0
    );
}


function basketSubtotalValue() {
  return Object
    .entries(
      basket
    )
    .reduce(
      (
        sum,
        [
          id,
          qty
        ]
      ) => {
        const product =
          products.find(
            p =>
              Number(
                p.id
              ) ===
              Number(
                id
              )
          );

        const price =
          Number(
            product?.pricePence
          );

        return (
          sum +
          (
            product &&
            Number.isFinite(
              price
            )
              ? price *
                Number(
                  qty
                )
              : 0
          )
        );
      },

      0
    );
}


/* =========================================================
   DISCOUNT CALCULATIONS
   ========================================================= */

function discountForSubtotal(
  subtotalPence
) {
  if (
    !appliedCode
  ) {
    return 0;
  }

  const raw =
    appliedCode.discountType ===
      "percent"
      ? Math.round(
          subtotalPence *
          (
            Number(
              appliedCode.discountValue
            ) /
            100
          )
        )
      : Number(
          appliedCode.discountValue ||
          0
        );

  return Math.min(
    Math.max(
      0,
      raw
    ),
    subtotalPence
  );
}


function storewideDiscountForSubtotal(
  subtotalPence
) {
  if (
    !appliedStorewideCode
  ) {
    return 0;
  }

  const raw =
    Math.round(
      subtotalPence *
      (
        Number(
          appliedStorewideCode.discountPercent ||
          0
        ) /
        100
      )
    );

  return Math.min(
    Math.max(
      0,
      raw
    ),
    subtotalPence
  );
}


function storeCreditForRemaining(
  remainingPence
) {
  if (
    !appliedStoreCredit
  ) {
    return 0;
  }

  return Math.min(
    Math.max(
      0,

      Number(
        appliedStoreCredit.balancePence ||
        0
      )
    ),

    Math.max(
      0,
      remainingPence
    )
  );
}


/* =========================================================
   BASKET RENDER
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

  const promoRow =
    document.getElementById(
      "promoRow"
    );

  const totalSavingsRow =
    document.getElementById(
      "totalSavingsRow"
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

  const affiliateDiscount =
    discountForSubtotal(
      subtotal
    );

  const storewideDiscount =
    storewideDiscountForSubtotal(
      subtotal
    );

  const totalSavings =
    affiliateDiscount +
    storewideDiscount;

  const credit =
    storeCreditForRemaining(
      subtotal -
      affiliateDiscount -
      storewideDiscount
    );

  const totalBeforeShipping =
    Math.max(
      0,

      subtotal -
      affiliateDiscount -
      storewideDiscount -
      credit
    );

  if (
    cartCount
  ) {
    cartCount.textContent =
      basketCount();
  }

  if (
    basketTotal
  ) {
    basketTotal.textContent =
      money(
        totalBeforeShipping
      );
  }

  if (
    discountRow
  ) {
    discountRow.innerHTML =
      affiliateDiscount >
      0
        ? `
          <div class="discount-line">
            Affiliate code
            <strong>
              ${escapeHtml(appliedCode.code)}
            </strong>:
            −${money(affiliateDiscount)}
          </div>
        `
        : "";
  }

  if (
    promoRow
  ) {
    promoRow.innerHTML =
      storewideDiscount >
      0
        ? `
          <div class="discount-line">
            Store promo
            <strong>
              ${escapeHtml(appliedStorewideCode.code)}
            </strong>:
            −${money(storewideDiscount)}
          </div>
        `
        : "";
  }

  if (
    totalSavingsRow
  ) {
    totalSavingsRow.innerHTML =
      totalSavings >
      0
        ? `
          <div class="savings-total">
            You save ${money(totalSavings)}
          </div>
        `
        : "";
  }

  if (
    creditRow
  ) {
    creditRow.innerHTML =
      credit >
      0
        ? `
          <div class="discount-line">
            Store credit
            <strong>
              ${escapeHtml(appliedStoreCredit.code)}
            </strong>:
            −${money(credit)}
          </div>
        `
        : "";
  }

  if (
    !basketLines
  ) {
    return;
  }

  if (
    !entries.length
  ) {
    basketLines.innerHTML = `
      <div class="empty">
        Your basket is empty.
      </div>
    `;

    return;
  }

  basketLines.innerHTML =
    entries
      .map(
        (
          [
            id,
            qty
          ]
        ) => {
          const p =
            products.find(
              x =>
                Number(
                  x.id
                ) ===
                Number(
                  id
                )
            );

          if (
            !p
          ) {
            return "";
          }

          const price =
            Number(
              p.pricePence ||
              0
            );

          return `
            <div class="basket-line">

              <div>
                <strong>
                  ${escapeHtml(p.name)}
                </strong>

                <br>

                <span>
                  ${qty} × ${money(price)}
                </span>
              </div>

              <div class="basket-right">

                <strong>
                  ${money(
                    price *
                    Number(
                      qty
                    )
                  )}
                </strong>

                <button
                  data-remove="${Number(p.id)}"
                  type="button"
                >
                  Remove
                </button>

              </div>

            </div>
          `;
        }
      )
      .join("");

  document
    .querySelectorAll(
      "[data-remove]"
    )
    .forEach(
      btn => {
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
      }
    );
}


/* =========================================================
   RENDER EVERYTHING
   ========================================================= */

function render() {
  renderTabs();
  renderProducts();
  renderBasket();
}


/* =========================================================
   PRODUCT FETCHING
   ========================================================= */

async function fetchProductsFrom(
  url
) {
  const res =
    await fetch(
      url,
      {
        cache:
          "no-store"
      }
    );

  if (
    !res.ok
  ) {
    throw new Error(
      `${url} returned ${res.status}`
    );
  }

  const data =
    await res.json();

  if (
    !Array.isArray(
      data
    )
  ) {
    throw new Error(
      `${url} did not return a product array`
    );
  }

  return data;
}


async function loadProducts() {
  const productsContainer =
    document.getElementById(
      "products"
    );

  try {
    products =
      await fetchProductsFrom(
        "/products.json"
      );

  } catch (
    firstError
  ) {
    console.warn(
      "/products.json failed",
      firstError
    );

    try {
      products =
        await fetchProductsFrom(
          "/api/products"
        );

    } catch (
      secondError
    ) {
      console.error(
        "Both product endpoints failed",
        secondError
      );

      products =
        [];

      if (
        productsContainer
      ) {
        productsContainer.innerHTML = `
          <div class="catalogue-error">
            The catalogue could not be loaded from the server.
            Refresh the Mini App after the latest deployment finishes.
          </div>
        `;
      }

      return;
    }
  }

  rebuildCatalogueNavigation();
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

  if (
    !status
  ) {
    return;
  }

  status.textContent =
    message;

  status.className =
    `status ${kind}`;
}


/* =========================================================
   AFFILIATE CODE
   ========================================================= */

async function applyDiscountCode() {
  const input =
    document.getElementById(
      "discountCode"
    );

  const code =
    input
      ?.value
      .trim();

  if (
    !code
  ) {
    appliedCode =
      null;

    renderBasket();

    setStatus(
      ""
    );

    return;
  }

  try {
    const res =
      await fetch(
        `/api/discount-codes/${encodeURIComponent(code)}`
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      !data.valid
    ) {
      appliedCode =
        null;

      renderBasket();

      setStatus(
        data.error ||
        "That affiliate code isn't valid.",
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
      `${data.code} applied.`,
      "success"
    );

    renderBasket();

  } catch {
    setStatus(
      "Couldn't check that affiliate code. Try again.",
      "error"
    );
  }
}


/* =========================================================
   STOREWIDE CODE
   ========================================================= */

async function applyStorewideCode() {
  const input =
    document.getElementById(
      "storewideCode"
    );

  const code =
    input
      ?.value
      .trim();

  if (
    !code
  ) {
    appliedStorewideCode =
      null;

    renderBasket();

    setStatus(
      ""
    );

    return;
  }

  try {
    const res =
      await fetch(
        `/api/storewide-promo/${encodeURIComponent(code)}`
      );

    const data =
      await res.json();

    if (
      !res.ok ||
      !data.valid
    ) {
      appliedStorewideCode =
        null;

      renderBasket();

      setStatus(
        data.error ||
        "That store promo isn't active.",
        "error"
      );

      return;
    }

    appliedStorewideCode = {
      code:
        data.code,

      discountPercent:
        Number(
          data.discountPercent ||
          0
        )
    };

    setStatus(
      `${data.code} applied — extra ${data.discountPercent}% off.`,
      "success"
    );

    renderBasket();

  } catch {
    setStatus(
      "Couldn't check that store promo. Try again.",
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
    input
      ?.value
      .trim();

  if (
    !code
  ) {
    appliedStoreCredit =
      null;

    renderBasket();

    setStatus(
      ""
    );

    return;
  }

  try {
    const res =
      await fetch(
        `/api/referral-codes/${encodeURIComponent(code)}/earnings`
      );

    const data =
      await res.json();

    if (
      !res.ok
    ) {
      appliedStoreCredit =
        null;

      renderBasket();

      setStatus(
        data.error ||
        "That store credit code isn't valid.",
        "error"
      );

      return;
    }

    if (
      !data.balancePence ||
      Number(
        data.balancePence
      ) <=
      0
    ) {
      appliedStoreCredit =
        null;

      renderBasket();

      setStatus(
        "No store credit is available on that code.",
        "error"
      );

      return;
    }

    appliedStoreCredit = {
      code:
        data.code,

      balancePence:
        Number(
          data.balancePence
        )
    };

    setStatus(
      `Store credit applied: ${money(data.balancePence)} available.`,
      "success"
    );

    renderBasket();

  } catch {
    setStatus(
      "Couldn't check that store credit code. Try again.",
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
      .getElementById(
        "name"
      )
      ?.value
      .trim();

  const telegramUsername =
    document
      .getElementById(
        "handle"
      )
      ?.value
      .trim();

  const address =
    document
      .getElementById(
        "address"
      )
      ?.value
      .trim();

  const items =
    Object
      .entries(
        basket
      )
      .map(
        (
          [
            id,
            quantity
          ]
        ) => ({
          id:
            Number(
              id
            ),

          quantity:
            Number(
              quantity
            )
        })
      );

  if (
    !items.length
  ) {
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

  if (
    checkoutBtn
  ) {
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
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              customerName,

              telegramUsername,

              telegramId:
                telegramUser?.id ||
                undefined,

              address,

              items,

              discountCode:
                appliedCode?.code ||
                undefined,

              storewideCode:
                appliedStorewideCode?.code ||
                undefined,

              storeCreditCode:
                appliedStoreCredit?.code ||
                undefined
            })
        }
      );

    const data =
      await res.json();

    if (
      !res.ok
    ) {
      setStatus(
        data.error ||
        "Something went wrong placing your order.",
        "error"
      );

      return;
    }

    setStatus(
      `Order #${data.orderId} created — total ${money(data.totalPence)} including shipping.`,
      "success"
    );

    Object
      .keys(
        basket
      )
      .forEach(
        id =>
          delete basket[id]
      );

    appliedCode =
      null;

    appliedStorewideCode =
      null;

    appliedStoreCredit =
      null;

    const discountInput =
      document.getElementById(
        "discountCode"
      );

    const promoInput =
      document.getElementById(
        "storewideCode"
      );

    const creditInput =
      document.getElementById(
        "storeCreditCode"
      );

    if (
      discountInput
    ) {
      discountInput.value =
        "";
    }

    if (
      promoInput
    ) {
      promoInput.value =
        "";
    }

    if (
      creditInput
    ) {
      creditInput.value =
        "";
    }

    render();

    renderPaymentPanel(
      data
    );

    document
      .getElementById(
        "paymentPanel"
      )
      ?.scrollIntoView({
        behavior:
          "smooth",

        block:
          "start"
      });

  } catch (
    err
  ) {
    console.error(
      "ORDER ERROR:",
      err
    );

    setStatus(
      "Couldn't reach the server. Try again.",
      "error"
    );

  } finally {
    if (
      checkoutBtn
    ) {
      checkoutBtn.disabled =
        false;
    }
  }
}


/* =========================================================
   COPY WALLET ADDRESS
   ========================================================= */

async function copyWalletAddress(
  address
) {
  const cleanAddress =
    String(
      address ||
      ""
    ).trim();

  if (
    !cleanAddress
  ) {
    return false;
  }

  /*
    Modern clipboard.
  */

  try {
    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      await navigator
        .clipboard
        .writeText(
          cleanAddress
        );

      return true;
    }

  } catch (
    err
  ) {
    console.warn(
      "Clipboard API failed:",
      err
    );
  }

  /*
    iPhone / Safari / Telegram fallback.
  */

  try {
    const textarea =
      document.createElement(
        "textarea"
      );

    textarea.value =
      cleanAddress;

    textarea.style.position =
      "fixed";

    textarea.style.left =
      "-9999px";

    textarea.style.top =
      "0";

    textarea.style.opacity =
      "0";

    textarea.style.fontSize =
      "16px";

    document.body.appendChild(
      textarea
    );

    textarea.focus();
    textarea.select();

    textarea.setSelectionRange(
      0,
      textarea.value.length
    );

    const copied =
      document.execCommand(
        "copy"
      );

    document.body.removeChild(
      textarea
    );

    return Boolean(
      copied
    );

  } catch (
    err
  ) {
    console.error(
      "Fallback copy failed:",
      err
    );

    return false;
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

  if (
    !panel
  ) {
    return;
  }

  if (
    !order.payment ||
    order.payment.method !==
      "crypto"
  ) {
    panel.innerHTML =
      "";

    return;
  }

  const walletAddress =
    String(
      order.payment.address ||
      ""
    ).trim();

  const quote =
    order.payment.quote?.USDT ??
    "QUOTE_PENDING";

  const reservationMinutes =
    Number(
      order.reservationMinutes ||
      30
    );

  const reservationExpiresAt =
    order.stockReservationExpiresAt ||
    null;

  panel.innerHTML = `
    <div class="payment-panel">

      <div class="payment-title">
        Send USDT (ERC-20)
      </div>

      <div class="payment-network">
        Ethereum Mainnet
      </div>

      <div class="payment-wallet-label">
        Wallet Address
      </div>

      <div
        id="walletAddress"
        class="payment-address"
        tabindex="0"
      >
        ${escapeHtml(walletAddress)}
      </div>

      <button
        id="copyWalletBtn"
        class="gold-btn copy-wallet-btn"
        type="button"
      >
        📋 Copy Wallet Address
      </button>

      <div
        id="walletCopyStatus"
        class="wallet-copy-status"
      >
        You can also press and hold the address above to copy it.
      </div>

      <div class="payment-quote">
        ${escapeHtml(quote)} USDT
      </div>

      <div class="payment-sub">
        ${escapeHtml(
          order.payment.instructions ||
          ""
        )}
      </div>

      ${
        reservationExpiresAt
          ? `
            <div class="payment-reservation">
              ⏳ Stock reserved for ${reservationMinutes} minutes
            </div>

            <div
              id="reservationCountdown"
              class="reservation-countdown"
            ></div>
          `
          : ""
      }

      <label for="paymentTxId">
        Transaction hash
      </label>

      <input
        id="paymentTxId"
        type="text"
        placeholder="0x..."
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
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


/* =========================================================
   COPY BUTTON
   ========================================================= */

  const copyButton =
    document.getElementById(
      "copyWalletBtn"
    );

  const copyStatus =
    document.getElementById(
      "walletCopyStatus"
    );

  copyButton
    ?.addEventListener(
      "click",

      async () => {
        if (
          !walletAddress
        ) {
          if (
            copyStatus
          ) {
            copyStatus.textContent =
              "Wallet address isn't available.";
          }

          return;
        }

        try {
          tg
            ?.HapticFeedback
            ?.impactOccurred(
              "light"
            );
        } catch {}

        const copied =
          await copyWalletAddress(
            walletAddress
          );

        if (
          copied
        ) {
          if (
            copyButton
          ) {
            copyButton.textContent =
              "✅ Address Copied";
          }

          if (
            copyStatus
          ) {
            copyStatus.textContent =
              "✅ Wallet address copied to clipboard";
          }

          setTimeout(
            () => {
              if (
                copyButton
              ) {
                copyButton.textContent =
                  "📋 Copy Wallet Address";
              }

              if (
                copyStatus
              ) {
                copyStatus.textContent =
                  "You can also press and hold the address above to copy it.";
              }
            },

            2000
          );

        } else {
          if (
            copyStatus
          ) {
            copyStatus.textContent =
              "Couldn't copy automatically — press and hold the address above and choose Copy.";
          }
        }
      }
    );


/* =========================================================
   PAYMENT BUTTON
   ========================================================= */

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


/* =========================================================
   COUNTDOWN
   ========================================================= */

  if (
    reservationExpiresAt
  ) {
    startPaymentCountdown(
      reservationExpiresAt
    );
  }
}


/* =========================================================
   RESERVATION COUNTDOWN
   ========================================================= */

function startPaymentCountdown(
  expiresAt
) {
  const element =
    document.getElementById(
      "reservationCountdown"
    );

  if (
    !element
  ) {
    return;
  }

  if (
    paymentCountdownTimer
  ) {
    clearInterval(
      paymentCountdownTimer
    );

    paymentCountdownTimer =
      null;
  }

  const expiryTime =
    new Date(
      expiresAt
    ).getTime();

  function updateCountdown() {
    const remaining =
      expiryTime -
      Date.now();

    if (
      !Number.isFinite(
        remaining
      ) ||
      remaining <=
        0
    ) {
      element.textContent =
        "⌛ Reservation expired";

      element.classList.add(
        "expired"
      );

      if (
        paymentCountdownTimer
      ) {
        clearInterval(
          paymentCountdownTimer
        );

        paymentCountdownTimer =
          null;
      }

      return;
    }

    const totalSeconds =
      Math.ceil(
        remaining /
        1000
      );

    const minutes =
      Math.floor(
        totalSeconds /
        60
      );

    const seconds =
      totalSeconds %
      60;

    element.textContent =
      `⏳ Time remaining: ${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  updateCountdown();

  paymentCountdownTimer =
    setInterval(
      updateCountdown,
      1000
    );
}


/* =========================================================
   SUBMIT PAYMENT HASH
   ========================================================= */

async function confirmPayment(
  orderId
) {
  const transactionId =
    document
      .getElementById(
        "paymentTxId"
      )
      ?.value
      .trim();

  const paymentStatus =
    document.getElementById(
      "paymentStatus"
    );

  const setPaymentStatus = (
    message,
    kind = ""
  ) => {
    if (
      !paymentStatus
    ) {
      return;
    }

    paymentStatus.textContent =
      message;

    paymentStatus.className =
      `status ${kind}`;
  };

  if (
    !transactionId
  ) {
    setPaymentStatus(
      "Enter your transaction hash.",
      "error"
    );

    return;
  }

  if (
    !/^0x[a-fA-F0-9]{64}$/.test(
      transactionId
    )
  ) {
    setPaymentStatus(
      "Enter a valid Ethereum transaction hash.",
      "error"
    );

    return;
  }

  const btn =
    document.getElementById(
      "confirmPaymentBtn"
    );

  if (
    btn
  ) {
    btn.disabled =
      true;

    btn.textContent =
      "Submitting...";
  }

  setPaymentStatus(
    "Submitting transaction for confirmation…"
  );

  try {
    const res =
      await fetch(
        `/api/orders/${orderId}/confirm-payment`,

        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              transactionId
            })
        }
      );

    let data =
      {};

    try {
      data =
        await res.json();

    } catch {}

    if (
      !res.ok
    ) {
      if (
        res.status ===
        410
      ) {
        setPaymentStatus(
          data.error ||
          "This order has expired and the stock has been returned to the shop.",
          "error"
        );

        if (
          paymentCountdownTimer
        ) {
          clearInterval(
            paymentCountdownTimer
          );

          paymentCountdownTimer =
            null;
        }

        return;
      }

      setPaymentStatus(
        data.error ||
        "Could not submit payment.",
        "error"
      );

      return;
    }

    setPaymentStatus(
      "✅ Payment submitted. We'll confirm it shortly.",
      "success"
    );

    /*
      Once the transaction hash has been
      accepted, stop showing the countdown.

      The server keeps the stock reserved
      while the payment is checked.
    */

    if (
      paymentCountdownTimer
    ) {
      clearInterval(
        paymentCountdownTimer
      );

      paymentCountdownTimer =
        null;
    }

    const countdown =
      document.getElementById(
        "reservationCountdown"
      );

    if (
      countdown
    ) {
      countdown.textContent =
        "✅ Transaction submitted — stock remains reserved while payment is checked.";

      countdown.classList.remove(
        "expired"
      );
    }

    if (
      btn
    ) {
      btn.textContent =
        "✅ Transaction Submitted";
    }

    try {
      tg
        ?.HapticFeedback
        ?.notificationOccurred(
          "success"
        );
    } catch {}

  } catch (
    err
  ) {
    console.error(
      "PAYMENT SUBMISSION ERROR:",
      err
    );

    setPaymentStatus(
      "Couldn't reach the server. Try again.",
      "error"
    );

  } finally {
    if (
      btn &&
      !paymentStatus
        ?.classList
        .contains(
          "success"
        )
    ) {
      btn.disabled =
        false;

      btn.textContent =
        "I've paid — submit transaction";
    }
  }
}


/* =========================================================
   BUTTON LISTENERS
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
    "applyStorewide"
  )
  ?.addEventListener(
    "click",
    applyStorewideCode
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
          behavior:
            "smooth"
        });
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

  if (
    handleInput &&
    !handleInput.value
  ) {
    handleInput.value =
      `@${telegramUser.username}`;
  }
}


/* =========================================================
   START SHOP
   ========================================================= */

loadProducts();