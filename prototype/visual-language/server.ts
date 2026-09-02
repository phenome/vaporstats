// Throwaway prototype: three VaporStats visual-language directions, switchable with ?variant=A|B|C.
const switcher = process.env.NODE_ENV === "production" ? "" : `
  <nav class="prototype-switcher" aria-label="Prototype variant switcher">
    <button type="button" data-step="-1" aria-label="Previous variant">←</button>
    <output id="variant-label" aria-live="polite"></output>
    <button type="button" data-step="1" aria-label="Next variant">→</button>
  </nav>`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VaporStats visual-language prototype</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-variant-numeric: tabular-nums;
      --radius: .42rem;
      --focus: #f59e76;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 320px; }
    button, input { font: inherit; }
    button, a { -webkit-tap-highlight-color: transparent; }
    a { color: inherit; }
    :focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
    [hidden] { display: none !important; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
    .prototype-switcher {
      position: fixed; z-index: 100; left: 50%; bottom: 18px; transform: translateX(-50%);
      display: grid; grid-template-columns: 42px minmax(180px, auto) 42px; align-items: center;
      padding: 6px; color: #f8fafc; background: #09090b; border: 1px solid #3f3f46;
      border-radius: 999px; box-shadow: 0 14px 40px #000a;
    }
    .prototype-switcher button { height: 36px; border: 0; border-radius: 999px; color: inherit; background: #27272a; cursor: pointer; }
    .prototype-switcher button:hover { background: #3f3f46; }
    .prototype-switcher output { padding: 0 14px; text-align: center; font-size: .78rem; font-weight: 750; letter-spacing: .02em; }

    /* A — Command Deck: metric-led, dark, modular. */
    .variant-a { min-height: 100vh; color: #e8edf3; background: #0b0f14; --line: #26303b; --muted: #8e9aa8; --accent: #f27d55; }
    .a-topbar { height: 62px; display: flex; align-items: center; gap: 28px; padding: 0 max(24px, calc((100vw - 1240px)/2)); border-bottom: 1px solid var(--line); background: #0d1218e8; backdrop-filter: blur(12px); }
    .a-brand { display: flex; align-items: center; gap: 9px; font-weight: 850; letter-spacing: -.03em; text-decoration: none; }
    .a-mark { width: 26px; height: 26px; display: grid; place-items: center; color: #11151a; background: var(--accent); border-radius: 7px 2px 7px 2px; }
    .a-nav { display: flex; gap: 20px; color: var(--muted); font-size: .86rem; }
    .a-nav a { text-decoration: none; }
    .a-nav a:hover { color: white; }
    .a-search { margin-left: auto; width: min(280px, 28vw); padding: 9px 12px; color: white; background: #141a21; border: 1px solid var(--line); border-radius: var(--radius); }
    .a-main { max-width: 1240px; margin: auto; padding: 30px 24px 110px; }
    .a-breadcrumb { color: var(--muted); font-size: .78rem; }
    .a-hero { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 30px; align-items: end; padding: 22px 0 26px; }
    .a-game { display: flex; align-items: center; gap: 18px; }
    .a-cover { width: 76px; height: 76px; display: grid; place-items: end start; padding: 8px; border: 1px solid #e9966444; border-radius: 12px; background: linear-gradient(140deg,#27394e,#13202d 45%,#ea764f); box-shadow: inset 0 0 35px #0008; font-size: .65rem; font-weight: 800; }
    .a-kicker { color: var(--accent); font-size: .71rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .a-hero h1 { margin: 3px 0 5px; font-size: clamp(1.75rem,4vw,2.65rem); letter-spacing: -.055em; }
    .a-sub { margin: 0; color: var(--muted); font-size: .82rem; }
    .a-price { text-align: right; }
    .a-price strong { display: block; font-size: 1.65rem; }
    .a-sale { color: #8de1ab; font-size: .78rem; font-weight: 750; }
    .a-metrics { display: grid; grid-template-columns: repeat(4,1fr); border: 1px solid var(--line); border-radius: var(--radius); background: #10161d; }
    .a-metric { padding: 17px 18px; border-right: 1px solid var(--line); }
    .a-metric:last-child { border: 0; }
    .metric-label { color: var(--muted); font-size: .69rem; font-weight: 720; letter-spacing: .08em; text-transform: uppercase; }
    .metric-value { display: block; margin-top: 8px; font-size: clamp(1.15rem,3vw,1.72rem); font-weight: 790; letter-spacing: -.04em; }
    .metric-detail { color: var(--muted); font-size: .72rem; }
    .up { color: #8de1ab; }
    .a-grid { display: grid; grid-template-columns: minmax(0,2fr) minmax(280px,1fr); gap: 16px; margin-top: 16px; }
    .a-panel { padding: 19px; border: 1px solid var(--line); border-radius: var(--radius); background: #10161d; }
    .panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 15px; }
    .panel-head h2 { margin: 0; font-size: .93rem; }
    .panel-head p { margin: 4px 0 0; color: var(--muted); font-size: .71rem; }
    .range { display: flex; gap: 3px; }
    .range button { padding: 5px 7px; color: var(--muted); background: transparent; border: 0; border-radius: 4px; font-size: .69rem; cursor: pointer; }
    .range .active { color: white; background: #29323c; }
    .chart { width: 100%; height: auto; display: block; }
    .chart-grid { stroke: #34404c; stroke-width: 1; }
    .a-table { width: 100%; border-collapse: collapse; font-size: .78rem; }
    .a-table th { padding: 8px 0; color: var(--muted); font-size: .66rem; text-align: left; text-transform: uppercase; }
    .a-table td { padding: 10px 0; border-top: 1px solid var(--line); }
    .a-table td:last-child, .a-table th:last-child { text-align: right; }
    .a-ad { min-height: 88px; display: grid; place-items: center; margin: 16px 0; color: #667383; border: 1px dashed #34404c; border-radius: var(--radius); font-size: .65rem; letter-spacing: .1em; text-transform: uppercase; }
    .a-related { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .a-related article { display: flex; justify-content: space-between; gap: 10px; padding: 14px; border: 1px solid var(--line); border-radius: var(--radius); background: #10161d; font-size: .8rem; }
    .tag { display: inline-block; margin-top: 3px; color: var(--muted); font-size: .66rem; text-transform: uppercase; }

    /* B — Field Notes: editorial, light, narrative. */
    .variant-b { min-height: 100vh; color: #20231f; background: #f1f0e8; --ink: #20231f; --paper: #f7f6ef; --rule: #c9c8bd; --green: #31594d; --rust: #b34d2e; }
    .b-header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 22px max(26px, calc((100vw - 1320px)/2)); border-bottom: 1px solid var(--rule); }
    .b-header strong { font-family: Georgia, serif; font-size: 1.3rem; letter-spacing: -.03em; }
    .b-header nav { display: flex; gap: 22px; font-size: .76rem; font-weight: 750; text-transform: uppercase; }
    .b-header nav a { text-decoration: none; }
    .b-header button { justify-self: end; padding: 7px 12px; color: inherit; border: 1px solid currentColor; background: transparent; cursor: pointer; }
    .b-main { max-width: 1320px; margin: auto; padding: 42px 26px 110px; }
    .b-edition { display: flex; justify-content: space-between; padding-bottom: 9px; border-bottom: 3px solid var(--ink); font-size: .66rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    .b-title { display: grid; grid-template-columns: 1.35fr .65fr; gap: 42px; align-items: end; padding: 30px 0; }
    .b-title h1 { max-width: 780px; margin: 0; font-family: Georgia, serif; font-size: clamp(2.8rem,7vw,6.5rem); font-weight: 500; line-height: .88; letter-spacing: -.065em; }
    .b-title-copy { border-left: 1px solid var(--rule); padding-left: 24px; }
    .b-title-copy p { margin: 0 0 18px; color: #53574f; line-height: 1.55; }
    .b-now { display: inline-flex; align-items: baseline; gap: 12px; }
    .b-now strong { font-family: Georgia,serif; font-size: 2rem; }
    .b-now span { color: var(--green); font-size: .75rem; font-weight: 800; }
    .b-layout { display: grid; grid-template-columns: 180px minmax(0,1fr) 280px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
    .b-index { padding: 26px 20px 26px 0; border-right: 1px solid var(--rule); }
    .b-index a { display: block; padding: 10px 0; color: #5c6058; font-size: .74rem; text-decoration: none; }
    .b-index a:first-of-type { color: var(--rust); font-weight: 800; }
    .b-story { padding: 26px 34px; }
    .b-story h2, .b-price-card h2, .b-related h2 { margin: 0 0 4px; font-family: Georgia,serif; font-size: 1.5rem; font-weight: 500; }
    .b-deck { margin: 0 0 20px; color: #696d65; font-size: .78rem; }
    .b-sidebar { padding: 26px 0 26px 22px; border-left: 1px solid var(--rule); }
    .b-fact { padding: 14px 0; border-bottom: 1px solid var(--rule); }
    .b-fact:first-child { padding-top: 0; }
    .b-fact small { display: block; color: #6c7068; font-size: .65rem; letter-spacing: .08em; text-transform: uppercase; }
    .b-fact strong { display: block; margin-top: 4px; font-family: Georgia,serif; font-size: 1.25rem; }
    .b-price-card { display: grid; grid-template-columns: 1fr 1.5fr; gap: 38px; margin-top: 34px; padding: 28px; color: #f5f1e6; background: var(--green); }
    .b-price-number { align-self: center; }
    .b-price-number strong { display: block; font-family: Georgia,serif; font-size: 3.2rem; font-weight: 500; }
    .b-price-number span { display: inline-block; padding: 3px 7px; color: #17332b; background: #bde2bd; font-size: .72rem; font-weight: 800; }
    .b-ad { min-height: 76px; display: grid; place-items: center; margin: 28px 0; color: #86877f; border-block: 1px solid var(--rule); font-size: .63rem; letter-spacing: .12em; text-transform: uppercase; }
    .b-related-list { display: grid; grid-template-columns: repeat(3,1fr); border-top: 1px solid var(--ink); }
    .b-related-list article { padding: 18px 18px 18px 0; border-right: 1px solid var(--rule); }
    .b-related-list article + article { padding-left: 18px; }
    .b-related-list article:last-child { border: 0; }
    .b-related-list strong { display: block; font-family: Georgia,serif; }
    .b-related-list span { color: #666a62; font-size: .72rem; }

    /* C — Ledger: dense split-pane analytical workspace. */
    .variant-c { min-height: 100vh; color: #dbe4e7; background: #111719; --cyan: #67d4d6; --amber: #f2b05e; --line: #2a3639; --muted: #819095; }
    .c-shell { display: grid; grid-template-columns: 210px minmax(0,1fr); min-height: 100vh; }
    .c-rail { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; padding: 18px 14px; border-right: 1px solid var(--line); background: #0d1214; }
    .c-logo { margin: 0 8px 28px; font-size: 1rem; font-weight: 900; letter-spacing: .04em; }
    .c-logo i { color: var(--cyan); font-style: normal; }
    .c-rail a { padding: 9px 10px; color: var(--muted); border-left: 2px solid transparent; font-size: .75rem; text-decoration: none; }
    .c-rail a.active { color: white; border-color: var(--cyan); background: #172124; }
    .c-rail small { margin: 24px 10px 6px; color: #59676b; font-size: .58rem; letter-spacing: .12em; text-transform: uppercase; }
    .c-rail .c-observed { margin-top: auto; padding: 10px; color: var(--muted); border: 1px solid var(--line); font-size: .65rem; line-height: 1.5; }
    .c-main { min-width: 0; padding-bottom: 100px; }
    .c-toolbar { display: flex; align-items: center; gap: 14px; min-height: 54px; padding: 8px 20px; border-bottom: 1px solid var(--line); }
    .c-toolbar input { flex: 1; max-width: 520px; padding: 8px 10px; color: white; background: #182124; border: 1px solid var(--line); }
    .c-toolbar span { margin-left: auto; color: var(--muted); font-size: .68rem; }
    .c-identity { display: grid; grid-template-columns: 1fr auto; gap: 20px; padding: 24px 22px 18px; }
    .c-identity small { color: var(--cyan); font-size: .63rem; letter-spacing: .11em; text-transform: uppercase; }
    .c-identity h1 { margin: 4px 0 3px; font-size: clamp(1.5rem,4vw,2.3rem); letter-spacing: -.045em; }
    .c-identity p { margin: 0; color: var(--muted); font-size: .72rem; }
    .c-buy { text-align: right; }
    .c-buy strong { display: block; font-size: 1.4rem; }
    .c-buy button { margin-top: 6px; padding: 7px 11px; color: #092023; background: var(--cyan); border: 0; font-weight: 800; cursor: pointer; }
    .c-stats { display: grid; grid-template-columns: repeat(6,1fr); border-block: 1px solid var(--line); }
    .c-stat { min-width: 0; padding: 12px 14px; border-right: 1px solid var(--line); }
    .c-stat:last-child { border: 0; }
    .c-stat span { display: block; overflow: hidden; color: var(--muted); font-size: .58rem; letter-spacing: .07em; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
    .c-stat strong { display: block; margin-top: 6px; font-size: 1rem; }
    .c-workspace { display: grid; grid-template-columns: minmax(0,1.65fr) minmax(290px,.75fr); }
    .c-chart-area { min-width: 0; padding: 20px 22px; border-right: 1px solid var(--line); }
    .c-section-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
    .c-section-head h2 { margin: 0; font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; }
    .c-tabs { display: flex; }
    .c-tabs button { padding: 4px 7px; color: var(--muted); background: transparent; border: 1px solid var(--line); font-size: .62rem; cursor: pointer; }
    .c-tabs button + button { border-left: 0; }
    .c-tabs .active { color: #081416; background: var(--cyan); }
    .c-events { padding: 20px; }
    .c-events table { width: 100%; border-collapse: collapse; font-size: .68rem; }
    .c-events caption { margin-bottom: 11px; text-align: left; font-size: .77rem; font-weight: 800; text-transform: uppercase; }
    .c-events th { padding: 7px 5px; color: var(--muted); border-bottom: 1px solid var(--line); text-align: left; font-size: .57rem; text-transform: uppercase; }
    .c-events td { padding: 9px 5px; border-bottom: 1px solid #202a2d; }
    .c-events td:last-child { text-align: right; }
    .c-bottom { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid var(--line); }
    .c-bottom section { padding: 18px 22px; }
    .c-bottom section + section { border-left: 1px solid var(--line); }
    .c-list { margin: 12px 0 0; padding: 0; list-style: none; }
    .c-list li { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); font-size: .7rem; }
    .c-list small { display: block; color: var(--muted); }
    .c-ad { display: grid; place-items: center; min-height: 60px; margin: 18px 22px; color: #657579; border: 1px dashed var(--line); font-size: .58rem; letter-spacing: .12em; text-transform: uppercase; }

    @media (max-width: 820px) {
      .a-topbar { padding-inline: 16px; }
      .a-nav { display: none; }
      .a-search { width: 42vw; }
      .a-main { padding-inline: 16px; }
      .a-hero { grid-template-columns: 1fr; }
      .a-price { text-align: left; }
      .a-metrics { grid-template-columns: 1fr 1fr; }
      .a-metric:nth-child(2) { border-right: 0; }
      .a-metric:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
      .a-grid, .a-related { grid-template-columns: 1fr; }
      .b-header { grid-template-columns: 1fr auto; padding-inline: 18px; }
      .b-header nav { display: none; }
      .b-main { padding: 28px 18px 110px; }
      .b-title { grid-template-columns: 1fr; }
      .b-title-copy { border: 0; padding: 0; }
      .b-layout { grid-template-columns: 1fr; }
      .b-index { display: flex; gap: 14px; overflow-x: auto; padding: 12px 0; border-right: 0; border-bottom: 1px solid var(--rule); }
      .b-index a { flex: 0 0 auto; }
      .b-story { padding: 22px 0; }
      .b-sidebar { display: grid; grid-template-columns: repeat(2,1fr); gap: 18px; padding: 20px 0; border-left: 0; border-top: 1px solid var(--rule); }
      .b-price-card { grid-template-columns: 1fr; }
      .b-related-list { grid-template-columns: 1fr; }
      .b-related-list article, .b-related-list article + article { padding: 14px 0; border-right: 0; border-bottom: 1px solid var(--rule); }
      .c-shell { grid-template-columns: 1fr; }
      .c-rail { position: static; height: auto; flex-direction: row; align-items: center; gap: 4px; overflow-x: auto; padding: 10px 12px; border-right: 0; border-bottom: 1px solid var(--line); }
      .c-logo { margin: 0 16px 0 0; }
      .c-rail small, .c-rail .c-observed { display: none; }
      .c-rail a { flex: 0 0 auto; }
      .c-stats { grid-template-columns: repeat(3,1fr); }
      .c-stat:nth-child(3) { border-right: 0; }
      .c-stat:nth-child(-n+3) { border-bottom: 1px solid var(--line); }
      .c-workspace, .c-bottom { grid-template-columns: 1fr; }
      .c-chart-area { border-right: 0; border-bottom: 1px solid var(--line); }
      .c-bottom section + section { border-left: 0; border-top: 1px solid var(--line); }
    }
    @media (max-width: 480px) {
      .prototype-switcher { bottom: 10px; grid-template-columns: 38px minmax(155px,auto) 38px; }
      .a-search { width: 45%; }
      .a-game { align-items: flex-start; }
      .a-cover { width: 58px; height: 58px; flex: 0 0 auto; }
      .a-metrics { grid-template-columns: 1fr; }
      .a-metric { border-right: 0; border-bottom: 1px solid var(--line); }
      .a-metric:last-child { border-bottom: 0; }
      .panel-head { display: block; }
      .range { margin-top: 12px; overflow-x: auto; }
      .b-edition span:last-child { display: none; }
      .b-title h1 { font-size: 3.2rem; }
      .b-sidebar { grid-template-columns: 1fr; }
      .b-price-card { padding: 20px; }
      .c-toolbar span { display: none; }
      .c-identity { grid-template-columns: 1fr; }
      .c-buy { text-align: left; }
      .c-stats { grid-template-columns: repeat(2,1fr); }
      .c-stat:nth-child(2), .c-stat:nth-child(4) { border-right: 0; }
      .c-stat:nth-child(3) { border-right: 1px solid var(--line); }
      .c-stat:nth-child(-n+4) { border-bottom: 1px solid var(--line); }
      .c-chart-area, .c-events, .c-bottom section { padding-inline: 14px; }
    }
  </style>
</head>
<body>
  <section class="variant variant-a" data-variant="A" aria-label="Command Deck visual direction">
    <header class="a-topbar">
      <a class="a-brand" href="#"><span class="a-mark">V</span>VaporStats</a>
      <nav class="a-nav" aria-label="Primary"><a href="#">Games</a><a href="#">Rankings</a><a href="#">Deals</a><a href="#">Releases</a></nav>
      <label class="sr-only" for="a-search">Search games</label><input class="a-search" id="a-search" placeholder="Search games…">
    </header>
    <main class="a-main">
      <div class="a-breadcrumb">Games / App 730</div>
      <header class="a-hero">
        <div class="a-game"><div class="a-cover" aria-hidden="true">CS2</div><div><div class="a-kicker">Valve · Playable game</div><h1>Counter-Strike 2</h1><p class="a-sub">Observed 8 minutes ago · Sep 2, 2026, 19:40 UTC</p></div></div>
        <div class="a-price"><strong>$14.99</strong><span class="a-sale">−25% · until Sep 8</span></div>
      </header>
      <section class="a-metrics" aria-label="Game summary">
        <div class="a-metric"><span class="metric-label">Playing now</span><strong class="metric-value">1,284,392</strong><span class="metric-detail up">↑ 2.8% over 24h</span></div>
        <div class="a-metric"><span class="metric-label">Observed 24h peak</span><strong class="metric-value">1,512,884</strong><span class="metric-detail">at 16:20 UTC</span></div>
        <div class="a-metric"><span class="metric-label">Observed all-time peak</span><strong class="metric-value">1,862,531</strong><span class="metric-detail">since Sep 2026</span></div>
        <div class="a-metric"><span class="metric-label">Released</span><strong class="metric-value">Aug 21, 2012</strong><span class="metric-detail">Valve</span></div>
      </section>
      <div class="a-grid">
        <section class="a-panel"><div class="panel-head"><div><h2>Player history</h2><p>Successful observations; gaps are not interpolated</p></div><div class="range" aria-label="Player history range"><button>24h</button><button>7d</button><button class="active">30d</button><button>90d</button><button>All</button></div></div>
          <svg class="chart" viewBox="0 0 720 250" role="img" aria-labelledby="a-player-title a-player-desc"><title id="a-player-title">Thirty-day player history</title><desc id="a-player-desc">Player count rises from about 920 thousand to 1.28 million with a visible observation gap near the middle.</desc><g class="chart-grid"><path d="M40 30V220M40 220H700M40 170H700M40 120H700M40 70H700"/></g><path d="M40 185 C85 160 110 170 145 138 S210 105 245 126 S295 112 322 98" fill="none" stroke="#f27d55" stroke-width="4"/><path d="M360 105 C400 80 430 112 470 88 S540 72 575 55 S640 72 700 42" fill="none" stroke="#f27d55" stroke-width="4"/><path d="M322 98L360 105" fill="none" stroke="#8e9aa8" stroke-width="2" stroke-dasharray="4 7"/><text x="326" y="88" fill="#8e9aa8" font-size="11">gap</text><text x="5" y="73" fill="#8e9aa8" font-size="11">1.5m</text><text x="8" y="173" fill="#8e9aa8" font-size="11">1.0m</text></svg>
        </section>
        <section class="a-panel"><div class="panel-head"><div><h2>Steam price history</h2><p>United States · USD</p></div><div class="range"><button>30d</button><button>6m</button><button>1y</button><button class="active">All</button></div></div><table class="a-table"><thead><tr><th>Date</th><th>Price</th></tr></thead><tbody><tr><td>Sep 1, 2026</td><td><span class="up">−25%</span> $14.99</td></tr><tr><td>Aug 18, 2026</td><td>$19.99</td></tr><tr><td>Jul 7, 2026</td><td><span class="up">−50%</span> $9.99</td></tr><tr><td>First observed</td><td>$19.99</td></tr></tbody></table></section>
      </div>
      <aside class="a-ad" aria-label="Reserved advertising placement">Reserved placement · 970 × 90</aside>
      <section aria-labelledby="a-related-title"><div class="panel-head"><div><h2 id="a-related-title">DLC &amp; related content</h2><p>Attached to Counter-Strike 2</p></div></div><div class="a-related"><article><div><strong>Counter-Strike 2 Expansion Pass</strong><span class="tag">Major expansion</span></div><strong>$24.99</strong></article><article><div><strong>Counter-Strike 2 Dedicated Server</strong><span class="tag">Tool · players: No data yet</span></div><strong>Free</strong></article></div></section>
    </main>
  </section>

  <section class="variant variant-b" data-variant="B" hidden aria-label="Field Notes visual direction">
    <header class="b-header"><strong>VaporStats</strong><nav aria-label="Primary"><a href="#">Games</a><a href="#">Rankings</a><a href="#">Deals</a><a href="#">Releases</a></nav><button type="button">Search</button></header>
    <main class="b-main">
      <div class="b-edition"><span>Game record · App 730</span><span>United States pricing · USD</span></div>
      <header class="b-title"><h1>Counter-<br>Strike 2</h1><div class="b-title-copy"><p>A competitive action game by Valve. Activity and pricing observed prospectively by VaporStats.</p><div class="b-now"><strong>1,284,392</strong><span>PLAYING NOW · +2.8%</span></div><p class="b-deck">Observed 8 minutes ago · Sep 2, 2026, 19:40 UTC</p></div></header>
      <div class="b-layout">
        <nav class="b-index" aria-label="On this page"><a href="#">Player activity</a><a href="#">Price history</a><a href="#">Release</a><a href="#">Related content</a></nav>
        <section class="b-story"><h2>Thirty days of play</h2><p class="b-deck">The latest count sits 2.8% above the comparable observation 24 hours earlier. Dashed space marks a collection gap.</p><svg class="chart" viewBox="0 0 720 330" role="img" aria-labelledby="b-player-title b-player-desc"><title id="b-player-title">Thirty-day player history</title><desc id="b-player-desc">A stepped area chart rising from about 920 thousand to 1.28 million with one observation gap.</desc><path d="M40 280H700M40 215H700M40 150H700M40 85H700" stroke="#c9c8bd" fill="none"/><path d="M40 255L90 230L140 240L190 190L245 205L300 145L338 158" fill="none" stroke="#31594d" stroke-width="5"/><path d="M375 150L430 165L485 118L540 132L600 80L650 105L700 62" fill="none" stroke="#31594d" stroke-width="5"/><path d="M338 158L375 150" stroke="#b34d2e" stroke-width="2" stroke-dasharray="5 8"/><text x="338" y="137" fill="#b34d2e" font-size="12">no observation</text><text x="40" y="308" fill="#6c7068" font-size="12">Aug 4</text><text x="665" y="308" fill="#6c7068" font-size="12">Sep 2</text></svg></section>
        <aside class="b-sidebar"><div class="b-fact"><small>Observed 24h peak</small><strong>1,512,884</strong></div><div class="b-fact"><small>Observed all-time peak</small><strong>1,862,531</strong></div><div class="b-fact"><small>First observed</small><strong>Sep 2, 2026</strong></div><div class="b-fact"><small>Released</small><strong>Aug 21, 2012</strong></div></aside>
      </div>
      <section class="b-price-card"><div class="b-price-number"><span>25% off</span><strong>$14.99</strong><small>Steam · United States · until Sep 8</small></div><div><h2>Price, in context</h2><p>Current price returned to the level last observed during the August promotion. The observed low is $9.99.</p><svg class="chart" viewBox="0 0 520 130" role="img" aria-labelledby="b-price-title b-price-desc"><title id="b-price-title">Observed Steam price history</title><desc id="b-price-desc">Price moved from 19.99 dollars to 9.99, back to 19.99, and now 14.99.</desc><path d="M10 20H160V100H290V20H410V60H510" fill="none" stroke="#f2d0a4" stroke-width="4"/><text x="8" y="124" fill="#d7e3da" font-size="11">First observed</text><text x="424" y="82" fill="#d7e3da" font-size="11">$14.99</text></svg></div></section>
      <aside class="b-ad" aria-label="Reserved advertising placement">Reserved placement · no advertising vendor selected</aside>
      <section class="b-related"><h2>DLC &amp; related content</h2><p class="b-deck">Subordinate releases remain attached to the playable game.</p><div class="b-related-list"><article><strong>Expansion Pass</strong><span>Major expansion · $24.99</span></article><article><strong>Soundtrack</strong><span>Related content · $8.99</span></article><article><strong>Dedicated Server</strong><span>Tool · Free · players: No data yet</span></article></div></section>
    </main>
  </section>

  <section class="variant variant-c" data-variant="C" hidden aria-label="Ledger visual direction">
    <div class="c-shell">
      <nav class="c-rail" aria-label="Primary"><div class="c-logo"><i>V/</i>STATS</div><a href="#">Games</a><a class="active" href="#">Game record</a><a href="#">Rankings</a><a href="#">Deals</a><a href="#">Releases</a><small>Sections</small><a href="#">Players</a><a href="#">Price</a><a href="#">Release</a><a href="#">Related</a><div class="c-observed">LAST SUCCESS<br><strong>8 minutes ago</strong><br>Sep 2, 2026, 19:40 UTC</div></nav>
      <main class="c-main">
        <header class="c-toolbar"><label class="sr-only" for="c-search">Search games</label><input id="c-search" placeholder="Search games or AppID"><span>US / USD</span></header>
        <header class="c-identity"><div><small>Playable game · App 730</small><h1>Counter-Strike 2</h1><p>Valve · Released Aug 21, 2012 · First observed Sep 2, 2026</p></div><div class="c-buy"><strong>$14.99 <span class="up">−25%</span></strong><button type="button">View on Steam ↗</button></div></header>
        <section class="c-stats" aria-label="Game summary"><div class="c-stat"><span>Playing now</span><strong>1,284,392</strong></div><div class="c-stat"><span>24h change</span><strong class="up">+2.8%</strong></div><div class="c-stat"><span>24h peak</span><strong>1,512,884</strong></div><div class="c-stat"><span>Observed peak</span><strong>1,862,531</strong></div><div class="c-stat"><span>Observed low price</span><strong>$9.99</strong></div><div class="c-stat"><span>Current discount</span><strong>25%</strong></div></section>
        <div class="c-workspace">
          <section class="c-chart-area"><div class="c-section-head"><h2>Player observations</h2><div class="c-tabs"><button>24h</button><button>7d</button><button class="active">30d</button><button>90d</button><button>All</button></div></div><svg class="chart" viewBox="0 0 760 310" role="img" aria-labelledby="c-player-title c-player-desc"><title id="c-player-title">Thirty-day player observations</title><desc id="c-player-desc">Dense line chart showing a rise from about 920 thousand to 1.28 million; a dashed section marks missing observations.</desc><g stroke="#2a3639"><path d="M45 30V270M45 270H740M45 210H740M45 150H740M45 90H740"/><path d="M160 30V270M280 30V270M400 30V270M520 30V270M640 30V270"/></g><path d="M45 245L85 215L130 228L175 182L220 198L265 145L310 162L350 125" fill="none" stroke="#67d4d6" stroke-width="3"/><path d="M388 132L430 155L475 112L520 126L565 82L610 98L660 55L700 74L740 42" fill="none" stroke="#67d4d6" stroke-width="3"/><path d="M350 125L388 132" stroke="#f2b05e" stroke-width="2" stroke-dasharray="4 6"/><text x="350" y="112" fill="#f2b05e" font-size="11">gap</text><text x="4" y="94" fill="#819095" font-size="10">1.5m</text><text x="6" y="214" fill="#819095" font-size="10">1.0m</text></svg></section>
          <section class="c-events"><table><caption>Price event ledger</caption><thead><tr><th>UTC date</th><th>Event</th><th>USD</th></tr></thead><tbody><tr><td>Sep 1</td><td>−25%</td><td>$14.99</td></tr><tr><td>Aug 18</td><td>Regular</td><td>$19.99</td></tr><tr><td>Jul 7</td><td>−50%</td><td>$9.99</td></tr><tr><td>Jun 28</td><td>Regular</td><td>$19.99</td></tr><tr><td>First seen</td><td>Regular</td><td>$19.99</td></tr></tbody></table></section>
        </div>
        <aside class="c-ad" aria-label="Reserved advertising placement">Reserved placement · 970 × 90 · integration out of scope</aside>
        <div class="c-bottom"><section><div class="c-section-head"><h2>Release record</h2></div><ul class="c-list"><li><span>Initial release<small>Steam · Valve</small></span><strong>Aug 21, 2012</strong></li><li><span>Launch status<small>Released</small></span><strong>Available</strong></li></ul></section><section><div class="c-section-head"><h2>DLC &amp; related</h2></div><ul class="c-list"><li><span>Expansion Pass<small>Major expansion</small></span><strong>$24.99</strong></li><li><span>Dedicated Server<small>Tool · players: No data yet</small></span><strong>Free</strong></li></ul></section></div>
      </main>
    </div>
  </section>
  ${switcher}
  <script>
    const variants = [{ key: "A", name: "Command Deck" }, { key: "B", name: "Field Notes" }, { key: "C", name: "Ledger" }];
    function selectVariant(key) {
      let selected = variants[0];
      for (const item of variants) {
        if (item.key === String(key).toUpperCase()) selected = item;
      }
      for (const section of document.querySelectorAll("[data-variant]")) {
        section.hidden = section.dataset.variant !== selected.key;
      }
      const label = document.querySelector("#variant-label");
      if (label) label.textContent = selected.key + " · " + selected.name;
      const url = new URL(location.href);
      url.searchParams.set("variant", selected.key);
      history.replaceState(null, "", url);
      document.title = "VaporStats · " + selected.name + " prototype";
    }
    function stepVariant(step) {
      const current = String(new URL(location.href).searchParams.get("variant") || "A").toUpperCase();
      let index = 0;
      for (const [candidateIndex, item] of variants.entries()) {
        if (item.key === current) index = candidateIndex;
      }
      selectVariant(variants[(index + step + variants.length) % variants.length].key);
    }
    for (const button of document.querySelectorAll("[data-step]")) {
      button.addEventListener("click", function () {
        const step = Number(button.dataset.step);
        stepVariant(step);
      });
    }
    addEventListener("keydown", function (event) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.matches("input, textarea") || target.isContentEditable)) return;
      stepVariant(event.key === "ArrowLeft" ? -1 : 1);
    });
    addEventListener("popstate", function () {
      const key = new URL(location.href).searchParams.get("variant") || "A";
      selectVariant(key);
    });
    selectVariant(new URL(location.href).searchParams.get("variant") || "A");
  </script>
</body>
</html>`;

const server = Bun.serve({
  port: 4173,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path !== "/" && path !== "/games/730-counter-strike-2") return new Response("Not found", { status: 404 });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

console.log(`VaporStats prototype: http://localhost:${server.port}/?variant=A`);
