<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import {
    ArrowRight,
    BedDouble,
    ChevronDown,
    Clock3,
    Compass,
    Heart,
    Leaf,
    Menu,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    TreePine,
    UsersRound,
    X
  } from "lucide-svelte";

  type PropertyStatus = "available" | "request" | "waitlist";
  type PropertyFilter = "all" | "available" | "waitlist";

  interface CollectiveProperty {
    name: string;
    place: string;
    status: PropertyStatus;
    statusLabel: string;
    image: string;
    imageSource: string;
    alt: string;
    capacity: number;
    data: Array<{ label: string; value: string }>;
  }

  const properties: CollectiveProperty[] = [
    {
      name: "The Cedar House",
      place: "Olympic Peninsula, Washington",
      status: "available",
      statusLabel: "Available now",
      image: "/images/cabin-cedar.jpg",
      imageSource: "https://unsplash.com/photos/3pR7d-tIRx8",
      alt: "雪山和森林之间的木结构旅宿",
      capacity: 4,
      data: [
        { label: "Committed capital", value: "$1.82M" },
        { label: "Peak occupancy", value: "74%" },
        { label: "Member stay", value: "$286 / night" }
      ]
    },
    {
      name: "Casa Bruma",
      place: "Big Sur, California",
      status: "request",
      statusLabel: "Request to book",
      image: "/images/coastal-villa.jpg",
      imageSource: "https://unsplash.com/photos/VXs1GZowj2E",
      alt: "加州海岸线和临海森林",
      capacity: 6,
      data: [
        { label: "Committed capital", value: "$2.46M" },
        { label: "Peak occupancy", value: "81%" },
        { label: "Member stay", value: "$342 / night" }
      ]
    },
    {
      name: "Hollow Fir",
      place: "Sequoia Range, California",
      status: "waitlist",
      statusLabel: "Waitlist",
      image: "/images/forest-grove.jpg",
      imageSource: "https://www.theknot.com/content/redwood-wedding-venues",
      alt: "暮色中松林环绕的山间木屋",
      capacity: 8,
      data: [
        { label: "Committed capital", value: "$2.08M" },
        { label: "Peak occupancy", value: "69%" },
        { label: "Member stay", value: "$318 / night" }
      ]
    }
  ];

  const filterOptions: Array<{ label: string; value: PropertyFilter }> = [
    { label: "All properties", value: "all" },
    { label: "Available now", value: "available" },
    { label: "Waitlist", value: "waitlist" }
  ];

  let mobileMenuOpen = $state(false);
  let selectedFilter = $state<PropertyFilter>("all");
  let advancedFilterOpen = $state(false);
  let sleepingCapacity = $state(1);
  let favourites = $state<string[]>([]);

  const visibleProperties = $derived(
    properties.filter((property) => {
      const statusMatches =
        selectedFilter === "all" ||
        (selectedFilter === "available" && property.status !== "waitlist") ||
        property.status === selectedFilter;

      return statusMatches && property.capacity >= sleepingCapacity;
    })
  );

  function toggleFavourite(name: string) {
    favourites = favourites.includes(name)
      ? favourites.filter((favourite) => favourite !== name)
      : [...favourites, name];
  }

  function closeMobileMenu() {
    mobileMenuOpen = false;
  }
</script>

<svelte:head>
  <title>SupaCloud Infrastructure Collective</title>
  <meta
    name="description"
    content="Shared places, clear economics, and the people who make them work."
  />
</svelte:head>

