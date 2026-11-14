// ---------------------------------------------------------------------------
// ui.js -- every screen the player sees (Person 3)
//
// Talks to the rest of the game only through:
//   SMG.data  -- missions, rockets, components, failures
//   SMG.sim   -- computeStats / validate / launch
//   SMG.scene -- init / showPad / playLaunch
// No game maths in here, just display.
// ---------------------------------------------------------------------------

window.SMG = window.SMG || {};

SMG.ui = (function () {
  'use strict';

  // Until data.js lands this is all we can show. Keeps the shell from
  // exploding while the other files are still empty.
  function renderPlaceholder() {
    var app = document.getElementById('app');
    if (!app) return;

    app.innerHTML =
      '<div class="screen screen--loading">' +
        '<h1>Space Mission Game</h1>' +
        '<p>Loading mission data&hellip;</p>' +
        '<p class="hint">If this sticks around, data.js or sim.js hasn\'t been added yet.</p>' +
      '</div>';
  }

  // called from index.html once the scripts are loaded
  function start() {
    renderPlaceholder();
  }

  return { start: start };
})();
