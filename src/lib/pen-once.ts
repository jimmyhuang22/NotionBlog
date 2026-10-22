/**
 * The pen stroke under the owner's name draws itself once per visit (X-06, 2026-10-20): later home pages
 * in the same browser session show it already drawn. Runs before paint, beside the theme script.
 */
export const penScript = `try{if(sessionStorage.getItem("pen-drawn"))document.documentElement.dataset.pen="drawn"}catch(e){}`;
