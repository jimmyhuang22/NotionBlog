/**
 * Marks on the root whether the last input was the keyboard or a pointer (F34). Focus rings are drawn
 * only outside pointer mode, so a click, a tap, or the focus a browser restores on returning to the tab
 * leaves none, while moving with Tab or the arrow keys shows them. Returning to the tab changes nothing.
 * Without the mark (before any input, or if this never runs) rings show as usual.
 */
export const inputModeScript = `(function(){var d=document.documentElement;addEventListener("keydown",function(e){if(e.key==="Tab"||e.key.indexOf("Arrow")===0)d.dataset.input="keyboard"},true);addEventListener("pointerdown",function(){d.dataset.input="pointer"},true)})();`;
