// ---------------------------------------------------------------------------
// ui.js -- every screen the player sees (Person 3)
//
// Flow:  map -> briefing -> builder -> launch -> results -> back / next
//
// Talks to the rest of the game only through:
//   SMG.data  -- missions, failures
//   SMG.sim   -- validate / launch
//   SMG.scene -- showPad / playLaunch
//
// No game maths in here. If a number needs calculating, sim.js does it.
// ---------------------------------------------------------------------------

window.SMG = window.SMG || {};

SMG.ui = (function () {
  'use strict';

  var STORAGE_KEY = 'smg.v1.progress';

  // one place for everything the screens need to remember
  var state = {
    screen: null,
    missionIndex: 0,
    build: null,        // { controlA: optionId, controlB: optionId }
    outcome: null,      // what sim.launch gave us
    resultRecorded: false,
    prevBest: 0,
    isNewBest: false,
    progress: { bests: {}, unlocked: 1 }
  };

  // -------------------------------------------------------------------------
  // progress storage
  // every read/write is wrapped -- localStorage can throw (private windows,
  // file:// in some browsers). if it does we just carry on in memory, the
  // game still works, it just forgets after a reload.
  // -------------------------------------------------------------------------

  function defaultProgress() {
    return { bests: {}, unlocked: 1 };
  }

  function loadProgress() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultProgress();
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaultProgress();
      return {
        bests: parsed.bests || {},
        unlocked: parsed.unlocked || 1
      };
    } catch (e) {
      return defaultProgress();
    }
  }

  function saveProgress() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
    } catch (e) {
      // storage is blocked -- state.progress is still the live copy, fine
    }
  }

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  // data comes from files we don't own -- keep anything user-facing escaped
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // "spareFuelBonus" -> "Spare fuel bonus", then whatever we're given
  function prettify(key) {
    var known = {
      base: 'Base score',
      budgetBonus: 'Budget bonus',
      massBonus: 'Mass bonus',
      sparePowerBonus: 'Spare power bonus',
      spareFuelBonus: 'Spare fuel bonus',
      eventPenalty: 'Event penalty',
      control1: 'First choice',
      control2: 'Second choice'
    };
    if (known[key]) return known[key];
    var words = String(key).replace(/([A-Z])/g, ' $1').toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function friendlyNumber(key) {
    var known = {
      thrustKN: 'Push (kN)',
      weightKN: 'Weight (kN)',
      altitudeKm: 'Altitude (km)',
      timeS: 'Time (seconds)',
      fuelLeftPct: 'Fuel left (%)',
      massKg: 'Mass (kg)',
      cost: 'Cost'
    };
    return known[key] || prettify(key);
  }

  function missions() {
    return (SMG.data && SMG.data.missions) || [];
  }

  function mission() {
    return missions()[state.missionIndex];
  }

  function dataReady() {
    return missions().length > 0;
  }

  // scene.js is Person 4's and might not exist yet -- always guard the call
  function callShowPad() {
    if (SMG.scene && typeof SMG.scene.showPad === 'function') {
      try { SMG.scene.showPad(state.build); } catch (e) { /* scene not ready */ }
    }
  }

  function simReady() {
    return SMG.sim && typeof SMG.sim.launch === 'function';
  }

  // swap everything inside #app
  function setScreen(name, html) {
    state.screen = name;
    var app = $('app');
    if (!app) return;
    app.className = 'app screen-' + name;
    app.innerHTML = html;
  }

  // shown whenever data.js hasn't landed yet, instead of a blank page
  function showPlaceholder() {
    setScreen('loading',
      '<div class="screen screen--loading">' +
        '<h1>Space Mission Game</h1>' +
        '<p>Loading mission data&hellip;</p>' +
        '<p class="hint">If this sticks around, data.js hasn\'t been added yet.</p>' +
      '</div>');
  }

  // -------------------------------------------------------------------------
  // campaign map
  // -------------------------------------------------------------------------

  function renderMap() {
    if (!dataReady()) return showPlaceholder();

    var cards = '';
    for (var i = 0; i < missions().length; i++) {
      var m = missions()[i];
      var locked = (i + 1) > state.progress.unlocked;
      var best = state.progress.bests[String(m.id)];

      cards +=
        '<button class="mission-card' + (locked ? ' is-locked' : '') + '"' +
          ' data-index="' + i + '"' +
          (locked ? ' disabled aria-disabled="true"' : '') + '>' +
          '<span class="mission-card__number">Mission ' + esc(m.id) + '</span>' +
          '<span class="mission-card__name">' + esc(m.name) + '</span>' +
          '<span class="mission-card__best">' +
            (locked ? 'Locked' : (best != null ? 'Best: ' + esc(best) : 'Not played yet')) +
          '</span>' +
          (locked ? '<span class="mission-card__lock" aria-label="Locked">&#128274;</span>' : '') +
        '</button>';
    }

    setScreen('map',
      '<div class="screen screen--map">' +
        '<header class="screen__header">' +
          '<h1>Space Mission Game</h1>' +
          '<p class="screen__subtitle">Pick a mission. Land a rocket. Learn why it worked (or didn\'t).</p>' +
        '</header>' +
        '<div class="mission-list">' + cards + '</div>' +
        '<footer class="screen__footer">' +
          '<button class="btn btn--small btn--ghost" id="reset-progress">Reset progress</button>' +
        '</footer>' +
      '</div>');

    // locked cards are disabled buttons and get no handler at all
    var cardEls = document.querySelectorAll('.mission-card:not(.is-locked)');
    for (var c = 0; c < cardEls.length; c++) {
      cardEls[c].addEventListener('click', function () {
        state.missionIndex = parseInt(this.getAttribute('data-index'), 10);
        show('briefing');
      });
    }

    $('reset-progress').addEventListener('click', function () {
      if (window.confirm('Reset all your scores and unlocks?')) {
        state.progress = defaultProgress();
        saveProgress();
        show('map');
      }
    });
  }

  // -------------------------------------------------------------------------
  // briefing
  // -------------------------------------------------------------------------

  function renderBriefing() {
    if (!dataReady()) return showPlaceholder();
    var m = mission();

    // the older contract had target orbit / limits in here -- show them only
    // if they're actually in the data, don't invent numbers
    var extras = '';
    if (m.targetAltitudeKm != null) {
      extras += '<div class="fact-row"><span class="fact-row__label">Target orbit</span>' +
                '<span class="fact-row__value">' + esc(m.targetAltitudeKm) + ' km</span></div>';
    }
    if (m.payloadMassKg != null) {
      extras += '<div class="fact-row"><span class="fact-row__label">Payload</span>' +
                '<span class="fact-row__value">' + esc(m.payloadMassKg) + ' kg</span></div>';
    }
    if (m.assets) {
      if (m.assets.launch) {
        extras += '<div class="fact-row"><span class="fact-row__label">Rocket</span>' +
                  '<span class="fact-row__value">' + esc(m.assets.launch) + '</span></div>';
      }
      if (m.assets.payload) {
        extras += '<div class="fact-row"><span class="fact-row__label">Payload</span>' +
                  '<span class="fact-row__value">' + esc(m.assets.payload) + '</span></div>';
      }
    }

    setScreen('briefing',
      '<div class="screen screen--briefing">' +
        '<header class="screen__header">' +
          '<span class="screen__eyebrow">Mission ' + esc(m.id) + '</span>' +
          '<h1>' + esc(m.name) + '</h1>' +
        '</header>' +
        '<div class="briefing__body">' +
          (m.briefing ? '<p class="briefing__text">' + esc(m.briefing) + '</p>' : '') +
          (m.objective ? '<p class="briefing__objective"><strong>Goal:</strong> ' + esc(m.objective) + '</p>' : '') +
          (extras ? '<div class="briefing__facts">' + extras + '</div>' : '') +
        '</div>' +
        '<div class="briefing__actions">' +
          '<button class="btn btn--primary" id="start-building">Start building</button>' +
          '<button class="btn btn--ghost" id="back-to-map">Back to map</button>' +
        '</div>' +
      '</div>');

    $('start-building').addEventListener('click', startBuild);
    $('back-to-map').addEventListener('click', function () { show('map'); });
  }

  // seed the build with the first option of every control so the kid is
  // never staring at an empty builder
  function startBuild() {
    var m = mission();
    state.build = {};
    if (m.controls) {
      for (var i = 0; i < m.controls.length; i++) {
        var control = m.controls[i];
        state.build[control.id] = control.options[0].id;
      }
    }
    state.outcome = null;
    state.resultRecorded = false;
    show('builder');
    callShowPad();
  }

  // -------------------------------------------------------------------------
  // builder -- two notched choices, a "what you're picking" panel, launch
  // -------------------------------------------------------------------------

  function controlMarkup(control) {
    var options = '';
    for (var i = 0; i < control.options.length; i++) {
      var opt = control.options[i];
      var checked = state.build[control.id] === opt.id ? ' checked' : '';
      options +=
        '<label class="segment">' +
          '<input type="radio" name="ctrl-' + esc(control.id) + '" ' +
                 'value="' + esc(opt.id) + '"' + checked + '>' +
          '<span class="segment__label">' + esc(opt.label) + '</span>' +
        '</label>';
    }
    return '<fieldset class="control">' +
             '<legend class="control__label">' + esc(control.label) + '</legend>' +
             '<div class="segmented" data-control="' + esc(control.id) + '">' + options + '</div>' +
           '</fieldset>';
  }

  // "factors we can control" -- what's chosen and the one-line hint for it
  function factorsMarkup() {
    var m = mission();
    var rows = '';
    for (var i = 0; i < m.controls.length; i++) {
      var control = m.controls[i];
      var chosenId = state.build[control.id];
      var chosen = null;
      for (var j = 0; j < control.options.length; j++) {
        if (control.options[j].id === chosenId) chosen = control.options[j];
      }
      if (!chosen) continue;
      rows +=
        '<div class="factor">' +
          '<div class="factor__choice">' +
            '<span class="factor__name">' + esc(control.label) + '</span>' +
            '<span class="factor__value">' + esc(chosen.label) + '</span>' +
          '</div>' +
          (chosen.hint ? '<p class="factor__hint">' + esc(chosen.hint) + '</p>' : '') +
        '</div>';
    }
    return rows;
  }

  // validate() is advisory now: we never block the launch, we just warn
  function warningsMarkup() {
    if (!SMG.sim || typeof SMG.sim.validate !== 'function') return '';
    var problems;
    try {
      problems = SMG.sim.validate(state.build, mission());
    } catch (e) {
      return '';
    }
    if (!problems || !problems.length) return '';
    var out = '<ul class="warnings" id="warnings">';
    for (var i = 0; i < problems.length; i++) {
      out += '<li class="warnings__item">' + esc(problems[i].message) + '</li>';
    }
    return out + '</ul>';
  }

  function refreshBuilderPanel() {
    var factors = $('factors');
    if (factors) factors.innerHTML = factorsMarkup();
    var warnings = $('warnings-slot');
    if (warnings) warnings.innerHTML = warningsMarkup();
  }

  function renderBuilder() {
    if (!dataReady()) return showPlaceholder();
    var m = mission();

    var controlsHtml = '';
    if (m.controls) {
      for (var i = 0; i < m.controls.length; i++) {
        controlsHtml += controlMarkup(m.controls[i]);
      }
    }

    setScreen('builder',
      '<div class="screen screen--builder">' +
        '<header class="screen__header">' +
          '<span class="screen__eyebrow">Mission ' + esc(m.id) + ' &middot; ' + esc(m.name) + '</span>' +
          '<h1>Build your flight plan</h1>' +
        '</header>' +
        '<div class="builder__controls">' + controlsHtml + '</div>' +
        '<aside class="builder__panel">' +
          '<h2 class="builder__panel-title">What you\'re choosing</h2>' +
          '<div id="factors">' + factorsMarkup() + '</div>' +
          '<div id="warnings-slot">' + warningsMarkup() + '</div>' +
        '</aside>' +
        '<div class="builder__actions">' +
          '<button class="btn btn--primary" id="launch-btn"' + (simReady() ? '' : ' disabled') + '>Launch</button>' +
          '<button class="btn btn--ghost" id="back-to-briefing">Back to briefing</button>' +
          (simReady() ? '' : '<p class="hint">The simulation isn\'t ready yet.</p>') +
        '</div>' +
      '</div>');

    // every change: update the build, refresh the panel, show the pad
    var segments = document.querySelectorAll('.segmented input[type="radio"]');
    for (var s = 0; s < segments.length; s++) {
      segments[s].addEventListener('change', function () {
        state.build[this.name.replace('ctrl-', '')] = this.value;
        refreshBuilderPanel();
        callShowPad();
      });
    }

    $('launch-btn').addEventListener('click', function () {
      if (this.disabled) return;
      show('launch');
    });
    $('back-to-briefing').addEventListener('click', function () { show('briefing'); });

    callShowPad();
  }

  // -------------------------------------------------------------------------
  // launch -- one outcome, one animation, one way to results
  // -------------------------------------------------------------------------

  function renderLaunch() {
    if (!dataReady() || !simReady()) {
      setScreen('launch',
        '<div class="screen screen--error">' +
          '<p>The simulation isn\'t ready yet, so we can\'t launch.</p>' +
          '<button class="btn btn--ghost" id="back-to-builder">Back to builder</button>' +
        '</div>');
      $('back-to-builder').addEventListener('click', function () { show('builder'); });
      return;
    }

    var m = mission();
    state.resultRecorded = false;
    state.outcome = SMG.sim.launch(state.build, m);

    setScreen('launch',
      '<div class="launch-overlay" id="launch-overlay">' +
        '<button class="btn btn--small btn--ghost" id="skip-btn">Skip animation</button>' +
      '</div>');

    // called exactly once, whether the animation ends or the kid skips
    var finished = false;
    function onDone() {
      if (finished) return;
      finished = true;
      recordResult();
      show('results');
    }

    $('skip-btn').addEventListener('click', onDone);

    if (SMG.scene && typeof SMG.scene.playLaunch === 'function') {
      SMG.scene.playLaunch(state.outcome, m, onDone);
    } else {
      onDone();   // no scene.js yet -- go straight to the result
    }
  }

  // bests + unlocks, saved after every single result
  function recordResult() {
    if (state.resultRecorded || !state.outcome) return;
    state.resultRecorded = true;

    var m = mission();
    var score = state.outcome.score || {};
    var total = score.total || 0;
    var key = String(m.id);

    var previousBest = state.progress.bests[key] || 0;
    state.prevBest = previousBest;
    state.isNewBest = total > previousBest;
    if (state.isNewBest) state.progress.bests[key] = total;

    if (score.passed && state.progress.unlocked < m.id + 1) {
      state.progress.unlocked = Math.min(m.id + 1, missions().length);
    }
    saveProgress();
  }

  // -------------------------------------------------------------------------
  // results
  // -------------------------------------------------------------------------

  function renderResults() {
    if (!dataReady()) return showPlaceholder();
    var m = mission();
    var outcome = state.outcome;

    // pressing refresh on this screen would land nowhere sensible
    if (!outcome) { show('map'); return; }

    setScreen('results', outcome.success ? successMarkup(m, outcome) : failureMarkup(m, outcome));
    wireResults(m, outcome);
  }

  function successMarkup(m, outcome) {
    var score = outcome.score || {};
    var total = score.total || 0;
    var parts = score.parts || {};

    var partRows = '';
    for (var key in parts) {
      if (!parts.hasOwnProperty(key)) continue;
      partRows +=
        '<div class="score-row">' +
          '<span class="score-row__label">' + esc(prettify(key)) + '</span>' +
          '<span class="score-row__value">' + esc(parts[key]) + '</span>' +
        '</div>';
    }

    var passed = !!score.passed;
    var shortBy = Math.max(0, (m.passScore || 0) - total);
    var isLast = m.id >= missions().length;

    var nextBtn = '';
    if (passed && isLast) {
      nextBtn = '<button class="btn btn--primary" id="go-end">See final score</button>';
    } else if (passed) {
      nextBtn = '<button class="btn btn--primary" id="go-next">Next mission</button>';
    } else {
      nextBtn = '<button class="btn btn--primary" id="go-retry">Try again</button>';
    }

    return '' +
      '<div class="screen screen--results screen--success">' +
        '<header class="screen__header">' +
          '<span class="screen__eyebrow">Mission ' + esc(m.id) + '</span>' +
          '<h1>' + (passed ? 'You did it!' : 'So close!') + '</h1>' +
        '</header>' +
        '<div class="results__score">' +
          '<span class="results__total">' + esc(total) + '</span>' +
          '<span class="results__max">/ ' + esc(m.maxScore != null ? m.maxScore : 100) + '</span>' +
          (state.isNewBest ? '<span class="badge badge--new-best">New personal best!</span>' : '') +
          '<span class="results__best">Personal best: ' + esc(Math.max(total, state.prevBest)) + '</span>' +
        '</div>' +
        (partRows ? '<div class="results__breakdown">' + partRows + '</div>' : '') +
        (!passed && shortBy > 0
          ? '<p class="results__short">You need ' + esc(shortBy) + ' more point' + (shortBy === 1 ? '' : 's') +
            ' to pass (you need ' + esc(m.passScore) + ').</p>'
          : '') +
        (m.fact ? '<p class="results__fact"><strong>Fact:</strong> ' + esc(m.fact) + '</p>' : '') +
        '<div class="results__actions">' +
          nextBtn +
          '<button class="btn btn--ghost" id="go-retry-build">Tweak the plan</button>' +
          '<button class="btn btn--ghost" id="go-map">Back to map</button>' +
        '</div>' +
      '</div>';
  }

  function failureMarkup(m, outcome) {
    var failure = outcome.failure || {};
    var info = (SMG.data && SMG.data.failures && SMG.data.failures[failure.type]) || {};

    var title = info.title || 'The mission failed';
    var story = info.story || '';

    // numbers: { thrustKN: 40, weightKN: 52 } -> readable lines for kids
    var numberLines = '';
    if (failure.numbers) {
      for (var key in failure.numbers) {
        if (!failure.numbers.hasOwnProperty(key)) continue;
        numberLines +=
          '<div class="score-row">' +
            '<span class="score-row__label">' + esc(friendlyNumber(key)) + '</span>' +
            '<span class="score-row__value">' + esc(failure.numbers[key]) + '</span>' +
          '</div>';
      }
    }

    // where it happened -- altitude and/or stage, whichever we were given
    var where = '';
    if (failure.altitudeKm != null && failure.altitudeKm > 0) {
      where = 'It went wrong at ' + esc(failure.altitudeKm) + ' km up.';
    } else if (failure.stage != null) {
      where = 'It went wrong during stage ' + esc(failure.stage) + '.';
    } else {
      where = 'It went wrong right after launch.';
    }

    var fact = info.fact || m.fact || '';

    return '' +
      '<div class="screen screen--results screen--failure">' +
        '<header class="screen__header">' +
          '<span class="screen__eyebrow">Mission ' + esc(m.id) + '</span>' +
          '<h1>' + esc(title) + '</h1>' +
        '</header>' +
        (story ? '<p class="results__story">' + esc(story) + '</p>' : '') +
        (numberLines ? '<div class="results__numbers">' + numberLines + '</div>' : '') +
        '<p class="results__where">' + where + '</p>' +
        (info.fix ? '<p class="results__fix"><strong>Try this:</strong> ' + esc(info.fix) + '</p>' : '') +
        (fact ? '<p class="results__fact"><strong>Fact:</strong> ' + esc(fact) + '</p>' : '') +
        '<div class="results__actions">' +
          '<button class="btn btn--primary" id="go-retry">Try again</button>' +
          '<button class="btn btn--ghost" id="go-retry-build">Tweak the plan</button>' +
          '<button class="btn btn--ghost" id="go-map">Back to map</button>' +
        '</div>' +
      '</div>';
  }

  function wireResults(m, outcome) {
    var retry = $('go-retry');
    if (retry) {
      // retry keeps the previous build -- the kid tweaks, not restarts
      retry.addEventListener('click', function () { show('builder'); });
    }

    var tweak = $('go-retry-build');
    if (tweak) {
      tweak.addEventListener('click', function () { show('builder'); });
    }

    var next = $('go-next');
    if (next) {
      next.addEventListener('click', function () {
        state.missionIndex = Math.min(state.missionIndex + 1, missions().length - 1);
        show('briefing');
      });
    }

    var end = $('go-end');
    if (end) end.addEventListener('click', function () { show('end'); });

    var map = $('go-map');
    if (map) map.addEventListener('click', function () { show('map'); });
  }

  // -------------------------------------------------------------------------
  // end screen -- all five bests added up
  // -------------------------------------------------------------------------

  function renderEnd() {
    if (!dataReady()) return showPlaceholder();

    var total = 0;
    var rows = '';
    for (var i = 0; i < missions().length; i++) {
      var m = missions()[i];
      var best = state.progress.bests[String(m.id)] || 0;
      total += best;
      rows +=
        '<div class="score-row">' +
          '<span class="score-row__label">' + esc(m.id) + '. ' + esc(m.name) + '</span>' +
          '<span class="score-row__value">' + esc(best) + '</span>' +
        '</div>';
    }

    setScreen('end',
      '<div class="screen screen--end">' +
        '<header class="screen__header">' +
          '<h1>You\'ve completed every mission!</h1>' +
          '<p class="screen__subtitle">All five scores together: ' + esc(total) + '</p>' +
        '</header>' +
        '<div class="results__breakdown">' + rows + '</div>' +
        '<div class="results__actions">' +
          '<button class="btn btn--primary" id="go-map">Back to map</button>' +
          '<button class="btn btn--small btn--ghost" id="reset-progress">Reset progress</button>' +
        '</div>' +
      '</div>');

    $('go-map').addEventListener('click', function () { show('map'); });
    $('reset-progress').addEventListener('click', function () {
      if (window.confirm('Reset all your scores and unlocks?')) {
        state.progress = defaultProgress();
        saveProgress();
        show('map');
      }
    });
  }

  // -------------------------------------------------------------------------
  // screen manager
  // -------------------------------------------------------------------------

  var SCREENS = {
    map: renderMap,
    briefing: renderBriefing,
    builder: renderBuilder,
    launch: renderLaunch,
    results: renderResults,
    end: renderEnd
  };

  function show(screenName) {
    var render = SCREENS[screenName];
    if (!render) throw new Error('Unknown screen: ' + screenName);
    render();
  }

  // called from index.html once every script has loaded
  function start() {
    state.progress = loadProgress();
    show('map');
  }

  return { start: start, show: show, state: state };
})();
