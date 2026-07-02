/**
 * Full overlay — scorebug + ticker + stingers in a single OBS browser source.
 * The recommended one-source setup (contract §10).
 */
import { h } from '/client/shared/app.js';
import { bootScorebug } from '/client/overlay/scorebug.js';
import { mountStingers } from '/client/overlay/stingers.js';

const stage = document.getElementById('stage');
const stingers = mountStingers(stage.appendChild(h('div', { class: 'fx-layer' })));

bootScorebug({
  onFx(fxList, manual, presentation) {
    const auto = !presentation || presentation.auto !== false;
    if (!manual && !auto) return;
    for (const fx of fxList || []) stingers.play(fx);
  },
});
