/**
 * Sidebar, topbar and wallet button, shared by every page.
 *
 * Rendered from JS rather than copy-pasted into each file: with five pages, a nav item added
 * in one place and forgotten in four is not a hypothetical.
 */
(() => {
  /**
   * Line icons rather than the geometric glyphs this used to carry: those rendered as tofu
   * boxes wherever the font lacked them, which is most Windows installs.
   * Create is not here — "Create coin" already sits under the nav as the primary action.
   */
  const ICON = {
    home: '<path d="M3 9.4 10 3.6l7 5.8V16a1 1 0 0 1-1 1h-3.6v-4.4H7.6V17H4a1 1 0 0 1-1-1Z"/>',
    explore: '<circle cx="9" cy="9" r="6.1"/><path d="m13.6 13.6 3.2 3.2"/>',
    profile: '<circle cx="10" cy="6.6" r="3.1"/><path d="M4.2 16.4a5.8 5.8 0 0 1 11.6 0"/>',
    docs: '<path d="M5 3.4h6.2L15 7.2v9.4H5Z"/><path d="M11 3.4v4h4"/><path d="M7.6 11h4.8M7.6 13.6h4.8"/>',
    // Two arrows chasing each other round a circle — one balance going out, another coming
    // back. The old bridge arch said "crossing", which is no longer what the page does.
    swap: '<path d="M4 8.6a6.2 6.2 0 0 1 10.4-3l2.2 2.1"/><path d="M16.9 3.6v4h-4"/>'
        + '<path d="M16 11.4a6.2 6.2 0 0 1-10.4 3l-2.2-2.1"/><path d="M3.1 16.4v-4h4"/>',
  };
  const svg = (d) => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

  const NAV = [
    ['index.html', ICON.home, 'Home'],
    ['explore.html', ICON.explore, 'Explore'],
    ['swap.html', ICON.swap, 'Swap'],
    ['profile.html', ICON.profile, 'Profile'],
    ['docs.html', ICON.docs, 'Docs'],
  ];

  /**
   * Bumped whenever the logo file changes. A file that once failed to load is cached as a
   * failure, and a corrected file at the same URL does not dislodge it.
   */
  const LOGO = 'assets/hexapus-logo.webp?v=2';

  const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

  /**
   * Coin artwork: what the creator uploaded, or a sea creature derived from the address for
   * coins launched before artwork was carried through.
   *
   * Returns the inside of the avatar box, not the box, so every caller keeps the size and
   * radius it already had. The fallback is per-address, so two coins sharing a name still get
   * told apart — but it is a fallback, not an identity, and real artwork always wins.
   *
   * The URL comes from the creator. The indexer passes through http(s) URLs only, and the
   * quote is escaped here so one cannot close the attribute and inject markup.
   */
  const FACES = ['🐙','🦑','🐡','🐠','🦐','🦞','🪼','🐳','🦈','🐬','🪸','🐚'];
  const face = (a) => FACES[parseInt(a.slice(-2), 16) % FACES.length];

  function art(token, image, { eager = false } = {}) {
    if (!image) return face(token);
    const src = String(image).replace(/"/g, '%22');
    // mp4 is no longer an accepted upload, but this stays: a coin's metadata URI is written
    // on-chain at reveal and is immutable, so coins launched while video was allowed still point
    // at one. Dropping the tag would leave those permanently blank. Muted and inline, or a grid
    // of cards would be a wall of sound and iOS would refuse to autoplay.
    //
    // Neither tag is written self-closing. Explore repaints on a timer and skips the write
    // when the new HTML equals the DOM's own serialisation of the old — and the DOM never
    // serialises `<img/>`, so a stray slash there would rebuild every card every 20 seconds
    // and restart every video coin's clip with it.
    // Deferred only in the card grid, where sixty cards of creator-uploaded media are mostly
    // below the fold. Everywhere else — the coin page's own artwork, table thumbnails, search
    // results — the image is small, in view, and the point of the row, and deferring it risks
    // a blank box to save a request that was going to happen anyway.
    return /\.mp4($|\?)/i.test(src)
      ? `<video src="${src}" autoplay loop muted playsinline></video>`
      : `<img src="${src}" alt="" loading="${eager ? 'eager' : 'lazy'}">`;
  }

  function mount({ active = '', search = false } = {}) {
    const side = document.getElementById('side');
    const body = document.getElementById('body');
    if (!side || !body) return;

    side.className = 'side';
    side.innerHTML = `
      <a class="brand" href="index.html">
        <img src="${LOGO}" alt=""/>
        <span>Hexapus<br><i>hexapus.trade</i></span>
      </a>
      <nav class="nav">
        ${NAV.map(([href, ic, label]) =>
          `<a href="${href}" class="${label.toLowerCase() === active ? 'on' : ''}"><span class="ic">${svg(ic)}</span>${label}</a>`).join('')}
      </nav>
      <div class="side-cta"><a class="btn btn-p btn-w" href="create.html" style="display:block">Create coin</a></div>
      <div class="side-foot">
        Arc testnet · 5042002<br/>
        <span class="dim" id="feedstat">USDC is the gas token</span>
        <div class="legal"><a href="terms.html">Terms</a> · <a href="privacy.html">Privacy</a></div>
      </div>`;

    // Pages that never transact — Terms, Privacy — do not load the 326 KB web3 bundle, so the
    // wallet controls have nothing to talk to. Everything below `hexa` touches is skipped rather
    // than left to throw: it used to take the whole inline script down with it, which is how
    // those pages ended up with an empty table of contents.
    const wallet = typeof hexa !== 'undefined';

    const top = document.createElement('header');
    top.className = 'top';
    top.innerHTML = `
      ${search ? `<div class="searchbox" id="opensearch"><span>⌕</span><span>Search for coins and addresses…</span><span class="kbd">⌘K</span></div>` : ''}
      <div class="spacer"></div>
      ${wallet ? `<div class="acct">
        <button class="btn btn-p" id="connect">Connect wallet</button>
        <div class="acctpop" id="acctpop" hidden>
          <a href="profile.html">Profile</a>
          <button id="disconnect">Disconnect</button>
        </div>
      </div>` : ''}`;
    body.prepend(top);
    if (!wallet) return;

    const btn = document.getElementById('connect');
    const pop = document.getElementById('acctpop');
    const setAccount = (a) => {
      btn.textContent = a ? short(a) : 'Connect wallet';
      btn.title = a ? 'Account' : 'Connect a wallet';
      // Connected, the address is a label you can open a menu from, not a call to action —
      // so it drops the primary fill and becomes an outline.
      btn.classList.toggle('btn-p', !a);
      btn.classList.toggle('btn-ghost', !!a);
      if (!a) pop.hidden = true;
      document.dispatchEvent(new CustomEvent('hexa:account', { detail: a }));
    };

    btn.addEventListener('click', async () => {
      // Connected, the address opens a menu rather than navigating: it used to jump straight to
      // the portfolio, which meant the button did nothing at all while already on that page.
      if (hexa.currentAccount()) { pop.hidden = !pop.hidden; return; }
      btn.textContent = 'Connecting…';
      try {
        setAccount(await hexa.connect());
      } catch (e) {
        btn.textContent = 'Connect wallet';
        alert(e.message.includes('No wallet')
          ? 'No wallet found. Install MetaMask, then reload.'
          : `Could not connect: ${e.message}`);
      }
    });

    document.getElementById('disconnect').addEventListener('click', () => {
      // The site forgets the wallet; the wallet extension keeps its own permission, which is
      // the user's to revoke there. Reload so every page-level cache clears with it.
      hexa.disconnect?.();
      pop.hidden = true;
      setAccount(null);
      location.reload();
    });

    document.addEventListener('click', (e) => {
      if (!pop.hidden && !e.target.closest('.acct')) pop.hidden = true;
    });

    // A reload should not look like a logout when the site is already authorised.
    hexa.resume().then((a) => a && setAccount(a)).catch(() => {});
  }

  /**
   * Build a table of contents from a page's own headings, and mark the one in view.
   *
   * Generated rather than typed beside the sections: the legal pages carry eighteen headings
   * each, and a hand-written list silently stops matching the first time one is renamed.
   */
  function toc(navSel, headSel) {
    const nav = document.querySelector(navSel);
    const heads = [...document.querySelectorAll(headSel)];
    if (!nav || !heads.length) return;

    for (const h of heads) {
      const a = document.createElement('a');
      a.href = `#${h.id}`;
      a.textContent = h.textContent;
      nav.appendChild(a);
    }

    /**
     * The section being read is the last heading that has passed under the top bar.
     *
     * Not an IntersectionObserver band: a band tall enough to always contain a heading does not
     * exist — sections here run from three lines to a full screen — so most of the time nothing
     * was inside it and nothing was highlighted at all.
     */
    const spy = () => {
      let active = heads[0];
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= 90) active = h; else break;
      }
      for (const a of nav.children) a.classList.toggle('on', a.hash === `#${active.id}`);
    };
    addEventListener('scroll', spy, { passive: true });
    spy();
  }

  window.hexaShell = { mount, short, art, toc };
})();