<div class="collective-page">
  <header class="site-header">
    <a class="wordmark" href="#top" aria-label="SupaCloud Infrastructure Collective 首页">
      <span>SupaCloud</span>
      <small>Infrastructure Collective</small>
    </a>

    <nav class="desktop-nav" aria-label="主导航">
      <a href="#collection">The Collection</a>
      <a href="#membership">Membership</a>
      <a href="#operations">How it works</a>
      <a href="#journal">Field Notes</a>
    </nav>

    <div class="header-actions">
      <a class="text-link desktop-action" href={resolve("/login")}>Sign in</a>
      <a class="button button-small desktop-action" href={resolve("/login")}>
        Access your terminal
        <ArrowRight size={15} strokeWidth={1.8} />
      </a>
      <button
        class="icon-button menu-button"
        type="button"
        aria-label={mobileMenuOpen ? "关闭菜单" : "打开菜单"}
        aria-expanded={mobileMenuOpen}
        onclick={() => (mobileMenuOpen = !mobileMenuOpen)}
      >
        {#if mobileMenuOpen}
          <X size={21} />
        {:else}
          <Menu size={21} />
        {/if}
      </button>
    </div>
  </header>

  {#if mobileMenuOpen}
    <nav class="mobile-nav" aria-label="移动端导航">
      <a href="#collection" onclick={closeMobileMenu}>The Collection</a>
      <a href="#membership" onclick={closeMobileMenu}>Membership</a>
      <a href="#operations" onclick={closeMobileMenu}>How it works</a>
      <a href="#journal" onclick={closeMobileMenu}>Field Notes</a>
      <a class="button" href={resolve("/login")}>Access your terminal <ArrowRight size={15} /></a>
    </nav>
  {/if}

  <main id="top">
    <section class="hero section-shell">
      <div class="hero-copy">
        <p class="eyebrow">Places worth sharing. Systems worth trusting.</p>
        <h1>Shared places.<br />Clear economics.</h1>
        <p class="hero-intro">
          SupaCloud is a member-owned collection of remarkable places, operated with the same
          discipline as great infrastructure: transparent, resilient, and built for long-term use.
        </p>
        <div class="hero-actions">
          <a class="button" href="#membership">
            Join the collective
            <ArrowRight size={16} strokeWidth={1.8} />
          </a>
          <a class="underlined-link" href="#journal">View field notes</a>
        </div>

        <div class="founder-row" aria-label="Founding member">
          <div class="founder-portrait" aria-hidden="true">JC</div>
          <div>
            <p class="founder-quote">
              “We built the structure we wanted as owners: visible numbers, thoughtful stewardship,
              and places that become better with use.”
            </p>
            <p class="founder-name">Jordan Chen · Founding member</p>
          </div>
        </div>
      </div>

      <div class="terminal-visual" aria-label="示例资产运营终端">
        <img src="/images/hero-lodge.jpg" alt="山脉和森林之间的木结构旅宿" />
        <div class="visual-wash"></div>
        <div class="compass-mark" aria-hidden="true">
          <Compass size={24} strokeWidth={1.5} />
        </div>
        <div class="visual-panel">
          <div class="visual-heading">
            <div>
              <p>Collective asset · 01</p>
              <h2>Cathedral Lodge</h2>
            </div>
            <span class="status-dot">Operating</span>
          </div>
          <dl>
            <div><dt>Committed capital</dt><dd>$1,820,000</dd></div>
            <div><dt>Peak occupancy</dt><dd>74%</dd></div>
            <div><dt>Member rate</dt><dd>$286 / night</dd></div>
          </dl>
          <div class="visual-footer">
            <span><ShieldCheck size={15} /> Audited quarterly</span>
            <a href="https://entreedestinations.com/love-filled-honeymoon-destinations-canada/" target="_blank" rel="noreferrer">Image source ↗</a>
          </div>
        </div>
      </div>
    </section>

    <section class="trust-strip" aria-label="Collective highlights">
      <div><strong>$48.6M</strong><span>Collective assets</span></div>
      <div><strong>97.4%</strong><span>Capital deployed</span></div>
      <div><strong>16</strong><span>Operating regions</span></div>
      <blockquote>“Radically clearer than a conventional second-home structure.” <cite>— Field & Form</cite></blockquote>
    </section>

    <section class="story-section section-shell" id="operations">
      <div class="section-heading split-heading">
        <div>
          <p class="eyebrow">What makes SupaCloud different</p>
          <h2>A collective that reads like a balance sheet and feels like a home.</h2>
        </div>
        <p>
          Members can see how every place performs, what it costs to maintain, and which decisions
          are coming next. The result is shared infrastructure without the usual opacity.
        </p>
      </div>

      <div class="feature-layout">
        <div class="feature-list">
          <article>
            <span>01</span>
            <div><h3>Material ownership</h3><p>Every membership is tied to real places, real operating data, and a durable governance model.</p></div>
          </article>
          <article>
            <span>02</span>
            <div><h3>Hospitality-grade operations</h3><p>Local stewards, preventative maintenance, and consistent service keep each place ready.</p></div>
          </article>
          <article>
            <span>03</span>
            <div><h3>Quiet technology</h3><p>The terminal handles booking, reporting, voting, and records without getting in the way.</p></div>
          </article>
        </div>
        <figure class="editorial-image">
          <img src="/images/forest-glass.jpg" alt="茂密森林中的自然景观" />
          <figcaption><span>Field study 07</span><span>Pacific Northwest</span></figcaption>
        </figure>
      </div>
    </section>

    <section class="principles-band" id="membership">
      <div class="section-shell principles-inner">
        <div class="principles-copy">
          <p class="eyebrow eyebrow-light">Membership principles</p>
          <h2>Built to be used, understood, and handed forward.</h2>
          <p>
            Clear entry terms. Shared operating reserves. A simple path to transfer. Members spend
            less time decoding the structure and more time shaping the places.
          </p>
          <a class="button button-light" href={resolve("/login")}>Review the membership brief <ArrowRight size={16} /></a>
        </div>
        <div class="principle-grid">
          <article><Leaf size={24} strokeWidth={1.5} /><h3>Stewardship first</h3><p>Local materials, measured maintenance, and long-term ecological care.</p></article>
          <article><UsersRound size={24} strokeWidth={1.5} /><h3>One member, one voice</h3><p>Core operating decisions stay legible and collectively governed.</p></article>
          <article><Sparkles size={24} strokeWidth={1.5} /><h3>Designed for return</h3><p>Every stay should deepen the relationship between members and place.</p></article>
          <article><TreePine size={24} strokeWidth={1.5} /><h3>Distinct by nature</h3><p>No repeating template. Each property follows its landscape and local craft.</p></article>
        </div>
      </div>
    </section>

    <section class="collection-section section-shell" id="collection">
      <div class="section-heading collection-heading">
        <div>
          <p class="eyebrow">The collection</p>
          <h2>Where the collective takes shape.</h2>
        </div>
        <p>
          {visibleProperties.length}
          {visibleProperties.length === 1 ? "place matches" : "places match"} your current view.
        </p>
      </div>

      <div class="filter-row">
        <div class="filter-tabs" aria-label="按可用状态筛选">
          {#each filterOptions as option (option.value)}
            <button
              type="button"
              class:active={selectedFilter === option.value}
              aria-pressed={selectedFilter === option.value}
              onclick={() => (selectedFilter = option.value)}
            >{option.label}</button>
          {/each}
        </div>
        <button
          class="advanced-filter-button"
          class:active={advancedFilterOpen}
          type="button"
          aria-expanded={advancedFilterOpen}
          onclick={() => (advancedFilterOpen = !advancedFilterOpen)}
        >
          <SlidersHorizontal size={15} />
          Advanced filters
          <ChevronDown size={14} class={advancedFilterOpen ? "rotated" : ""} />
        </button>
      </div>

      {#if advancedFilterOpen}
        <div class="advanced-panel">
          <label for="capacity">Minimum sleeping capacity</label>
          <input
            id="capacity"
            type="range"
            min="1"
            max="8"
            step="1"
            value={sleepingCapacity}
            oninput={(event) => (sleepingCapacity = Number(event.currentTarget.value))}
          />
          <output for="capacity">{sleepingCapacity}+ guests</output>
        </div>
      {/if}

      {#if visibleProperties.length > 0}
        <div class="property-grid">
          {#each visibleProperties as property (property.name)}
            <article class="property-card">
              <div class="property-image">
                <img src={property.image} alt={property.alt} />
                <span class:waitlist={property.status === "waitlist"}>{property.statusLabel}</span>
                <button
                  class="favourite-button"
                  class:favourited={favourites.includes(property.name)}
                  type="button"
                  aria-label={favourites.includes(property.name) ? `取消收藏 ${property.name}` : `收藏 ${property.name}`}
                  aria-pressed={favourites.includes(property.name)}
                  title={favourites.includes(property.name) ? "Remove from favourites" : "Save to favourites"}
                  onclick={() => toggleFavourite(property.name)}
                >
                  <Heart size={17} fill={favourites.includes(property.name) ? "currentColor" : "none"} />
                </button>
                <button
                  class="image-credit"
                  type="button"
                  onclick={() => window.open(property.imageSource, "_blank", "noopener,noreferrer")}
                >Source ↗</button>
              </div>
              <div class="property-body">
                <div class="property-title-row">
                  <div><h3>{property.name}</h3><p>{property.place}</p></div>
                  <span><BedDouble size={15} /> Sleeps {property.capacity}</span>
                </div>
                <dl>
                  {#each property.data as row (row.label)}
                    <div><dt>{row.label}</dt><dd>{row.value}</dd></div>
                  {/each}
                </dl>
                <button class="property-action" type="button" onclick={() => goto(resolve("/login"))}>
                  Open field record
                  <ArrowRight size={15} />
                </button>
              </div>
            </article>
          {/each}
        </div>
      {:else}
        <div class="empty-state">
          <TreePine size={28} strokeWidth={1.4} />
          <p>No place currently matches this sleeping capacity.</p>
          <button type="button" onclick={() => (sleepingCapacity = 1)}>Reset capacity</button>
        </div>
      {/if}
    </section>

    <section class="journal-section" id="journal">
      <div class="section-shell journal-grid">
        <div>
          <p class="eyebrow">Field notes · issue 04</p>
          <h2>The work behind an effortless stay.</h2>
        </div>
        <article>
          <div class="article-meta"><span><Clock3 size={14} /> 8 minute read</span><span>Operations</span></div>
          <p>
            What a year of weather logs, maintenance calls, and member feedback taught us about
            designing a resilient place at the edge of the forest.
          </p>
          <a class="underlined-link" href={resolve("/login")}>Read the field note</a>
        </article>
      </div>
    </section>

    <section class="final-cta section-shell">
      <div>
        <p class="eyebrow">The next place starts with the right people.</p>
        <h2>Join the collective.</h2>
      </div>
      <div>
        <p>Review current openings, member economics, and the operating calendar inside the SupaCloud terminal.</p>
        <a class="button" href={resolve("/login")}>Access your terminal <ArrowRight size={16} /></a>
      </div>
    </section>
  </main>

  <footer>
    <div class="wordmark wordmark-light"><span>SupaCloud</span><small>Infrastructure Collective</small></div>
    <p>Shared places. Clear economics. Built for return.</p>
    <div><a href="#operations">How it works</a><a href="#journal">Field Notes</a><a href={resolve("/login")}>Sign in</a></div>
  </footer>
</div>

<style>
  :global(html) {
    scroll-behavior: smooth;
  }

  :global(body) {
    margin: 0;
  }

  .collective-page {
    --ink: #213d36;
    --ink-soft: #476258;
    --forest: #173d32;
    --forest-deep: #102f27;
    --mist: #eef2e8;
    --paper: #f7f8f1;
    --line: #cdd7c9;
    --clay: #8a5e48;
    min-height: 100%;
    color: var(--ink);
    background: var(--paper);
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  .site-header,
  .section-shell,
  .trust-strip,
  footer {
    width: min(100% - 48px, 1380px);
    margin-inline: auto;
  }

  .site-header {
    height: 84px;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 28px;
    border-bottom: 1px solid var(--line);
    position: relative;
    z-index: 20;
  }

  .wordmark {
    width: max-content;
    display: flex;
    flex-direction: column;
    color: var(--ink);
    text-decoration: none;
    line-height: 1;
  }

  .wordmark span {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .wordmark small {
    margin-top: 5px;
    font-size: 8px;
    font-weight: 700;
    letter-spacing: 0.19em;
    text-transform: uppercase;
  }

  .desktop-nav,
  .header-actions,
  .hero-actions,
  .filter-row,
  .filter-tabs,
  .visual-footer,
  .article-meta,
  footer div:last-child {
    display: flex;
    align-items: center;
  }

  .desktop-nav {
    gap: 32px;
  }

  .desktop-nav a,
  .text-link,
  footer a {
    color: currentColor;
    text-decoration: none;
    font-size: 12px;
    font-weight: 700;
  }

  .desktop-nav a:hover,
  .text-link:hover,
  footer a:hover {
    color: var(--clay);
  }

  .header-actions {
    justify-content: flex-end;
    gap: 18px;
  }

  .button {
    width: fit-content;
    min-height: 46px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 0 21px;
    border: 1px solid var(--ink);
    border-radius: 8px;
    color: #fff;
    background: var(--ink);
    font-size: 12px;
    font-weight: 800;
    text-decoration: none;
    transition: background 160ms ease, color 160ms ease, transform 160ms ease;
  }

  .button:hover {
    color: var(--ink);
    background: transparent;
    transform: translateY(-1px);
  }

  .button-small {
    min-height: 40px;
    padding-inline: 16px;
  }

  .button-light {
    color: var(--forest-deep);
    background: var(--paper);
    border-color: var(--paper);
  }

  .button-light:hover {
    color: var(--paper);
    border-color: #82998d;
  }

  .icon-button {
    width: 42px;
    height: 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--line);
    border-radius: 8px;
    color: var(--ink);
    background: transparent;
  }

  .menu-button,
  .mobile-nav {
    display: none;
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 0.96fr) minmax(430px, 0.76fr);
    gap: clamp(56px, 8vw, 124px);
    align-items: center;
    padding-block: clamp(68px, 8vw, 124px) clamp(80px, 9vw, 136px);
  }

  .eyebrow {
    margin: 0 0 22px;
    color: var(--clay);
    font-size: 10px;
    font-weight: 900;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .hero h1,
  .section-heading h2,
  .principles-copy h2,
  .journal-grid h2,
  .final-cta h2 {
    margin: 0;
    font-family: Georgia, "Times New Roman", serif;
    font-weight: 500;
    letter-spacing: -0.045em;
    text-wrap: balance;
  }

  .hero h1 {
    max-width: 720px;
    font-size: clamp(3.5rem, 6.4vw, 6rem);
    line-height: 0.94;
  }

  .hero-intro {
    max-width: 620px;
    margin: 32px 0 0;
    color: var(--ink-soft);
    font-family: Georgia, "Times New Roman", serif;
    font-size: clamp(18px, 2vw, 24px);
    line-height: 1.55;
  }

  .hero-actions {
    gap: 24px;
    margin-top: 36px;
  }

  .underlined-link {
    padding-block: 5px;
    color: var(--ink);
    border-bottom: 1px solid currentColor;
    font-size: 12px;
    font-weight: 800;
    text-decoration: none;
  }

  .founder-row {
    max-width: 630px;
    margin-top: 62px;
    padding-top: 26px;
    display: grid;
    grid-template-columns: 48px 1fr;
    gap: 16px;
    border-top: 1px solid var(--line);
  }

  .founder-portrait {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: #fff;
    background: var(--clay);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 13px;
  }

  .founder-quote,
  .founder-name {
    margin: 0;
  }

  .founder-quote {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 16px;
    line-height: 1.55;
  }

  .founder-name {
    margin-top: 7px;
    color: var(--ink-soft);
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .terminal-visual {
    min-height: 650px;
    position: relative;
    overflow: hidden;
    border: 1px solid #b9c6b9;
    border-radius: 14px;
    background: #d9e2d7;
  }

  .terminal-visual > img {
    width: 100%;
    height: 100%;
    position: absolute;
    inset: 0;
    object-fit: cover;
  }

  .visual-wash {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(15, 43, 35, 0.06) 18%, rgba(15, 43, 35, 0.7) 100%);
  }

  .compass-mark {
    width: 52px;
    height: 52px;
    display: grid;
    place-items: center;
    position: absolute;
    top: 22px;
    right: 22px;
    color: var(--ink);
    border-radius: 50%;
    background: rgba(247, 248, 241, 0.9);
  }

  .visual-panel {
    position: absolute;
    inset: auto 20px 20px;
    padding: 24px;
    color: var(--ink);
    border: 1px solid rgba(255, 255, 255, 0.6);
    border-radius: 12px;
    background: rgba(247, 248, 241, 0.93);
    backdrop-filter: blur(14px);
  }

  .visual-heading,
  .property-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 18px;
  }

  .visual-heading p,
  .visual-heading h2,
  .property-title-row h3,
  .property-title-row p {
    margin: 0;
  }

  .visual-heading p {
    color: var(--ink-soft);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .visual-heading h2 {
    margin-top: 5px;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 28px;
  }

  .status-dot {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .status-dot::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #4b806b;
  }

  .visual-panel dl,
  .property-card dl {
    margin: 22px 0 0;
  }

  .visual-panel dl div,
  .property-card dl div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 11px 0;
    border-top: 1px solid var(--line);
  }

  dt {
    color: var(--ink-soft);
    font-size: 10px;
    font-weight: 700;
  }

  dd {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    font-weight: 800;
  }

  .visual-footer {
    justify-content: space-between;
    gap: 16px;
    padding-top: 18px;
    font-size: 9px;
    font-weight: 800;
  }

  .visual-footer span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .visual-footer a {
    color: var(--ink-soft);
  }

  .trust-strip {
    display: grid;
    grid-template-columns: repeat(3, minmax(120px, 0.7fr)) minmax(300px, 1.4fr);
    border-block: 1px solid var(--line);
  }

  .trust-strip > * {
    min-height: 118px;
    padding: 26px 30px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    border-right: 1px solid var(--line);
  }

  .trust-strip > *:last-child {
    border-right: 0;
  }

  .trust-strip strong {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 31px;
    font-weight: 500;
  }

  .trust-strip span,
  .trust-strip cite {
    color: var(--ink-soft);
    font-size: 9px;
    font-style: normal;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .trust-strip blockquote {
    margin: 0;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 15px;
    line-height: 1.5;
  }

  .trust-strip cite {
    margin-top: 7px;
  }

  .story-section,
  .collection-section,
  .final-cta {
    padding-block: clamp(88px, 10vw, 150px);
  }

  .section-heading h2,
  .principles-copy h2,
  .journal-grid h2,
  .final-cta h2 {
    font-size: clamp(2.6rem, 4.6vw, 4.8rem);
    line-height: 1.02;
  }

  .split-heading {
    display: grid;
    grid-template-columns: 1.3fr 0.7fr;
    gap: 90px;
    align-items: end;
  }

  .split-heading > p,
  .collection-heading > p,
  .principles-copy > p,
  .journal-grid article > p,
  .final-cta > div:last-child > p {
    margin: 0;
    color: var(--ink-soft);
    font-family: Georgia, "Times New Roman", serif;
    font-size: 17px;
    line-height: 1.65;
  }

  .feature-layout {
    margin-top: 86px;
    display: grid;
    grid-template-columns: minmax(0, 0.8fr) minmax(480px, 1.2fr);
    gap: clamp(50px, 8vw, 120px);
    align-items: center;
  }

  .feature-list article {
    display: grid;
    grid-template-columns: 38px 1fr;
    gap: 22px;
    padding-block: 26px;
    border-top: 1px solid var(--line);
  }

  .feature-list article:last-child {
    border-bottom: 1px solid var(--line);
  }

  .feature-list article > span {
    color: var(--clay);
    font-size: 10px;
    font-weight: 900;
  }

  .feature-list h3,
  .feature-list p,
  .principle-grid h3,
  .principle-grid p {
    margin: 0;
  }

  .feature-list h3,
  .principle-grid h3 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 22px;
    font-weight: 500;
  }

  .feature-list p,
  .principle-grid p {
    margin-top: 9px;
    color: var(--ink-soft);
    font-size: 13px;
    line-height: 1.65;
  }

  .editorial-image {
    margin: 0;
  }

  .editorial-image img {
    width: 100%;
    aspect-ratio: 1.42;
    display: block;
    object-fit: cover;
    border-radius: 12px;
    filter: saturate(0.76) contrast(0.96);
  }

  .editorial-image figcaption {
    padding-top: 13px;
    display: flex;
    justify-content: space-between;
    color: var(--ink-soft);
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .principles-band {
    color: #f1f2e8;
    background: var(--forest-deep);
  }

  .principles-inner {
    padding-block: clamp(86px, 10vw, 146px);
    display: grid;
    grid-template-columns: 0.85fr 1.15fr;
    gap: clamp(70px, 10vw, 150px);
    align-items: center;
  }

  .eyebrow-light {
    color: #c9a890;
  }

  .principles-copy > p {
    margin-top: 26px;
    color: #b7c6bd;
  }

  .principles-copy .button {
    margin-top: 34px;
  }

  .principle-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .principle-grid article {
    min-height: 230px;
    padding: 30px;
    border-top: 1px solid #456258;
    border-left: 1px solid #456258;
  }

  .principle-grid article:nth-child(2n) {
    border-right: 1px solid #456258;
  }

  .principle-grid article:nth-last-child(-n + 2) {
    border-bottom: 1px solid #456258;
  }

  .principle-grid h3 {
    margin-top: 36px;
    color: #f4f4e9;
  }

  .principle-grid p {
    color: #aabbb1;
  }

  .collection-heading {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 30px;
  }

  .collection-heading > p {
    font-size: 14px;
  }

  .filter-row {
    margin-top: 54px;
    padding-block: 15px;
    justify-content: space-between;
    gap: 20px;
    border-block: 1px solid var(--line);
  }

  .filter-tabs {
    gap: 4px;
  }

  .filter-tabs button,
  .advanced-filter-button,
  .property-action,
  .empty-state button {
    border: 0;
    color: var(--ink-soft);
    background: transparent;
    font-size: 11px;
    font-weight: 800;
  }

  .filter-tabs button {
    min-height: 36px;
    padding-inline: 14px;
    border-radius: 7px;
  }

  .filter-tabs button.active {
    color: #fff;
    background: var(--ink);
  }

  .advanced-filter-button {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--ink);
  }

  .advanced-filter-button :global(svg:last-child) {
    transition: transform 160ms ease;
  }

  .advanced-filter-button :global(svg.rotated) {
    transform: rotate(180deg);
  }

  .advanced-panel {
    display: grid;
    grid-template-columns: auto minmax(180px, 1fr) 80px;
    gap: 18px;
    align-items: center;
    padding: 20px;
    border-bottom: 1px solid var(--line);
    background: var(--mist);
    font-size: 11px;
    font-weight: 800;
  }

  .advanced-panel input {
    width: 100%;
    accent-color: var(--forest);
  }

  .advanced-panel output {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  .property-grid {
    margin-top: 38px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 24px;
  }

  .property-card {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.5);
  }

  .property-image {
    aspect-ratio: 1.32;
    position: relative;
    overflow: hidden;
    background: #d9e2d7;
  }

  .property-image img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    transition: transform 450ms ease;
  }

  .property-card:hover .property-image img {
    transform: scale(1.025);
  }

  .property-image > span {
    position: absolute;
    top: 14px;
    left: 14px;
    padding: 7px 9px;
    border-radius: 5px;
    color: #fff;
    background: var(--forest);
    font-size: 8px;
    font-weight: 900;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .property-image > span.waitlist {
    color: var(--ink);
    background: #e3decf;
  }

  .favourite-button {
    width: 38px;
    height: 38px;
    display: grid;
    place-items: center;
    position: absolute;
    top: 12px;
    right: 12px;
    border: 0;
    border-radius: 50%;
    color: var(--ink);
    background: rgba(247, 248, 241, 0.9);
  }

  .favourite-button.favourited {
    color: #9a5944;
  }

  .image-credit {
    position: absolute;
    right: 11px;
    bottom: 9px;
    padding: 4px 6px;
    border: 0;
    color: #fff;
    border-radius: 4px;
    background: rgba(16, 47, 39, 0.62);
    font-size: 8px;
    font-weight: 800;
    text-decoration: none;
  }

  .property-body {
    padding: 22px;
  }

  .property-title-row h3 {
    font-family: Georgia, "Times New Roman", serif;
    font-size: 24px;
    font-weight: 500;
  }

  .property-title-row p {
    margin-top: 5px;
    color: var(--ink-soft);
    font-size: 10px;
  }

  .property-title-row > span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    color: var(--ink-soft);
    font-size: 9px;
    font-weight: 800;
  }

  .property-action {
    width: 100%;
    margin-top: 20px;
    padding-top: 17px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--ink);
    border-top: 1px solid var(--line);
  }

  .empty-state {
    margin-top: 38px;
    padding: 60px 24px;
    display: grid;
    justify-items: center;
    gap: 14px;
    color: var(--ink-soft);
    border: 1px solid var(--line);
  }

  .empty-state p {
    margin: 0;
  }

  .empty-state button {
    color: var(--ink);
    border-bottom: 1px solid currentColor;
  }

  .journal-section {
    color: var(--ink);
    background: var(--mist);
  }

  .journal-grid {
    padding-block: clamp(80px, 8vw, 120px);
    display: grid;
    grid-template-columns: 1fr 0.8fr;
    gap: 100px;
    align-items: end;
  }

  .article-meta {
    justify-content: space-between;
    gap: 18px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--line);
    color: var(--ink-soft);
    font-size: 9px;
    font-weight: 900;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  .article-meta span:first-child {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }

  .journal-grid article > p {
    margin-top: 24px;
  }

  .journal-grid article .underlined-link {
    display: inline-block;
    margin-top: 22px;
  }

  .final-cta {
    display: grid;
    grid-template-columns: 1.25fr 0.75fr;
    gap: 100px;
    align-items: end;
  }

  .final-cta > div:last-child .button {
    margin-top: 28px;
  }

  footer {
    min-height: 150px;
    padding-block: 40px;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 30px;
    color: #dce5dd;
    border-top: 1px solid #36564c;
    background: var(--forest-deep);
    box-shadow: 0 0 0 100vmax var(--forest-deep);
    clip-path: inset(0 -100vmax);
  }

  .wordmark-light {
    color: #eef3ec;
  }

  footer p {
    margin: 0;
    color: #99aea3;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 13px;
    text-align: center;
  }

  footer div:last-child {
    justify-content: flex-end;
    gap: 22px;
  }

  @media (max-width: 1100px) {
    .site-header {
      grid-template-columns: 1fr 1fr;
    }

    .desktop-nav {
      display: none;
    }

    .hero {
      grid-template-columns: 1fr 0.82fr;
      gap: 44px;
    }

    .hero h1 {
      font-size: clamp(3.2rem, 6vw, 4.8rem);
    }

    .terminal-visual {
      min-height: 590px;
    }

    .trust-strip {
      grid-template-columns: repeat(3, 1fr);
    }

    .trust-strip blockquote {
      grid-column: 1 / -1;
      border-top: 1px solid var(--line);
    }

    .trust-strip > :nth-child(3) {
      border-right: 0;
    }

    .feature-layout {
      grid-template-columns: 0.9fr 1.1fr;
      gap: 48px;
    }

    .principles-inner {
      grid-template-columns: 0.75fr 1.25fr;
      gap: 60px;
    }

    .property-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 800px) {
    .site-header,
    .section-shell,
    .trust-strip,
    footer {
      width: min(100% - 32px, 1380px);
    }

    .site-header {
      height: 72px;
    }

    .desktop-action {
      display: none;
    }

    .menu-button {
      display: inline-flex;
    }

    .mobile-nav {
      width: calc(100% - 32px);
      margin-inline: auto;
      padding: 24px;
      display: grid;
      gap: 18px;
      position: absolute;
      top: 76px;
      left: 16px;
      z-index: 30;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(247, 248, 241, 0.98);
      box-shadow: 0 18px 50px rgba(32, 61, 52, 0.16);
    }

    .mobile-nav > a:not(.button) {
      color: var(--ink);
      font-family: Georgia, "Times New Roman", serif;
      font-size: 20px;
      text-decoration: none;
    }

    .hero,
    .split-heading,
    .feature-layout,
    .principles-inner,
    .journal-grid,
    .final-cta {
      grid-template-columns: 1fr;
    }

    .hero {
      gap: 54px;
      padding-block: 64px 80px;
    }

    .hero h1 {
      font-size: clamp(3.35rem, 14vw, 5.3rem);
    }

    .hero-intro {
      font-size: 19px;
    }

    .terminal-visual {
      min-height: 610px;
    }

    .trust-strip {
      grid-template-columns: 1fr;
    }

    .trust-strip > * {
      min-height: 96px;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .trust-strip > *:last-child {
      border-bottom: 0;
    }

    .split-heading,
    .feature-layout,
    .principles-inner,
    .journal-grid,
    .final-cta {
      gap: 48px;
    }

    .feature-layout {
      margin-top: 58px;
    }

    .editorial-image {
      order: -1;
    }

    .principle-grid {
      margin-top: 12px;
    }

    .principle-grid article {
      min-height: 210px;
      padding: 24px;
    }

    .collection-heading,
    .filter-row {
      align-items: flex-start;
      flex-direction: column;
    }

    .filter-tabs {
      width: 100%;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .filter-tabs button {
      flex: 0 0 auto;
    }

    .advanced-panel {
      grid-template-columns: 1fr 70px;
    }

    .advanced-panel label {
      grid-column: 1 / -1;
    }

    .property-grid {
      grid-template-columns: 1fr;
    }

    footer {
      grid-template-columns: 1fr;
      justify-items: start;
    }

    footer p {
      text-align: left;
    }

    footer div:last-child {
      justify-content: flex-start;
      flex-wrap: wrap;
    }
  }

  @media (max-width: 480px) {
    .site-header,
    .section-shell,
    .trust-strip,
    footer {
      width: min(100% - 24px, 1380px);
    }

    .wordmark span {
      font-size: 20px;
    }

    .hero h1 {
      font-size: clamp(3rem, 16vw, 4.25rem);
    }

    .hero-actions {
      align-items: flex-start;
      flex-direction: column;
    }

    .founder-row {
      grid-template-columns: 1fr;
    }

    .terminal-visual {
      min-height: 560px;
    }

    .visual-panel {
      inset: auto 10px 10px;
      padding: 18px;
    }

    .visual-heading {
      flex-direction: column;
    }

    .visual-footer {
      align-items: flex-start;
      flex-direction: column;
    }

    .principle-grid {
      grid-template-columns: 1fr;
    }

    .principle-grid article,
    .principle-grid article:nth-child(2n),
    .principle-grid article:nth-last-child(-n + 2) {
      border: 0;
      border-top: 1px solid #456258;
    }

    .principle-grid article:last-child {
      border-bottom: 1px solid #456258;
    }

    .property-title-row {
      flex-direction: column;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(html) {
      scroll-behavior: auto;
    }

    *,
    *::before,
    *::after {
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
