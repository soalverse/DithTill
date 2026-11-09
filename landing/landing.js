/* What the landing page's card does. The screen behind it is landing-screen.js. */
(function () {
  'use strict';

  // Filled in when the site is built (scripts/place-landing.mjs): system id -> installer URL.
  var INSTALLERS = /* @@INSTALLERS@@ */ {};
  var RELEASES = 'https://github.com/soalverse/DithTill/releases';
  var APP = '/app/';
  var DIM = 0.42;
  var CLOSED_TIP = 'Left click flashes · Right-hold stays · ? brings the card back';

  var INK = [255, 222, 176];
  var ACCENT = [255, 176, 0];
  var MAC_HOW = 'macOS: open System Settings, go to Privacy and Security, choose Open Anyway';
  var ROWS = [
    {
      id: 'windows',
      name: 'Windows',
      file: '.exe',
      how: 'Windows: choose More info, then Run anyway',
    },
    { id: 'mac-arm', name: 'macOS Apple Silicon', file: '.dmg', how: MAC_HOW },
    { id: 'mac-intel', name: 'macOS Intel', file: '.dmg', how: MAC_HOW },
    {
      id: 'linux',
      name: 'Linux',
      file: '.AppImage',
      how: 'Linux: mark the .AppImage as executable, then run it',
    },
  ];

  function $(id) {
    return document.getElementById(id);
  }
  var scr = $('scr');
  var phoneQuery = matchMedia('(max-width: 560px)');
  var engine = null;
  var bannerTimer = 0;
  var state = {
    view: 'hero', // hero | download
    peek: null, // online | download | null
    phone: phoneQuery.matches,
    rails: false,
    power: false,
    card: false,
    awake: false,
    hot: null,
    mac: null,
  };

  function system() {
    var d = navigator.userAgentData;
    var p = ((d && d.platform) || navigator.platform || '') + ' ' + navigator.userAgent;
    if (/Win/i.test(p)) return { id: 'windows', sure: true };
    if (/Mac/i.test(p))
      return state.mac ? { id: state.mac, sure: true } : { id: 'mac-arm', sure: false };
    if (/Linux|X11/i.test(p)) return { id: 'linux', sure: true };
    return { id: null, sure: false };
  }

  function sortedRows() {
    var sys = system();
    return ROWS.slice().sort(function (a, b) {
      return (b.id === sys.id) - (a.id === sys.id);
    });
  }

  function buildRows() {
    var sys = system();
    [$('rows'), $('phone-rows')].forEach(function (box, phone) {
      box.textContent = '';
      sortedRows().forEach(function (r) {
        var a = document.createElement('a');
        a.className = 'dl-row';
        a.href = INSTALLERS[r.id] || RELEASES;
        a.dataset.id = r.id;
        var name = document.createElement('span');
        name.className = 'dl-name';
        name.textContent = r.name;
        if (!phone && r.id === sys.id) {
          var tag = document.createElement('span');
          tag.className = 'dl-tag';
          tag.textContent = sys.sure ? 'your system' : 'probably yours';
          name.appendChild(tag);
        }
        var file = document.createElement('span');
        file.className = 'dl-file';
        file.textContent = r.file + ' ▸';
        a.appendChild(name);
        a.appendChild(file);
        if (!phone) {
          var hover = function () {
            state.hot = r.id;
            paintRows();
          };
          a.addEventListener('mouseenter', hover);
          a.addEventListener('focus', hover);
        }
        box.appendChild(a);
      });
    });
    paintRows();
  }

  function paintRows() {
    var hot = state.hot || sortedRows()[0].id;
    Array.prototype.forEach.call($('rows').children, function (a) {
      a.classList.toggle('is-sel', a.dataset.id === hot);
    });
    $('how').textContent = ROWS.filter(function (r) {
      return r.id === hot;
    })[0].how;
  }

  function render() {
    var s = state;
    var isDownload = s.view === 'download';
    var lit = isDownload ? 'download' : s.peek || 'online';
    var visible = s.card && s.power && !s.awake;

    scr.classList.toggle('is-on', s.power);
    scr.classList.toggle('is-rails', s.rails);
    scr.classList.toggle('is-awake', s.awake);
    scr.classList.toggle('is-phone', s.phone);

    $('card-desktop').hidden = !visible || s.phone;
    $('card-phone').hidden = !visible || !s.phone;
    $('about').hidden = isDownload;
    $('installers').hidden = !isDownload;
    $('phone-home').hidden = isDownload;
    $('phone-installers').hidden = !isDownload;

    [
      ['online', 'online'],
      ['download', 'download'],
    ].forEach(function (p) {
      var on = lit === p[1];
      $(p[0]).classList.toggle('is-on', on);
      $(p[0]).querySelector('.crt-help-mark').textContent = on ? '▸' : '';
    });
    $('download').setAttribute('aria-expanded', String(isDownload));
    Array.prototype.forEach.call($('about').querySelectorAll('[data-body]'), function (b) {
      var name = b.getAttribute('data-body');
      b.classList.toggle('is-off', name !== (s.peek || 'what'));
    });

    $('help').classList.toggle('is-on', s.card);
    $('help').setAttribute('aria-pressed', String(s.card));
    $('power').setAttribute('aria-pressed', String(s.power));
  }

  function set(patch) {
    Object.assign(state, patch);
    render();
  }

  function notice(text, ms) {
    var b = $('banner');
    b.textContent = text;
    b.hidden = !text;
    clearTimeout(bannerTimer);
    if (text)
      bannerTimer = setTimeout(function () {
        b.hidden = true;
      }, ms || 2600);
  }

  function playStatic(on) {
    var el = $('static');
    el.style.transition = 'none';
    el.style.transform = 'scaleY(1)';
    el.style.opacity = '1';
    void el.offsetWidth;
    requestAnimationFrame(function () {
      if (on) {
        el.style.transition = 'opacity .45s ease';
        el.style.opacity = '0';
      } else {
        el.style.transition = 'transform .4s ease-in, opacity .4s ease-in';
        el.style.transform = 'scaleY(.02)';
        el.style.opacity = '0';
      }
    });
  }

  function setCard(open) {
    set({ card: open });
    if (engine) engine.setDim(open ? DIM : 1);
  }

  // The card closes and the rails come up, so the jump into the app reads as one screen.
  function goOnline(e) {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (engine && engine.reduced) {
      location.href = APP;
      return;
    }
    set({ awake: true });
    if (engine) engine.setDim(1);
    setTimeout(function () {
      location.href = APP;
    }, 650);
  }

  function goDownload() {
    set({ view: 'download', peek: null, hot: null });
    paintRows();
  }

  function sendLink() {
    var url = location.origin + '/';
    var label = $('send-label');
    var original = 'Send this page to my computer';
    function show(text) {
      label.textContent = text;
      setTimeout(function () {
        label.textContent = original;
      }, 2400);
    }
    if (navigator.share) {
      navigator.share({ url: url }).catch(function () {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText)
      navigator.clipboard.writeText(url).then(
        function () {
          show('Link copied');
        },
        function () {
          show('Your browser said no');
        },
      );
    else show('Your browser said no');
  }

  function peek(id, value) {
    var el = $(id);
    function on() {
      set({ peek: value });
    }
    function off() {
      set({ peek: null });
    }
    el.addEventListener('mouseenter', on);
    el.addEventListener('mouseleave', off);
    el.addEventListener('focus', on);
    el.addEventListener('blur', off);
  }

  peek('online', 'online');
  peek('download', 'download');
  $('online').addEventListener('click', goOnline);
  $('phone-online').addEventListener('click', goOnline);
  $('download').addEventListener('click', goDownload);
  $('phone-download').addEventListener('click', goDownload);
  $('back').addEventListener('click', function () {
    set({ view: 'hero' });
  });
  $('send').addEventListener('click', sendLink);
  $('help').addEventListener('click', function () {
    var open = !state.card;
    setCard(open);
    notice(open ? '' : MS_ICON, 4200);
  });
  $('power').addEventListener('click', function () {
    var on = !state.power;
    playStatic(on);
    set({ power: on });
    notice('');
    if (engine) {
      if (on) engine.warmUp();
      else engine.off();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') setCard(!state.card);
  });
  phoneQuery.addEventListener('change', function () {
    set({ phone: phoneQuery.matches });
    if (engine) engine.set({ phone: state.phone });
  });
  // Coming Back from the app: the page may be restored as it was left, mid-transition.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && state.awake) {
      set({ awake: false });
      if (engine) engine.setDim(state.card ? DIM : 1);
    }
  });

  var ua = navigator.userAgentData;
  if (ua && ua.getHighEntropyValues) {
    ua.getHighEntropyValues(['architecture'])
      .then(function (v) {
        if (v.architecture === 'arm') state.mac = 'mac-arm';
        else if (v.architecture === 'x86') state.mac = 'mac-intel';
        buildRows();
      })
      .catch(function () {});
  }

  buildRows();
  render();

  engine = window.DTScreen.mount(scr, $('field'), {
    ink: INK,
    accent: ACCENT,
    dim: DIM,
    picture: 'moons',
    dots: 'round',
    phone: state.phone,
    mapUrl: '/landing-logo.json',
  });
  if (engine.reduced) {
    set({ power: true, rails: true, card: true });
  } else {
    setTimeout(function () {
      set({ power: true });
      playStatic(true);
      engine.warmUp();
    }, 280);
    setTimeout(function () {
      set({ rails: true });
    }, 900);
    setTimeout(function () {
      set({ card: true });
    }, 1250);
  }
})();
